import { beforeAll, describe, expect, it, vi } from "vitest";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createRefreshTokenDetails, generateAccessToken } from "../utilities/helpers.ts";
import { clinicDateKey, clinicDayRange } from "../utilities/clinicTime.ts";

async function session(user: any, organizationId: string) {
  const { rawToken, sessionId } = await createRefreshTokenDetails(user.id, { organizationId });
  const access = generateAccessToken({ id: user.id, email: user.email || "", role: user.role, organization_id: organizationId, sessionId });
  return { cookie: `access_token=${access}; refresh_token=${rawToken}` };
}

describe("Existing clinic workflow with opt-in experience preferences", () => {
  let org: any, clinic: any, doctor: any, otherDoctor: any;
  let adminHeaders: { cookie: string }, doctorHeaders: { cookie: string }, receptionHeaders: { cookie: string };
  let sequence = 0;
  beforeAll(async () => {
    org = await Organization.create({ name: "Workflow clinic", city: "Surat", countryCode: "IN", currency: "INR", plan: "enterprise" });
    clinic = await Clinic.create({ organizationId: org.id, name: "Workflow location", city: "Surat", timezone: "Asia/Kolkata" });
    const admin = await User.create({ name: "Workflow owner", email: "workflow-owner@test.com", role: "admin" });
    doctor = await User.create({ name: "Workflow doctor", email: "workflow-doctor@test.com", role: "doctor" });
    otherDoctor = await User.create({ name: "Second doctor", email: "workflow-doctor-two@test.com", role: "doctor" });
    const receptionist = await User.create({ name: "Workflow receptionist", email: "workflow-desk@test.com", role: "receptionist" });
    await OrgMember.create([admin, doctor, otherDoctor, receptionist].map(user => ({ userId: user.id, organizationId: org.id, role: user.role })));
    await DoctorAssignment.create([doctor, otherDoctor].map(user => ({ doctorId: user.id, clinicId: clinic.id, organizationId: org.id, isActive: user.id === doctor.id, fees: 350, workingHours: JSON.stringify({ all: { start: "00:00", end: "23:59" } }), bookingMode: "sequential_queue" as const })));
    adminHeaders = await session(admin, org.id); doctorHeaders = await session(doctor, org.id); receptionHeaders = await session(receptionist, org.id);
    await Appointment.init();
  });
  async function preferences(value: Record<string, string>) {
    const response = await app.inject({ method: "PUT", url: "/api/onboarding/organization/me", headers: adminHeaders, payload: { workflowPreferences: value } });
    expect(response.statusCode, response.body).toBe(200);
  }
  async function patient() {
    sequence++;
    const response = await app.inject({ method: "POST", url: "/api/patients", headers: receptionHeaders, payload: { name: `Workflow patient ${sequence}`, phone: `988770${String(sequence).padStart(4, "0")}` } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().data;
  }
  async function book(patientId: string, appointmentType = "walk-in", assignedDoctor = doctor.id) {
    const response = await app.inject({ method: "POST", url: "/api/appointments", headers: receptionHeaders, payload: { patientId, clinicId: clinic.id, doctorId: assignedDoctor, appointmentTime: new Date().toISOString(), appointmentType } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().data;
  }
  async function start(id: string, headers = doctorHeaders) {
    for (const status of ["checked-in", "in-consultation"]) {
      const response = await app.inject({ method: "PUT", url: `/api/appointments/${id}/status`, headers, payload: { status } });
      expect(response.statusCode, response.body).toBe(200);
    }
  }
  async function complete(id: string, extra = {}, headers = doctorHeaders) {
    return app.inject({ method: "PUT", url: `/api/appointments/${id}/status`, headers, payload: { status: "completed", documentationMode: "optional", dispatchWhatsAppRx: false, ...extra } });
  }

  it("retains full defaults, merges individual preferences, scopes reads and denies receptionist settings writes", async () => {
    const original = await app.inject({ method: "GET", url: "/api/onboarding/organization/preferences", headers: doctorHeaders });
    expect(original.json().data).toMatchObject({ registration: "full", consultation: "full", currency: "INR" });
    expect(original.body).not.toContain("whatsappConfig");
    await preferences({ registration: "essential" });
    expect((await Organization.findById(org.id))?.workflowPreferences).toMatchObject({ registration: "essential", consultation: "full" });
    const forbidden = await app.inject({ method: "PUT", url: "/api/onboarding/organization/me", headers: receptionHeaders, payload: { workflowPreferences: { consultation: "focused" } } });
    expect(forbidden.statusCode).toBe(403);
    const crossTenant = await app.inject({ method: "GET", url: `/api/onboarding/organization/preferences?organizationId=${clinic.id}`, headers: doctorHeaders });
    expect(crossTenant.statusCode).toBe(403);
  });

  it("requires opt-in before no-note completion and preserves the active visit", async () => {
    const visit = await book((await patient()).id); await start(visit.id);
    expect((await complete(visit.id)).statusCode).toBe(409);
    expect((await Appointment.findById(visit.id))?.status).toBe("in-consultation");
    await preferences({ consultation: "focused" });
    expect((await complete(visit.id)).statusCode).toBe(200);
  });

  it("registers a real minimum patient, completes without invented data, collects an existing invoice and reports the day", async () => {
    const registered = await patient();
    expect(registered.dob).toBeUndefined(); expect(registered.gender).toBeUndefined(); expect(registered.userId).toBeUndefined();
    const visit = await book(registered.id); await start(visit.id);
    const completed = await complete(visit.id);
    expect(completed.statusCode, completed.body).toBe(200);
    const encounter = await Encounter.findOne({ appointmentId: visit.id });
    expect(encounter?.status).toBe("completed"); expect(encounter?.endedAt).toBeTruthy(); expect(String(encounter?.doctorId)).toBe(doctor.id);
    expect(await ClinicalNote.countDocuments({ encounterId: encounter?.id })).toBe(0);
    expect(await Prescription.countDocuments({ encounterId: encounter?.id })).toBe(0);
    expect((await Appointment.findById(visit.id))?.activeConsultationDoctorDayKey).toBeUndefined();
    expect(await AuditLog.exists({ targetId: visit.id, organizationId: org.id, action: "CONSULTATION_COMPLETED_WITHOUT_CLINICAL_NOTE" })).toBeTruthy();
    expect((await complete(visit.id)).statusCode).toBe(200);
    expect(await Encounter.countDocuments({ appointmentId: visit.id })).toBe(1);
    const invoice = await Invoice.findOne({ appointmentId: visit.id }); expect(invoice).toBeTruthy();
    const paid = await app.inject({ method: "POST", url: `/api/invoices/${invoice!.id}/payments`, headers: receptionHeaders, payload: { amount: invoice!.totalAmount, paymentMethod: "cash" } });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await Appointment.findById(visit.id))?.paymentStatus).toBe("paid");
    const listed = await app.inject({ method: "GET", url: `/api/invoices?appointmentId=${visit.id}&clinicId=${clinic.id}`, headers: receptionHeaders });
    expect(listed.json().data).toHaveLength(1); expect(listed.json().data[0].status).toBe("paid");
    const range = clinicDayRange(clinicDateKey(new Date(), "Asia/Kolkata"), "Asia/Kolkata");
    const summary = await app.inject({ method: "GET", url: `/api/analytics/daily-summary?${new URLSearchParams({ clinicId: clinic.id, startDate: range.start.toISOString(), endDate: range.end.toISOString() })}`, headers: receptionHeaders });
    expect(summary.statusCode).toBe(200); expect(summary.json().data.completed).toBeGreaterThanOrEqual(2);
    expect(summary.json().data.moneyByCurrency).toContainEqual(expect.objectContaining({ currency: "INR", collections: 350 }));
    const timeline = await app.inject({ method: "GET", url: `/api/patients/${registered.id}/timeline`, headers: doctorHeaders });
    expect(timeline.statusCode, timeline.body).toBe(200); expect(timeline.body).toContain(visit.id);
  });

  it("keeps quick notes and explicit medicines in canonical history with CDS and prescription sealing", async () => {
    const returning = await patient();
    await Appointment.create({ organizationId: org.id, clinicId: clinic.id, doctorId: doctor.id, patientId: returning.id, appointmentTime: new Date(Date.now() - 32 * 86400000), appointmentType: "walk-in", tokenNumber: 1, status: "completed", notes: "Previous recorded visit" });
    const visit = await book(returning.id); await start(visit.id);
    const response = await complete(visit.id, { notes: "Patient requested a short visit record", prescriptions: [{ name: "Paracetamol", dosage: "500 mg", frequency: "As needed, up to twice daily", duration: "2 days", instructions: "Recorded test instruction" }] });
    expect(response.statusCode, response.body).toBe(200);
    const encounter = await Encounter.findOne({ appointmentId: visit.id });
    const prescription = await Prescription.findOne({ encounterId: encounter!.id });
    expect(prescription).toMatchObject({ dosage: "500 mg", duration: "2 days", isSealed: true, instructions: "Recorded test instruction" });
    const printed = await app.inject({ method: "GET", url: `/api/encounters/${encounter!.id}/prescription/print`, headers: doctorHeaders });
    expect(printed.statusCode, printed.body).toBe(200);
    expect(printed.body).toContain(returning.name);
    expect(printed.body).toContain("Paracetamol");
    expect(printed.body).toContain("Recorded test instruction");
    expect(await ClinicalNote.countDocuments({ encounterId: encounter!.id })).toBe(0);
    const timeline = await app.inject({ method: "GET", url: `/api/patients/${returning.id}/timeline`, headers: doctorHeaders });
    expect(timeline.body).toContain("Patient requested a short visit record");
    const retry = await complete(visit.id); expect(retry.statusCode).toBe(200);
    expect(await Prescription.countDocuments({ encounterId: encounter!.id })).toBe(1);
  });

  it("protects saved full SOAP work, its required complaint and the signing lifecycle", async () => {
    const registered = await patient(); const visit = await book(registered.id); await start(visit.id);
    const encounter = await Encounter.findOne({ appointmentId: visit.id });
    const invalid = await app.inject({ method: "POST", url: "/api/clinical-notes", headers: doctorHeaders, payload: { encounterId: encounter!.id, patientId: registered.id } });
    expect(invalid.statusCode).toBe(400);
    const saved = await app.inject({ method: "POST", url: "/api/clinical-notes", headers: doctorHeaders, payload: { encounterId: encounter!.id, patientId: registered.id, clinicId: clinic.id, chiefComplaint: "Recorded full complaint", historyOfPresentIllness: "Recorded full history", physicalExamination: "Recorded examination", treatmentPlan: "Recorded plan", vitals: { pulseRate: 70, bpSystolic: 120, bpDiastolic: 80 }, diagnoses: [{ code: "CUSTOM", description: "Recorded diagnosis" }], prescriptions: [{ name: "Recorded medicine", dosage: "Recorded dose", frequency: "Once daily", duration: "2 days" }] } });
    expect(saved.statusCode, saved.body).toBe(200);
    const history = await app.inject({ method: "GET", url: `/api/patients/${registered.id}/clinical-notes/history?encounterId=${encounter!.id}`, headers: doctorHeaders });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).toContain(saved.json().data.id);
    expect(history.body).toContain("120/80"); expect(history.body).toContain("Recorded diagnosis");
    expect(history.body).toContain("Recorded medicine"); expect(history.body).toContain("Once daily");
    const unrelatedHistory = await app.inject({ method: "GET", url: `/api/patients/${registered.id}/clinical-notes/history?encounterId=${clinic.id}`, headers: doctorHeaders });
    expect(unrelatedHistory.json().data).toEqual([]);
    expect((await complete(visit.id)).statusCode).toBe(409);
    expect((await Appointment.findById(visit.id))?.status).toBe("in-consultation");
    const sign = await app.inject({ method: "PUT", url: `/api/clinical-notes/${saved.json().data.id}/sign`, headers: doctorHeaders });
    expect(sign.statusCode, sign.body).toBe(200); expect((await Appointment.findById(visit.id))?.status).toBe("completed");
    const reopened = await app.inject({ method: "POST", url: "/api/encounters", headers: doctorHeaders, payload: { appointmentId: visit.id, patientId: registered.id, clinicId: clinic.id } });
    expect(reopened.json().data.id).toBe(encounter!.id); expect(await Encounter.countDocuments({ appointmentId: visit.id })).toBe(1);
    const closedDraft = await app.inject({ method: "POST", url: "/api/clinical-notes", headers: doctorHeaders, payload: { encounterId: encounter!.id, patientId: registered.id, chiefComplaint: "Should not append" } });
    expect(closedDraft.statusCode).toBe(409);
  });

  it("keeps phone bookings on the existing source and Call Next lifecycle", async () => {
    const visit = await book((await patient()).id, "reception");
    expect((await Appointment.findById(visit.id))?.appointmentType).toBe("reception");
    const unarrived = await app.inject({ method: "POST", url: "/api/queue/call-next", headers: doctorHeaders, payload: { clinicId: clinic.id, doctorId: doctor.id, requireArrivalConfirmation: true } });
    expect(unarrived.statusCode).toBe(409); expect(unarrived.json().details).toBe("ARRIVAL_CONFIRMATION_REQUIRED");
    const next = await app.inject({ method: "POST", url: "/api/queue/call-next", headers: doctorHeaders, payload: { clinicId: clinic.id, doctorId: doctor.id, requireArrivalConfirmation: true, confirmedAppointmentId: visit.id } });
    expect(next.statusCode, next.body).toBe(200); expect(next.json().data.status).toBe("in-consultation");
    expect((await complete(visit.id)).statusCode).toBe(200);
  });

  it("blocks receptionist completion and missing dosing, and retains independent multi-doctor visits", async () => {
    await DoctorAssignment.updateOne({ doctorId: otherDoctor.id, clinicId: clinic.id }, { isActive: true });
    const first = await book((await patient()).id); await start(first.id);
    expect((await complete(first.id, {}, receptionHeaders)).statusCode).toBe(403);
    const invalidRx = await complete(first.id, { prescriptions: [{ name: "Medicine", dosage: "Dose", duration: "Duration" }] });
    expect(invalidRx.statusCode).toBe(400); expect((await Appointment.findById(first.id))?.status).toBe("in-consultation");
    const second = await book((await patient()).id, "walk-in", otherDoctor.id); await start(second.id, adminHeaders);
    expect((await complete(second.id)).statusCode).toBe(403);
    const duplicate = await book((await patient()).id);
    const arrived = await app.inject({ method: "PUT", url: `/api/appointments/${duplicate.id}/status`, headers: receptionHeaders, payload: { status: "checked-in" } }); expect(arrived.statusCode).toBe(200);
    const conflict = await app.inject({ method: "PUT", url: `/api/appointments/${duplicate.id}/status`, headers: doctorHeaders, payload: { status: "in-consultation" } }); expect(conflict.statusCode).toBe(409);
    expect((await complete(first.id)).statusCode).toBe(200); expect((await complete(second.id, {}, adminHeaders)).statusCode).toBe(200);
    await start(duplicate.id); expect((await complete(duplicate.id)).statusCode).toBe(200);
  });

  it("keeps public online booking in the same daily list and consultation lifecycle", async () => {
    const guest = await app.inject({ method: "POST", url: "/api/public/booking-session", payload: { name: "Online workflow patient", phone: "9876001122" } });
    expect(guest.statusCode).toBe(200);
    const cookie = (guest.headers["set-cookie"] as string[]).map(value => value.split(";")[0]).join("; ");
    const booked = await app.inject({ method: "POST", url: "/api/appointments", headers: { cookie }, payload: { clinicId: clinic.id, doctorId: doctor.id, appointmentTime: new Date(Date.now() + 60000).toISOString(), appointmentType: "online" } });
    expect(booked.statusCode, booked.body).toBe(201);
    const visit = booked.json().data;
    const list = await app.inject({ method: "GET", url: `/api/appointments?clinicId=${clinic.id}&search=9876001122`, headers: receptionHeaders });
    expect(list.json().data.some((value: any) => value.id === visit.id)).toBe(true);
    await start(visit.id); expect((await complete(visit.id)).statusCode).toBe(200);
    const encounter = await Encounter.findOne({ appointmentId: visit.id }); expect(encounter?.encounterType).toBe("telehealth");
    expect(await ClinicalNote.countDocuments({ encounterId: encounter!.id })).toBe(0);
  });

  it("captures post-consultation fees once and counter replay does not create another invoice", async () => {
    await DoctorAssignment.updateOne({ doctorId: otherDoctor.id, clinicId: clinic.id }, { feeType: "post_consultation", fees: 220 });
    const visit = await book((await patient()).id, "walk-in", otherDoctor.id); await start(visit.id, adminHeaders);
    expect(await Invoice.countDocuments({ appointmentId: visit.id })).toBe(0);
    const done = await complete(visit.id, {}, adminHeaders); expect(done.statusCode, done.body).toBe(200);
    const encounter = await Encounter.findOne({ appointmentId: visit.id });
    const invoice = await Invoice.findOne({ encounterId: encounter!.id }); expect(invoice?.totalAmount).toBe(220);
    const paid = await app.inject({ method: "POST", url: `/api/invoices/${invoice!.id}/payments`, headers: receptionHeaders, payload: { amount: 220, paymentMethod: "cash" } });
    expect(paid.statusCode, paid.body).toBe(200); expect((await Appointment.findById(visit.id))?.paymentStatus).toBe("paid");
    const replay = await app.inject({ method: "POST", url: "/api/appointment-payments/collect-counter", headers: receptionHeaders, payload: { appointmentId: visit.id, paymentMethod: "cash" } });
    expect(replay.statusCode, replay.body).toBe(409);
    expect(await Invoice.countDocuments({ $or: [{ appointmentId: visit.id }, { encounterId: encounter!.id }] })).toBe(1);
  });

  it("calls only the clinic's current-day patients across a UTC date boundary", async () => {
    const previousPatient = await patient(); const currentPatient = await patient();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T20:30:00Z"));
    try {
      const headers = await session(doctor, org.id);
      const previous = await Appointment.create({ organizationId: org.id, clinicId: clinic.id, doctorId: doctor.id, patientId: previousPatient.id, appointmentTime: new Date("2026-10-03T17:30:00Z"), appointmentType: "reception", status: "checked-in", tokenNumber: 901 });
      const current = await Appointment.create({ organizationId: org.id, clinicId: clinic.id, doctorId: doctor.id, patientId: currentPatient.id, appointmentTime: new Date("2026-10-04T00:30:00Z"), appointmentType: "reception", status: "checked-in", tokenNumber: 902 });
      const called = await app.inject({ method: "POST", url: "/api/queue/call-next", headers, payload: { clinicId: clinic.id, doctorId: doctor.id, requireArrivalConfirmation: true } });
      expect(called.statusCode, called.body).toBe(200); expect(called.json().data.id).toBe(current.id);
      expect((await Appointment.findById(previous.id))?.status).toBe("checked-in");
      const done = await complete(current.id, {}, headers); expect(done.statusCode, done.body).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
