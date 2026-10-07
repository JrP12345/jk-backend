import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { updateAppointmentStatus, getAppointments, rescheduleAppointment } from "../controllers/appointment.ts";
import { signClinicalNoteController } from "../controllers/clinicalNote.ts";
import { processSelfCheckInQr } from "../controllers/checkIn.ts";
import { callNextPatient } from "../controllers/queue.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";

let replica: MongoMemoryReplSet;
beforeAll(async () => {
  await mongoose.disconnect();
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all(Object.values(mongoose.models).map(model => model.createCollection()));
  await Appointment.syncIndexes();
});
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
afterEach(() => vi.restoreAllMocks());

function response() {
  return { code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis() } as any;
}
async function visit(status: "in-consultation" | "cancelled" | "confirmed" | "pending_payment" = "in-consultation") {
  const organizationId = new mongoose.Types.ObjectId();
  const location = await Location.create({ organizationId, name: "Recovery clinic", city: "Pune" });
  const doctor = await User.create({ name: "Recovery doctor", role: "doctor" });
  const patient = await Patient.create({ name: "Recovery patient", phone: "9876543210", organizationId });
  const appointment = await Appointment.create({ organizationId, locationId: location._id, doctorId: doctor._id,
    patientId: patient._id, appointmentTime: new Date(), appointmentType: "walk-in", status, tokenNumber: 1 });
  const encounter = await Encounter.create({ organizationId, locationId: location._id, doctorId: doctor._id,
    patientId: patient._id, appointmentId: appointment._id, status: "in_progress" });
  const request = { user: { id: doctor.id, role: "root", organization_id: organizationId.toString() },
    params: { id: appointment.id }, body: {}, query: {}, log: { error: vi.fn() } } as any;
  return { appointment, encounter, patient, location, doctor, organizationId, request };
}

