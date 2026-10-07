import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { Prescription } from "../models/Prescription.ts";
import { Observation } from "../models/Observation.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { recordAuditLog, verifyAuditChainIntegrity } from "../services/AuditTrailService.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { generateAccessToken, createRefreshTokenDetails } from "../utilities/helpers.ts";
import { resolveSession } from "../utilities/sessionResolver.ts";
import { timelineWindow } from "../services/providers/timelineWindow.ts";

describe("Architecture integrity against a transaction-capable database", () => {
  let organization: any, location: any, root: any, patient: any, encounter: any;
  let headers: Record<string, string>;
  beforeAll(async () => {
    expect((mongoose.connection as any).client.topology.description.type).not.toBe("Single");
    await Promise.all([AuditLog.init(), OperationReceipt.init(), Invoice.init()]);
    organization = await Organization.create({ name: "Integrity regression", city: "Mumbai", countryCode: "IN", plan: "enterprise" });
    location = await Location.create({ organizationId: organization._id, name: "Integrity clinic", city: "Mumbai" });
    root = await User.create({ name: "Platform fixture", email: `integrity-${Date.now()}@test.invalid`, password: "test-only-password", role: "root" });
    patient = await Patient.create({ name: "Clinical fixture", organizationId: organization._id });
    encounter = await Encounter.create({ organizationId: organization._id, locationId: location._id, patientId: patient._id, doctorId: root._id });
    headers = { authorization: `Bearer ${(await fixtureAccessToken({ id: String(root._id), role: "root", email: root.email }))}` };
  });

  it("reconciles repeated drafts, rejects stale revisions and seals only current prescriptions", async () => {
    const payload = { encounterId: String(encounter._id), locationId: String(location._id), patientId: String(patient._id), chiefComplaint: "Follow-up", vitals: { pulseRate: 70 }, prescriptions: [{ name: "Old medicine", dosage: "1 tablet", frequency: "Daily", duration: "3 days" }] };
    const first = await app.inject({ method: "POST", url: "/api/clinical-notes", headers, payload });
    expect(first.statusCode, first.body).toBe(200);
    const oldRx = first.json().data.plan.prescriptionIds[0];
    const observation = first.json().data.objective.observationIds[0];
    const changed = { ...payload, expectedRevision: first.json().data.revision, vitals: { pulseRate: 75 }, prescriptions: [{ name: "Current medicine", dosage: "1 tablet", frequency: "Daily", duration: "3 days" }] };
    const second = await app.inject({ method: "POST", url: "/api/clinical-notes", headers, payload: changed });
    expect(second.statusCode, second.body).toBe(200);
    expect(String(second.json().data.objective.observationIds[0])).toBe(String(observation));
    expect(await Observation.countDocuments({ encounterId: encounter._id, deletedAt: null })).toBe(1);
    expect((await Prescription.findById(oldRx))?.status).toBe("superseded");
    const stale = await app.inject({ method: "POST", url: "/api/clinical-notes", headers, payload: changed });
    expect(stale.statusCode).toBe(409);
    const signed = await app.inject({ method: "PUT", url: `/api/clinical-notes/${second.json().data.id}/sign`, headers });
    expect(signed.statusCode, signed.body).toBe(200);
    expect((await Prescription.findById(oldRx))?.isSealed).toBe(false);
    expect((await Prescription.findById(second.json().data.plan.prescriptionIds[0]))?.isSealed).toBe(true);
  });

  it("serializes concurrent installments, replays once and rejects key reuse", async () => {
    const invoice = await Invoice.create({ invoiceNumber: "INV-INTEGRITY-1", organizationId: organization._id, locationId: location._id, doctorId: root._id, patientId: patient._id, items: [], subtotal: 100, totalAmount: 100, balanceDue: 100 });
    const pay = (key: string, amount: number) => app.inject({ method: "POST", url: `/api/invoices/${invoice.id}/payments`, headers: { ...headers, "idempotency-key": key }, payload: { amount, paymentMethod: "cash" } });
    const results = await Promise.all([pay("integrity-payment-one", 20), pay("integrity-payment-two", 30)]);
    expect(results.map(response => response.statusCode)).toEqual([200, 200]);
    expect((await pay("integrity-payment-one", 20)).statusCode).toBe(200);
    expect((await pay("integrity-payment-one", 21)).statusCode).toBe(409);
    const saved = await Invoice.findById(invoice.id);
    expect(saved.amountPaid).toBe(50);
    expect(saved.payments).toHaveLength(2);
    expect((await pay("integrity-overpayment", 60)).statusCode).toBe(400);
    expect(await OperationReceipt.countDocuments({ key: "integrity-overpayment" })).toBe(0);
  });

  it("rolls back business and audit writes together and serializes concurrent chain appends", async () => {
    const appointment = await Appointment.create({ organizationId: organization._id, locationId: location._id, patientId: patient._id, doctorId: root._id, appointmentTime: new Date(), appointmentType: "walk-in", status: "completed", tokenNumber: 1 });
    const payload = { appointmentId: appointment.id, paymentMethod: "cash", customConsultationFee: 100, amountPaid: 100 };
    const checkout = (key: string) => app.inject({ method: "POST", url: "/api/billing/checkout/consolidate", headers: { ...headers, "idempotency-key": key }, payload });
    const responses = await Promise.all([checkout("integrity-checkout-one"), checkout("integrity-checkout-one")]);
    expect(responses.map(response => response.statusCode), responses.map(response => response.body).join("\n")).toEqual([200, 200]);
    const invoices = await Invoice.find({ appointmentId: appointment._id });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].payments).toHaveLength(1);
    expect((await checkout("integrity-checkout-two")).statusCode).toBe(409);
    const before = await AuditLog.countDocuments({ organizationId: organization._id });
    await expect(withTransaction(async () => { await Patient.updateOne({ _id: patient._id }, { $set: { name: "Must roll back" } }); await recordAuditLog({ organizationId: organization._id, action: "ROLLBACK_PROBE" }); throw new Error("injected failure"); })).rejects.toThrow("injected failure");
    expect((await Patient.findById(patient._id)).name).toBe("Clinical fixture");
    expect(await AuditLog.countDocuments({ organizationId: organization._id })).toBe(before);
    await Promise.all(Array.from({ length: 12 }, (_, i) => recordAuditLog({ organizationId: organization._id, action: `CONCURRENT_${i}` })));
    expect(await verifyAuditChainIntegrity(String(organization._id))).toMatchObject({ intact: true });
  });

  it("bounds timeline reads and advances ties without missing records", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    await Appointment.create(Array.from({ length: 7 }, (_, i) => ({ organizationId: organization._id, locationId: location._id, patientId: patient._id, doctorId: root._id, appointmentTime: at, appointmentType: "walk-in" as const, status: "completed" as const, tokenNumber: i + 10 })));
    const filter = { patientId: patient._id, organizationId: organization._id, appointmentTime: at };
    const query = { patientId: String(patient._id), organizationId: String(organization._id), userId: String(root._id), limit: 2 };
    const first = await (await timelineWindow(Appointment, filter, query, ["appointmentTime"])).query.lean();
    expect(first).toHaveLength(3);
    first.sort((a: any, b: any) => String(b._id).localeCompare(String(a._id)));
    const cursor = Buffer.from(`${at.toISOString()}__${first[1]._id}`).toString("base64");
    const second = await (await timelineWindow(Appointment, filter, { ...query, cursor }, ["appointmentTime"])).query.lean();
    expect(second).toHaveLength(3);
    expect(second.some((item: any) => first.slice(0, 2).some((prior: any) => String(prior._id) === String(item._id)))).toBe(false);
  });

  it("denies tenant prompt administration and archives without deleting patient history", async () => {
    const admin = await User.create({ name: "Tenant admin", email: `tenant-integrity-${Date.now()}@test.invalid`, password: "test-only-password", role: "admin" });
    const tenantHeaders = { authorization: `Bearer ${(await fixtureAccessToken({ id: String(admin._id), role: "admin", email: admin.email!, organization_id: String(organization._id) }))}` };
    expect((await app.inject({ method: "GET", url: "/api/ai/prompts", headers: tenantHeaders })).statusCode).toBe(403);
    const session = await createRefreshTokenDetails(String(admin._id), { organizationId: String(organization._id) });
    expect((await resolveSession(session.sessionId)).valid).toBe(true);
    const archived = await app.inject({ method: "DELETE", url: `/api/organizations/${organization._id}`, headers });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().data.archived).toBe(true);
    expect(await Patient.exists({ _id: patient._id })).toBeTruthy();
    expect(await Encounter.exists({ _id: encounter._id })).toBeTruthy();
    expect((await resolveSession(session.sessionId)).valid).toBe(false);
  });
});
