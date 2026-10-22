import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Patient } from "../models/Patient.ts";
import { Doctor } from "../models/Doctor.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import { PHARMACY_ROLE_PRESETS } from "../utilities/pharmacyPermissions.ts";
import { dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";

async function principal(role: string, organizationId?: string, locationIds?: string[]) {
  const user = await User.create({ name: "Capability staff", email: `${crypto.randomUUID()}@example.test`, role });
  if (organizationId && !["root", "patient", "family_member", "guest"].includes(role)) await OrgMember.create({
    organizationId, userId: user.id, role, ...(locationIds ? { locationAccess: { mode: "selected", locationIds } } : {}),
  });
  const session = await createAuthSession({ id: user.id, email: user.email!, role, organization_id: organizationId });
  return { user, headers: { authorization: `Bearer ${session.accessToken}` } };
}
async function fixture(permissions: string[] = ["PHARMACY_VIEW_STOCK"]) {
  const organizationId = (await Organization.create({ name: "Capability organization", city: "Pune", countryCode: "IN", currency: "INR", maxLocations: 10 })).id;
  const locationId = (await Location.create({ organizationId, name: "Existing clinic", city: "Pune", facilityType: "clinic" })).id;
  const role = await Role.create({ organizationId, name: `cap_${crypto.randomUUID()}`, permissions });
  const staff = await principal(role.name, organizationId, [locationId]);
  const admin = await principal("admin", organizationId);
  const medicine = await Medicine.create({ locationId, name: "Capability stock", genericName: "Test", stockQuantity: 10,
    costPrice: 5, price: 10, batchNumber: "OPENING", expiryDate: new Date("2099-12-31") });
  const batch = await MedicineBatch.create({ medicineId: medicine.id, locationId, batchNumber: "EXISTING", quantity: 10,
    purchaseCost: 5, sellingPrice: 10, expiryDate: new Date("2099-12-31") });
  return { organizationId, locationId, role, staff, admin, medicine, batch };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const capability = (f: Fixture, auth: Record<string, string> = f.staff.headers, locationId = f.locationId) => app.inject({ method: "GET", url: `/api/pharmacy/locations/${locationId}/capabilities`, headers: auth });
const settings = (f: Fixture, enabled: boolean, expectedRevision: number, auth = f.admin.headers) => app.inject({ method: "PATCH", url: `/api/pharmacy/locations/${f.locationId}/settings`, headers: auth,
  payload: { enabled, expectedRevision, reviewReference: "Synthetic local test review" } });
const inward = (f: Fixture, auth = f.staff.headers) => app.inject({ method: "POST", url: "/api/pharmacy/batches", headers: auth,
  payload: { unlinkedInwardReason: "Synthetic unlinked inward", medicineId: f.medicine.id, locationId: f.locationId, batchNumber: crypto.randomUUID(), quantity: 2, purchaseCost: 4, sellingPrice: 10, expiryDate: "2099-12-31" } });
const stock = (f: Fixture) => app.inject({ method: "GET", url: `/api/medicines?locationId=${f.locationId}`, headers: f.staff.headers });
async function prescription(f: Fixture) {
  const doctor = await principal("doctor", f.organizationId, [f.locationId]);
  const patient = await Patient.create({ organizationId: f.organizationId, name: "Capability patient", phone: "9000000000" });
  const encounter = await Encounter.create({ organizationId: f.organizationId, locationId: f.locationId, patientId: patient.id, doctorId: doctor.user.id, status: "completed" });
  const rx = await Prescription.create({ organizationId: f.organizationId, locationId: f.locationId, patientId: patient.id, doctorId: doctor.user.id,
    encounterId: encounter.id, medicineId: f.medicine.id, medicineName: f.medicine.name, dosage: "1 tablet", frequency: "Daily", duration: "2 days" });
  await PrescriptionSealingService.sealPrescription(rx.id, doctor.user.id);
  await ClinicalNote.create({ organizationId: f.organizationId, locationId: f.locationId, patientId: patient.id, doctorId: doctor.user.id,
    encounterId: encounter.id, subjective: { chiefComplaint: "Synthetic capability fixture" }, status: "signed", plan: { prescriptionIds: [rx.id] },
    signature: { signerId: doctor.user.id, signerName: doctor.user.name, signedAt: new Date() } });
  await pharmacyTaxFixture(f.locationId, [f.medicine.id], f.admin.user.id);
  return { patient, body: { locationId: f.locationId, patientId: patient.id, encounterId: encounter.id, doctorId: doctor.user.id,
    prescriptionIds: [rx.id], items: [{ medicineId: f.medicine.id, quantity: 2 }] } };
}

beforeAll(async () => { await app.ready(); await Promise.all([StockMovement.init(), OperationReceipt.init()]); });
describe("Location pharmacy capability and granular authority", () => {
  it("preserves included legacy access and returns only current independent action grants", async () => {
    const f = await fixture();
    const response = await capability(f);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().data).toMatchObject({ enabled: true, revision: 0, mode: "legacy_included", commercialEntitlement: "plan_included", counterSalesAvailable: false,
      actions: { viewStock: true, viewCost: false, viewRxQueue: false, receiveStock: false, dispense: false, manageSettings: false } });
    expect((await Location.findById(f.locationId))!.pharmacyCapability).toBeUndefined();
  });
  it("hides acquisition costs on every stock read and denies the queue and unrelated writes", async () => {
    const f = await fixture();
    for (const url of [`/api/medicines?locationId=${f.locationId}`, `/api/pharmacy/medicines/${f.medicine.id}/batches`, `/api/pharmacy/expiring?locationId=${f.locationId}&days=36500`]) {
      const response = await app.inject({ method: "GET", url, headers: f.staff.headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0]).not.toHaveProperty("costPrice"); expect(response.json().data[0]).not.toHaveProperty("purchaseCost");
    }
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${f.locationId}`, headers: f.staff.headers })).statusCode).toBe(403);
    expect((await inward(f)).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/medicines/${f.medicine.id}`, headers: f.staff.headers, payload: { name: "Forbidden" } })).statusCode).toBe(403);
  });
  it("grants cost viewing separately without granting any stock mutation", async () => {
    const f = await fixture(["PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_COST"]);
    expect((await stock(f)).json().data[0].costPrice).toBe(5);
    const response = await app.inject({ method: "GET", url: `/api/pharmacy/medicines/${f.medicine.id}/batches`, headers: f.staff.headers });
    expect(response.json().data[0].purchaseCost).toBe(5);
    expect((await inward(f)).statusCode).toBe(403);
  });
  it("allows catalogue metadata changes without exposing or changing protected cost fields", async () => {
    const f = await fixture(["PHARMACY_MANAGE_CATALOG"]);
    const update = (payload: object) => app.inject({ method: "PUT", url: `/api/medicines/${f.medicine.id}`, headers: f.staff.headers, payload });
    const edited = await update({ name: "Renamed stock" });
    expect(edited.statusCode, edited.body).toBe(200); expect(edited.json().data).not.toHaveProperty("costPrice");
    expect((await update({ costPrice: 1 })).statusCode).toBe(403);
    expect((await inward(f)).statusCode).toBe(403);
    expect((await Medicine.findById(f.medicine.id))!.costPrice).toBe(5);
  });
  it("allows inward stock with its own input cost while redacting stored costs", async () => {
    const f = await fixture(["PHARMACY_RECEIVE_STOCK"]);
    const result = await inward(f);
    expect(result.statusCode, result.body).toBe(201); expect(result.json().data).not.toHaveProperty("purchaseCost");
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(12);
    expect((await stock(f)).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/medicines/${f.medicine.id}`, headers: f.staff.headers, payload: { price: 2 } })).statusCode).toBe(403);
  });
  it("allows a dispensing role without EHR access to read finalized prescriptions and supply them", async () => {
    const preset = PHARMACY_ROLE_PRESETS.find(role => role.name === "pharmacy_pharmacist")!;
    const f = await fixture(preset.permissions);
    const rx = await prescription(f);
    expect(preset.permissions).not.toContain("VIEW_EHR");
    const queue = await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${f.locationId}`, headers: f.staff.headers });
    expect(queue.statusCode, queue.body).toBe(200); expect(queue.json().data[0].patientId.id).toBe(rx.patient.id);
    const supplied = await app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: { ...f.staff.headers, "idempotency-key": crypto.randomUUID() }, payload: rx.body });
    expect(supplied.statusCode, supplied.body).toBe(201);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    expect((await inward(f)).statusCode).toBe(403);
  });
  it("reads templates without seeding or overwriting roles and creates a cashier through the existing role API", async () => {
    const f = await fixture();
    const empty = await Role.create({ name: "pharmacy_cashier", organizationId: f.organizationId, permissions: [] });
    const before = await Role.countDocuments();
    const response = await app.inject({ method: "GET", url: "/api/pharmacy/role-presets", headers: f.admin.headers });
    expect(response.statusCode, response.body).toBe(200); expect(await Role.countDocuments()).toBe(before);
    expect((await Role.findById(empty.id))!.permissions).toEqual([]);
    const cashier = response.json().data.find((role: { name: string }) => role.name === "pharmacy_cashier");
    expect(cashier.permissions).toEqual(expect.arrayContaining(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_CLOSE_TILL"]));
    for (const code of ["VIEW_EHR", "VIEW_PATIENTS", "MANAGE_BILLING", "PHARMACY_VIEW_RX_QUEUE", "PHARMACY_VIEW_COST"]) expect(cashier.permissions).not.toContain(code);
    const created = await app.inject({ method: "POST", url: "/api/roles", headers: f.admin.headers, payload: { name: "Branch cashier", permissions: cashier.permissions } });
    expect(created.statusCode, created.body).toBe(201);
    // The fixture already has an administrator and a stock reader; retain production quota checks.
    await Organization.updateOne({ _id: f.organizationId }, { $set: { maxStaff: 5 } });
    const added = await app.inject({ method: "POST", url: "/api/onboarding/staff", headers: f.admin.headers,
      payload: { name: "Branch cashier", email: `${crypto.randomUUID()}@example.test`, password: "SyntheticTestPassword42!", role: "branch_cashier" } });
    expect(added.statusCode, added.body).toBe(201);
    const cashierId = added.json().data.id;
    const granted = await app.inject({ method: "PATCH", url: `/api/organizations/${f.organizationId}/members/${cashierId}/location-access`, headers: f.admin.headers,
      payload: { mode: "selected", locationIds: [f.locationId], expectedRevision: 0 } });
    expect(granted.statusCode, granted.body).toBe(200);
    const session = await createAuthSession({ id: cashierId, email: added.json().data.email, role: "branch_cashier", organization_id: f.organizationId });
    const caps = await capability(f, { authorization: `Bearer ${session.accessToken}` });
    expect(caps.statusCode, caps.body).toBe(200);
    expect(caps.json().data.actions).toMatchObject({ viewStock: true, viewRxQueue: false, viewCost: false, manageCatalog: false, dispense: false });
    expect(await Doctor.countDocuments({ userId: cashierId })).toBe(0);
    expect(await Patient.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("immediately honors explicit empty roles and live grant revocation", async () => {
    const f = await fixture(["PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_COST"]);
    expect((await stock(f)).statusCode).toBe(200);
    await Role.updateOne({ _id: f.role.id }, { $set: { permissions: [] } });
    expect((await stock(f)).statusCode).toBe(403);
    expect(Object.values((await capability(f)).json().data.actions).every(value => value === false)).toBe(true);
  });
  it("requires current branch and organization authority for settings and capability reads", async () => {
    const f = await fixture(["PHARMACY_MANAGE_SETTINGS"]);
    const sibling = await Location.create({ organizationId: f.organizationId, name: "Sibling", city: "Pune" });
    expect((await capability(f, f.staff.headers, sibling.id)).statusCode).toBe(404);
    const foreign = await fixture();
    expect((await capability(f, f.staff.headers, foreign.locationId)).statusCode).toBe(404);
    const membership = await OrgMember.findOne({ userId: f.staff.user.id, organizationId: f.organizationId });
    await OrgMember.updateOne({ _id: membership!._id }, { $set: { locationAccess: { mode: "selected", locationIds: [] } } });
    expect((await capability(f)).statusCode).toBe(404);
  });
  it.each(["patient", "family_member", "guest"])("denies %s even with all pharmacy grants", async role => {
    const f = await fixture();
    await Role.create({ name: role, organizationId: f.organizationId, permissions: ["VIEW_EHR", ...PHARMACY_ROLE_PRESETS[0].permissions] });
    const consumer = await principal(role, f.organizationId);
    expect((await capability(f, consumer.headers)).statusCode).toBe(403);
    expect((await settings(f, false, 0, consumer.headers)).statusCode).toBe(403);
  });
  it("enables an existing clinic in place only after reviewed issuer evidence and uses revision checks", async () => {
    const f = await fixture(["PHARMACY_MANAGE_SETTINGS"]);
    const before = await Location.countDocuments({ organizationId: f.organizationId });
    expect((await settings(f, true, 0, f.staff.headers)).statusCode).toBe(409);
    expect((await Location.findById(f.locationId))!.pharmacyCapability).toBeUndefined();
    await pharmacyTaxFixture(f.locationId, [], f.admin.user.id);
    const enabled = await settings(f, true, 0, f.staff.headers);
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().data).toMatchObject({ locationId: f.locationId, revision: 1, enabled: true, mode: "configured" });
    expect((await Location.findById(f.locationId))!.facilityType).toBe("clinic");
    expect(await Location.countDocuments({ organizationId: f.organizationId })).toBe(before);
    expect(await ModuleRegistry.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect((await settings(f, false, 0)).statusCode).toBe(409);
    expect(await AuditLog.countDocuments({ targetId: f.locationId, action: "PHARMACY_CAPABILITY_REVIEWED" })).toBe(1);
    const list = await app.inject({ method: "GET", url: "/api/onboarding/locations", headers: f.admin.headers });
    expect(list.json().data[0].pharmacyCapability).toEqual({ enabled: true, revision: 1 });
    const edited = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${f.locationId}`, headers: f.admin.headers, payload: { name: "Existing clinic", city: "Pune" } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().data.pharmacyCapability).toEqual({ enabled: true, revision: 1 });
    const reviewed = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${f.locationId}/settings`, headers: f.staff.headers });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json().data.review.reviewReference).toBe("Synthetic local test review");
  });
  it("keeps configuration available while the organization master switch blocks operational access", async () => {
    const f = await fixture(["PHARMACY_VIEW_STOCK", "PHARMACY_MANAGE_SETTINGS"]);
    await ModuleRegistry.create({ organizationId: f.organizationId, moduleKey: "pharmacy", enabled: false, priority: "P1", label: "Pharmacy" });
    expect((await capability(f)).json().data).toMatchObject({ moduleEnabled: false, actions: { viewStock: false, manageSettings: true } });
    expect((await stock(f)).statusCode).toBe(403);
    expect((await settings(f, false, 0, f.staff.headers)).statusCode).toBe(200);
    expect((await ModuleRegistry.findOne({ organizationId: f.organizationId, moduleKey: "pharmacy" }))!.enabled).toBe(false);
  });
  it("blocks new stock writes and queues after disable, retaining authorized stock and committed recovery", async () => {
    const f = await fixture(["MANAGE_MEDICINES"]);
    const rx = await prescription(f), key = crypto.randomUUID();
    const supply = () => app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: { ...f.staff.headers, "idempotency-key": key }, payload: rx.body });
    const first = await supply(); expect(first.statusCode, first.body).toBe(201);
    expect((await settings(f, false, 0)).statusCode).toBe(200);
    expect((await inward(f)).statusCode).toBe(409);
    expect((await stock(f)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${f.locationId}`, headers: f.staff.headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/api/medicines/${f.medicine.id}`, headers: f.staff.headers, payload: { name: "Blocked" } })).statusCode).toBe(409);
    const replay = await supply(); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data).toEqual(first.json().data);
    const recovered = await app.inject({ method: "GET", url: `/api/pharmacy/dispense-operations/${key}?locationId=${f.locationId}`, headers: f.staff.headers });
    expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().data).toEqual(first.json().data);
    const blocked = await app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: { ...f.staff.headers, "idempotency-key": crypto.randomUUID() }, payload: rx.body });
    expect(blocked.statusCode, blocked.body).toBe(409); expect(await Invoice.countDocuments({ patientId: rx.patient.id })).toBe(1);
  });
  it("preserves adjustment replay after disabling and denies new adjustment commands", async () => {
    const f = await fixture(["PHARMACY_ADJUST_STOCK"]);
    const input = { medicineId: f.medicine.id, batchId: f.batch.id, expectedQuantity: 10, expectedRevision: 0, newQuantity: 8, reason: "physical_audit", clientRequestId: crypto.randomUUID() };
    const adjust = (payload: object) => app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers: f.staff.headers, payload });
    const first = await adjust(input); expect(first.statusCode, first.body).toBe(200);
    expect((await settings(f, false, 0)).statusCode).toBe(200);
    expect((await adjust(input)).statusCode).toBe(200);
    expect((await adjust({ ...input, clientRequestId: crypto.randomUUID(), expectedQuantity: 8, expectedRevision: 1, newQuantity: 7 })).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });
  it("rolls back settings if the required audit fails", async () => {
    const f = await fixture();
    const spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit failure"));
    try { expect((await settings(f, false, 0)).statusCode).toBe(500); }
    finally { spy.mockRestore(); }
    expect((await Location.findById(f.locationId))!.pharmacyCapability).toBeUndefined();
  });
  it("keeps the capability pin inside an explicitly supplied inventory transaction", async () => {
    const f = await fixture();
    const before = (await Location.findById(f.locationId))!.__v;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await dispenseMedicineFEFO(f.medicine.id, f.locationId, 2, session);
      await session.abortTransaction();
    } finally { await session.endSession(); }
    expect((await Location.findById(f.locationId))!.__v).toBe(before);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  });
  it("serializes concurrent settings reviews and inward stock against disable", async () => {
    const f = await fixture(["PHARMACY_RECEIVE_STOCK"]);
    const results = await Promise.all([settings(f, false, 0), settings(f, false, 0), inward(f)]);
    expect(results.slice(0, 2).map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect([201, 409]).toContain(results[2].statusCode);
    const accepted = results[2].statusCode === 201;
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(accepted ? 12 : 10);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(accepted ? 2 : 1);
    expect((await inward(f)).statusCode).toBe(409);
  });
  it("creates a pharmacy facility disabled without requiring a doctor or granting commercial rights", async () => {
    const f = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/onboarding/locations", headers: f.admin.headers, payload: { name: "Independent pharmacy", city: "Pune", facilityType: "pharmacy" } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ facilityType: "pharmacy", pharmacyCapability: { enabled: false, revision: 0 } });
    expect(await ModuleRegistry.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("rolls back inward stock when a disable commits after its catalogue reads", async () => {
    const f = await fixture(["PHARMACY_RECEIVE_STOCK"]);
    const find = MedicineBatch.findOne.bind(MedicineBatch);
    let disabled = false;
    const spy = vi.spyOn(MedicineBatch, "findOne").mockImplementation(((...args: unknown[]) => {
      const query = Reflect.apply(find, MedicineBatch, args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        const result = await execute();
        if (!disabled && String((args[0] as { medicineId?: unknown })?.medicineId) === f.medicine.id) {
          disabled = true;
          const response = await (mongoose as unknown as { transactionAsyncLocalStorage: { run: (store: undefined, callback: () => ReturnType<typeof settings>) => ReturnType<typeof settings> } }).transactionAsyncLocalStorage.run(undefined, () => settings(f, false, 0));
          expect(response.statusCode, response.body).toBe(200);
        }
        return result;
      };
      return query;
    }) as typeof MedicineBatch.findOne);
    try { const response = await inward(f); expect(response.statusCode, response.body).toBe(409); }
    finally { spy.mockRestore(); }
    expect(disabled).toBe(true);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(1);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  });
  it("retains root access while keeping a root acting with a staff role subject to tenant grants", async () => {
    const f = await fixture();
    const root = await principal("root");
    expect((await capability(f, root.headers)).json().data.actions.viewStock).toBe(true);
    const foreign = await fixture();
    const acting = await app.inject({ method: "POST", url: "/api/auth/impersonate", headers: root.headers, payload: { userId: f.staff.user.id, organizationId: f.organizationId } });
    expect(acting.statusCode, acting.body).toBe(200);
    const token = acting.cookies.find(cookie => cookie.name === "access_token")!.value;
    const auth = { cookie: `access_token=${token}` };
    const own = await capability(f, auth);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data).toMatchObject({ rootOverride: false, actions: { viewStock: true, manageSettings: false, viewCost: false } });
    expect((await capability(f, auth, foreign.locationId)).statusCode).toBe(404);
  });
});