describe("Clinic workflow recovery with real MongoDB transactions", () => {
  it("rolls back visit, encounter and prescriptions after a required note write fails; retry commits once", async () => {
    const v = await visit();
    v.request.body = { status: "completed", symptoms: "Cough", diagnosis: "URI", dispatchWhatsAppRx: false,
      prescriptions: [{ name: "Paracetamol", dosage: "As directed" }] };
    vi.spyOn(ClinicalNote, "create").mockRejectedValueOnce(new Error("Injected note write failure"));
    const failed = response();
    await updateAppointmentStatus(v.request, failed);
    expect(failed.code).toHaveBeenCalledWith(500);
    expect((await Appointment.findById(v.appointment._id))?.status).toBe("in-consultation");
    expect((await Encounter.findById(v.encounter._id))?.status).toBe("in_progress");
    expect(await Prescription.countDocuments({ encounterId: v.encounter._id })).toBe(0);
    const retry = response();
    await updateAppointmentStatus(v.request, retry);
    expect(retry.code).toHaveBeenCalledWith(200);
    expect(await Prescription.countDocuments({ encounterId: v.encounter._id })).toBe(1);
    const repeat = response();
    await updateAppointmentStatus(v.request, repeat);
    expect(repeat.code).toHaveBeenCalledWith(200);
    expect(await Prescription.countDocuments({ encounterId: v.encounter._id })).toBe(1);
  });

  it("rejects signing a stale draft linked to a cancelled visit without signing or completing its encounter", async () => {
    const v = await visit("cancelled");
    const note = await ClinicalNote.create({ organizationId: v.organizationId, locationId: v.location._id,
      encounterId: v.encounter._id, patientId: v.patient._id, doctorId: v.doctor._id,
      subjective: { chiefComplaint: "Review" }, status: "draft" });
    v.request.params.id = note.id;
    const reply = response();
    await signClinicalNoteController(v.request, reply);
    expect(reply.code).toHaveBeenCalledWith(409);
    expect((await ClinicalNote.findById(note._id))?.status).toBe("draft");
    expect((await Encounter.findById(v.encounter._id))?.status).toBe("in_progress");
    expect((await Appointment.findById(v.appointment._id))?.status).toBe("cancelled");
  });

  it("allows first sealing with diagnosis and prevents later unsealing or medical edits", async () => {
    const v = await visit();
    const rx = await Prescription.create({ organizationId: v.organizationId, locationId: v.location._id,
      encounterId: v.encounter._id, patientId: v.patient._id, doctorId: v.doctor._id,
      medicineName: "Paracetamol", dosage: "As directed", frequency: "As directed", duration: "3 days" });
    const sealed = await PrescriptionSealingService.sealPrescription(rx.id, v.doctor.id, { diagnosisCode: "J06.9", diagnosisDescription: "URI" });
    expect(sealed.isSealed).toBe(true);
    expect(sealed.diagnosisCode).toBe("J06.9");
    sealed.isSealed = false;
    await expect(sealed.save()).rejects.toThrow(/cannot be unsealed/);
    const reloaded = await Prescription.findById(rx._id);
    reloaded!.dosage = "Changed";
    await expect(reloaded!.save()).rejects.toThrow(/immutable/);
  });

  it("reconciles repeated signing without applying a second signature or audit", async () => {
    const v = await visit();
    const note = await ClinicalNote.create({ organizationId: v.organizationId, locationId: v.location._id,
      encounterId: v.encounter._id, patientId: v.patient._id, doctorId: v.doctor._id,
      subjective: { chiefComplaint: "Review" }, status: "draft" });
    v.request.params.id = note.id;
    const first = response(); await signClinicalNoteController(v.request, first);
    expect(first.code).toHaveBeenCalledWith(200);
    const repeat = response(); await signClinicalNoteController(v.request, repeat);
    expect(repeat.code).toHaveBeenCalledWith(200);
    expect(await AuditLog.countDocuments({ targetId: note._id, action: "CLINICAL_NOTE_SIGNED" })).toBe(1);
  });

  it("keeps first and repeat kiosk results consistent and refuses pending payment", async () => {
    const v = await visit("confirmed");
    v.request.body = { appointmentId: v.appointment.id, locationId: v.location.id, tokenNumber: 1 };
    const first = response();
    await processSelfCheckInQr(v.request, first);
    expect(first.code).toHaveBeenCalledWith(200);
    const repeat = response();
    await processSelfCheckInQr(v.request, repeat);
    expect(repeat.code).toHaveBeenCalledWith(200);
    const firstData = first.send.mock.calls[0][0].data;
    const repeatData = repeat.send.mock.calls[0][0].data;
    expect(Object.keys(repeatData)).toEqual(Object.keys(firstData));
    expect(repeatData.tokenNumber).toBe(1);
    expect(repeatData.alreadyCheckedIn).toBe(true);
    await Appointment.updateOne({ _id: v.appointment._id }, { status: "pending_payment" });
    const unpaid = response();
    await processSelfCheckInQr(v.request, unpaid);
    expect(unpaid.code).toHaveBeenCalledWith(409);
  });

  it("does not close the current visit before an unarrived next patient is explicitly confirmed", async () => {
    const v = await visit();
    await Appointment.create({ organizationId: v.organizationId, locationId: v.location._id, doctorId: v.doctor._id,
      patientId: v.patient._id, appointmentTime: new Date(), appointmentType: "walk-in", status: "confirmed", tokenNumber: 2 });
    v.request.body = { locationId: v.location.id, doctorId: v.doctor.id, completePrevious: true, requireArrivalConfirmation: true };
    const reply = response();
    await callNextPatient(v.request, reply);
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send.mock.calls[0][0].details).toBe("ARRIVAL_CONFIRMATION_REQUIRED");
    expect((await Appointment.findById(v.appointment._id))?.status).toBe("in-consultation");
    v.request.body.confirmedAppointmentId = reply.send.mock.calls[0][0].data.id;
    const confirmed = response();
    await callNextPatient(v.request, confirmed);
    expect(confirmed.code).toHaveBeenCalledWith(200);
    expect((await Appointment.findById(v.appointment._id))?.status).toBe("completed");
  });

  it("rolls back explicit previous completion when claiming the next visit fails to save its audit", async () => {
    const v = await visit();
    const next = await Appointment.create({ organizationId: v.organizationId, locationId: v.location._id, doctorId: v.doctor._id,
      patientId: v.patient._id, appointmentTime: new Date(), appointmentType: "walk-in", status: "checked-in", tokenNumber: 2 });
    v.request.body = { locationId: v.location.id, doctorId: v.doctor.id, completePrevious: true };
    vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Injected audit failure"));
    const reply = response();
    await callNextPatient(v.request, reply);
    expect(reply.code).toHaveBeenCalledWith(500);
    expect((await Appointment.findById(v.appointment._id))?.status).toBe("in-consultation");
    expect((await Appointment.findById(next._id))?.status).toBe("checked-in");
  });

  it("searches the complete authorized list and returns totals beyond the first page", async () => {
    const v = await visit("confirmed");
    const common = { organizationId: v.organizationId, locationId: v.location._id, doctorId: v.doctor._id,
      patientId: v.patient._id, appointmentTime: new Date(), appointmentType: "walk-in", status: "confirmed" };
    await Appointment.insertMany(Array.from({ length: 55 }, (_, i) => ({ ...common, tokenNumber: i + 2 })));
    v.request.query = { locationId: v.location.id, page: "2", limit: "50", search: "Recovery patient" };
    const reply = response();
    await getAppointments(v.request, reply);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith("X-Total-Count", "56");
    expect(reply.send.mock.calls[0][0].data).toHaveLength(6);
  });

  it("preserves payment gating on a reschedule and refuses a holiday without moving the visit", async () => {
    const v = await visit("pending_payment");
    await Appointment.updateOne({ _id: v.appointment._id }, { paymentStatus: "pending", paymentRequired: true });
    await DoctorAssignment.create({ organizationId: v.organizationId, locationId: v.location._id,
      doctorId: v.doctor._id, workingHours: "{}", paymentRequired: true });
    const target = new Date(); target.setDate(target.getDate() + 2); target.setHours(12, 0, 0, 0);
    v.request.body = { newTime: target.toISOString() };
    const reply = response();
    await rescheduleAppointment(v.request, reply);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect((await Appointment.findById(v.appointment._id))?.status).toBe("pending_payment");
    target.setDate(target.getDate() + 1);
    await DoctorDayOverride.create({ locationId: v.location._id, doctorId: v.doctor._id,
      date: `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`, status: "unavailable" });
    v.request.body = { newTime: target.toISOString() };
    const denied = response();
    await rescheduleAppointment(v.request, denied);
    expect(denied.code).toHaveBeenCalledWith(400);
    expect((await Appointment.findById(v.appointment._id))?.appointmentTime.toISOString()).not.toBe(target.toISOString());
  });
});
