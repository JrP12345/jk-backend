import crypto from "node:crypto";
import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Location } from "../models/Location.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Inquiry } from "../models/Inquiry.ts";
import { Patient } from "../models/Patient.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import * as notifications from "../utilities/notifications.ts";
import * as slotLocks from "../services/SlotLockService.ts";
import * as communication from "../services/CommunicationOutbox.ts";
import { eventBus } from "../events/eventBus.ts";

async function fixture(paymentRequired = false) {
  const org = await Organization.create({ name: "Conversion clinic", city: "Pune", plan: "enterprise", countryCode: "IN", currency: "INR" });
  const location = await Location.create({ organizationId: org.id, name: "Conversion branch", city: "Pune", timezone: "Asia/Kolkata" });
  const admin = await User.create({ name: "Conversion owner", email: `${crypto.randomUUID()}@example.test`, role: "admin" });
  const doctor = await User.create({ name: "Booking doctor", email: `${crypto.randomUUID()}@example.test`, role: "doctor" });
  await OrgMember.create([{ userId: admin.id, organizationId: org.id, role: "admin" }, { userId: doctor.id, organizationId: org.id, role: "doctor" }]);
  await DoctorAssignment.create({ organizationId: org.id, locationId: location.id, doctorId: doctor.id, workingHours: JSON.stringify({ all: { start: "00:00", end: "23:59" } }), fees: 350, bookingMode: "sequential_queue", paymentRequired });
  const session = await createAuthSession({ id: admin.id, email: admin.email!, role: "admin", organization_id: org.id }, { organizationId: org.id, workspaceRole: "admin" });
  const cookies = { access_token: session.accessToken };
  const inquiry = await Inquiry.create({ organizationId: org.id, locationId: location.id, callerName: "Caller", ownerId: admin.id, createdBy: admin.id, nextAction: { kind: "book", dueAt: new Date() } });
  const phone = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const payload = { expectedRevision: 0, clientRequestId: crypto.randomUUID(), doctorId: doctor.id, appointmentTime: new Date(Date.now() + 86400000).toISOString(),
    identityVerified: true, patientDetails: { name: "Minimum booking patient", phone } };
  const convert = (extra: object = {}) => app.inject({ method: "POST", url: `/api/crm/inquiries/${inquiry.id}/convert`, cookies, payload: { ...payload, ...extra } });
  return { org, location, admin, doctor, inquiry, phone, payload, convert };
}
afterEach(() => vi.restoreAllMocks());
describe("Atomic canonical inquiry conversion", () => {
  it("checks canonical slot locks before writing and rolls minimum registration back when a lock is missing", async () => {
    const f = await fixture();
    await DoctorAssignment.updateOne({ organizationId: f.org.id, doctorId: f.doctor.id }, { bookingMode: "time_slot" });
    const lock = vi.spyOn(slotLocks, "validateSlotLockForBooking").mockResolvedValue({ valid: false, lockKey: "test-lock", message: "Slot reservation expired" });
    expect((await f.convert()).statusCode).toBe(409);
    expect(lock).toHaveBeenCalledWith(f.location.id, f.doctor.id, f.payload.appointmentTime, f.admin.id, undefined);
    expect(await Patient.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: f.payload.clientRequestId })).toBe(0);
  });
  it("keeps pending-payment notification copy truthful and returns only administrative booking details", async () => {
    const f = await fixture(true);
    vi.spyOn(notifications, "sendBookingNotification").mockResolvedValue();
    const response = await f.convert();
    const id = response.json().data.appointment.id;
    vi.restoreAllMocks();
    const email = vi.spyOn(communication, "enqueueTransactionalEmail").mockResolvedValue({} as any);
    vi.spyOn(eventBus, "publishDurable").mockResolvedValue({} as any);
    await Patient.updateOne({ organizationId: f.org.id }, { email: "caller@example.test" });
    await notifications.sendBookingNotification(id, "booked");
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining("awaiting payment"), text: expect.stringContaining("Payment is still required before confirmation.") }));
    const session = await createAuthSession({ id: f.admin.id, email: f.admin.email!, role: "admin", organization_id: f.org.id }, { organizationId: f.org.id, workspaceRole: "admin" });
    const summary = await app.inject({ method: "GET", url: `/api/appointments/${id}?view=administrative`, cookies: { access_token: session.accessToken } });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().data).toMatchObject({ id, status: "pending_payment", paymentStatus: "pending" });
    expect(summary.json().data).not.toHaveProperty("patientId");
    expect(summary.json().data).not.toHaveProperty("notes");
  });
  it("creates one minimum patient, booking and invoice with one committed communication intent across concurrent retries", async () => {
    const f = await fixture();
    const notice = vi.spyOn(notifications, "sendBookingNotification").mockImplementation(async id => {
      expect(await Appointment.exists({ _id: id, organizationId: f.org.id })).toBeTruthy();
      expect((await Inquiry.findById(f.inquiry.id))?.status).toBe("converted");
    });
    const pair = await Promise.all([f.convert(), f.convert()]);
    expect(pair.map(row => row.statusCode).sort()).toEqual([200, 201]);
    const booking = pair[0].json().data.appointment;
    expect(pair[1].json().data.appointment.id).toBe(booking.id);
    expect(booking).toMatchObject({ status: "confirmed", paymentStatus: "not_required" });
    expect(await f.convert()).toMatchObject({ statusCode: 200 });
    expect(await Patient.countDocuments({ organizationId: f.org.id })).toBe(1);
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
    expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
    expect(await User.countDocuments({ phone: f.phone })).toBe(0);
    expect(notice).not.toHaveBeenCalled();
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id, eventType: 'crm.appointment.communication', status: 'pending' })).toBe(1);
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id, eventType: "crm.inquiry.converted" })).toBe(1);
    const patient = await Patient.findById(booking.patientId);
    expect(patient?.dob).toBeUndefined(); expect(patient?.userId).toBeUndefined();
  });
  it("preserves payment pending and canonical pay-at-location rules without reporting confirmation", async () => {
    const f = await fixture(true);
    vi.spyOn(notifications, "sendBookingNotification").mockResolvedValue();
    const response = await f.convert({ payAtLocation: true });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data.appointment).toMatchObject({ status: "pending_payment", paymentStatus: "pending", paymentAmount: 350 });
    expect(response.json().message).toContain("payment remains pending");
    expect((await Invoice.findOne({ organizationId: f.org.id }))?.status).toBe("unpaid");
  });
  it("rolls back registration, booking, invoice, event and receipts when conversion linkage fails", async () => {
    const f = await fixture(), notice = vi.spyOn(notifications, "sendBookingNotification").mockResolvedValue();
    const failure = vi.spyOn(Inquiry, "updateOne").mockRejectedValueOnce(new Error("Link write unavailable"));
    try { expect((await f.convert()).statusCode).toBe(503); } finally { failure.mockRestore(); }
    expect(await Patient.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await PatientRelationship.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: f.payload.clientRequestId })).toBe(0);
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect((await Inquiry.findById(f.inquiry.id))?.status).toBe("open");
    expect(notice).not.toHaveBeenCalled();
    expect((await f.convert()).statusCode).toBe(201);
  });
  it("serializes different conversion commands and preserves the first booking link", async () => {
    const f = await fixture(); vi.spyOn(notifications, "sendBookingNotification").mockResolvedValue();
    const pair = await Promise.all([f.convert(), f.convert({ clientRequestId: crypto.randomUUID() })]);
    expect(pair.map(row => row.statusCode).sort()).toEqual([201, 409]);
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
    const firstId = pair.find(row => row.statusCode === 201)!.json().data.appointment.id;
    expect(String((await Inquiry.findById(f.inquiry.id))?.appointmentId)).toBe(firstId);
  });
  it("requires verified identity and rejects unrelated patients without creating bookings", async () => {
    const f = await fixture();
    expect((await f.convert({ identityVerified: false })).statusCode).toBe(400);
    const unrelated = await Patient.create({ name: "Foreign patient", organizationId: new mongoose.Types.ObjectId() });
    const { patientDetails: _new, ...payload } = f.payload;
    const response = await app.inject({ method: "POST", url: `/api/crm/inquiries/${f.inquiry.id}/convert`, cookies: { access_token: (await createAuthSession({ id: f.admin.id, email: f.admin.email!, role: "admin", organization_id: f.org.id }, { organizationId: f.org.id, workspaceRole: "admin" })).accessToken },
      payload: { ...payload, patientId: unrelated.id } });
    expect(response.statusCode, response.body).toBe(404);
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
  });
});
