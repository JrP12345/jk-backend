import { beforeAll, describe, expect, it } from "vitest";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { PasskeyChallenge } from "../models/PasskeyChallenge.ts";
import { Passkey } from "../models/Passkey.ts";
import { PatientRecordAccess } from "../models/PatientRecordAccess.ts";
import { createRefreshTokenDetails, generateAccessToken, verifyAccessToken } from "../utilities/helpers.ts";

function cookies(response: any) {
  const values = response.headers["set-cookie"] || [];
  return (Array.isArray(values) ? values : [values]).map((cookie: string) => cookie.split(";")[0]).join("; ");
}
async function session(user: any, organizationId?: string) {
  const { rawToken, sessionId } = await createRefreshTokenDetails(user.id, { organizationId });
  const access = generateAccessToken({ id: user.id, email: user.email || "", role: user.role, organization_id: organizationId, sessionId });
  return `access_token=${access}; refresh_token=${rawToken}`;
}

describe("Browse booking, owner session controls and patient approval", () => {
  let orgA: any, orgB: any, ownerA: any, ownerB: any, root: any, doctor: any, clinicA: any, clinicB: any, patient: any;
  let ownerACookie: string, ownerBCookie: string, rootCookie: string;
  beforeAll(async () => {
    orgA = await Organization.create({ name: "Polish A", city: "Surat", email: "polish-a@test.com", plan: "enterprise" });
    orgB = await Organization.create({ name: "Polish B", city: "Surat", email: "polish-b@test.com", plan: "enterprise" });
    ownerA = await User.create({ name: "Owner A", email: "polish-owner-a@test.com", role: "admin" });
    ownerB = await User.create({ name: "Owner B", email: "polish-owner-b@test.com", role: "admin" });
    root = await User.create({ name: "Policy Root", email: "polish-root@test.com", role: "root" });
    doctor = await User.create({ name: "Polish Doctor", email: "polish-doctor@test.com", role: "doctor" });
    await OrgMember.create([{ userId: ownerA._id, organizationId: orgA._id, role: "admin" }, { userId: ownerB._id, organizationId: orgB._id, role: "admin" }, { userId: doctor._id, organizationId: orgB._id, role: "doctor" }]);
    clinicA = await Clinic.create({ name: "Clinic A", city: "Surat", organizationId: orgA._id });
    clinicB = await Clinic.create({ name: "Clinic B", city: "Surat", organizationId: orgB._id });
    await DoctorAssignment.create({ organizationId: orgB._id, doctorId: doctor._id, clinicId: clinicB._id, fees: 0, bookingMode: "sequential_queue", workingHours: JSON.stringify({ all: { start: "00:00", end: "23:59" } }) });
    const patientUser = await User.create({ name: "Consent Patient", phone: "9876501234", role: "patient", authMethod: "phone_otp" });
    patient = await Patient.create({ name: "Consent Patient", allergies: ["Penicillin"], medicalNotes: "Other organization private history", userId: patientUser._id, phone: "9876501234", organizationId: orgA._id });
    const yesterday = new Date(Date.now() - 86400000);
    await Appointment.create([{ organizationId: orgA._id, clinicId: clinicA._id, doctorId: doctor._id, patientId: patient._id, appointmentTime: yesterday, appointmentType: "walk-in", tokenNumber: 1, status: "completed" }, { organizationId: orgB._id, clinicId: clinicB._id, doctorId: doctor._id, patientId: patient._id, appointmentTime: new Date(), appointmentType: "walk-in", tokenNumber: 1, status: "completed" }]);
    ownerACookie = await session(ownerA, orgA.id);
    ownerBCookie = await session(ownerB, orgB.id);
    rootCookie = await session(root);
  });

  it("persists guest booking sessions, books successfully and keeps clinical records private", async () => {
    const result = await app.inject({ method: "POST", url: "/api/public/booking-session", payload: { name: "Booking Patient", phone: "9876505678" } });
    expect(result.statusCode).toBe(200);
    const cookie = cookies(result);
    const access = cookie.split("; ").find((item: string) => item.startsWith("access_token="))!.slice(13);
    const payload = verifyAccessToken(access);
    expect(payload.role).toBe("guest");
    expect(payload.sessionId).toBeTruthy();
    expect(await RefreshToken.exists({ _id: payload.sessionId, isGuest: true })).toBeTruthy();
    const booking = await app.inject({ method: "POST", url: "/api/appointments", headers: { cookie }, payload: { clinicId: clinicB.id, doctorId: doctor.id, appointmentTime: new Date(Date.now() + 60000).toISOString(), appointmentType: "online" } });
    expect(booking.statusCode, booking.body).toBe(201);
    const detail = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/timeline`, headers: { cookie } });
    expect(detail.statusCode).toBe(403);
    const enrollment = await app.inject({ method: "POST", url: "/api/auth/passkeys/register/options", headers: { cookie } });
    expect(enrollment.statusCode).toBe(403);
  });

  it("keeps duplicate refreshes on the live guest session and cannot revive a terminated session", async () => {
    const initial = await app.inject({ method: "POST", url: "/api/public/booking-session", payload: { name: "Refresh Guest", phone: "9876505679" } });
    expect(initial.statusCode, initial.body).toBe(200);
    const oldCookie = cookies(initial);
    const first = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: oldCookie } });
    expect(first.statusCode, first.body).toBe(200);
    const duplicate = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: oldCookie } });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.headers["x-concurrency-grace"]).toBe("true");
    const token = cookies(duplicate).split("; ").find((item: string) => item.startsWith("access_token="))!.slice(13);
    const payload = verifyAccessToken(token);
    expect(payload.role).toBe("guest");
    expect(payload.bookingPatientId).toBeTruthy();
    expect(await RefreshToken.exists({ _id: payload.sessionId, revoked: false })).toBeTruthy();
    await RefreshToken.updateMany({ userId: payload.id }, { revoked: true, revocationReason: "logout" });
    const revoked = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: oldCookie } });
    expect(revoked.statusCode).toBe(401);
  });

  it("allows more than five owner sessions until root applies a limit", async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 7; i++) sessions.push(await session(ownerA, orgA.id));
    expect(await RefreshToken.countDocuments({ userId: ownerA._id, revoked: false })).toBe(8);
    const first = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: ownerACookie } });
    expect(first.statusCode).toBe(200);
    const forbidden = await app.inject({ method: "PATCH", url: `/api/auth/admin/owner-session-policies/${ownerA.id}`, headers: { cookie: ownerBCookie }, payload: { limit: 2 } });
    expect(forbidden.statusCode).toBe(403);
    const limited = await app.inject({ method: "PATCH", url: `/api/auth/admin/owner-session-policies/${ownerA.id}`, headers: { cookie: rootCookie }, payload: { limit: 2 } });
    expect(limited.statusCode, limited.body).toBe(200);
    expect(await RefreshToken.countDocuments({ userId: ownerA._id, revoked: false })).toBe(2);
    const revoked = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: ownerACookie } });
    expect(revoked.statusCode).toBe(401);
    ownerACookie = sessions.at(-1)!;
  });

  it("does not unlock another organization's history merely because an appointment exists today", async () => {
    const scoped = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/timeline`, headers: { cookie: ownerBCookie } });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json().data.events.every((event: any) => event.organizationId === orgB.id)).toBe(true);
    const detail = await app.inject({ method: "GET", url: `/api/patients/${patient.id}`, headers: { cookie: ownerBCookie } });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.patient.allergies).toBeUndefined();
    expect(detail.json().data.patient.medicalNotes).toBeUndefined();
    expect(detail.json().data.patient.clinicalProfileRestricted).toBe(true);
    expect(detail.json().data.appointments.every((appointment: any) => appointment.organizationId === orgB.id)).toBe(true);
    const localNotes = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/clinical-notes/history`, headers: { cookie: ownerBCookie } });
    expect(localNotes.statusCode, localNotes.body).toBe(200);
    const wider = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/timeline?scope=all`, headers: { cookie: ownerBCookie } });
    expect(wider.statusCode).toBe(403);
  });

  it("requires patient OTP and binds approved history to a patient, organization, session and expiry", async () => {
    const requested = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/record-access/request`, headers: { cookie: ownerBCookie } });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json().data.devOtp).toBeUndefined();
    const wrong = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/record-access/verify`, headers: { cookie: ownerBCookie }, payload: { otp: "000000" } });
    expect(wrong.statusCode).toBe(400);
    const verified = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/record-access/verify`, headers: { cookie: ownerBCookie }, payload: { otp: "123456" } });
    expect(verified.statusCode, verified.body).toBe(200);
    const token = verified.json().data.token;
    const headers = { cookie: ownerBCookie, "x-patient-record-access": token };
    const wider = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/timeline?scope=all`, headers });
    expect(wider.statusCode, wider.body).toBe(200);
    expect(new Set(wider.json().data.events.map((event: any) => event.organizationId))).toEqual(new Set([orgA.id, orgB.id]));
    const fullDetail = await app.inject({ method: "GET", url: `/api/patients/${patient.id}?scope=all`, headers });
    expect(fullDetail.statusCode, fullDetail.body).toBe(200);
    expect(fullDetail.json().data.patient.allergies).toEqual(["Penicillin"]);
    expect(new Set(fullDetail.json().data.appointments.map((appointment: any) => appointment.organizationId))).toEqual(new Set([orgA.id, orgB.id]));
    const fullNotes = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/clinical-notes/history?scope=all`, headers });
    expect(fullNotes.statusCode, fullNotes.body).toBe(200);
    const otherSession = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/timeline?scope=all`, headers: { ...headers, cookie: await session(ownerB, orgB.id) } });
    expect(otherSession.statusCode).toBe(403);
    const replay = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/record-access/verify`, headers: { cookie: ownerBCookie }, payload: { otp: "123456" } });
    expect(replay.statusCode).toBe(400);
    await PatientRecordAccess.updateMany({}, { expiresAt: new Date(Date.now() - 1) });
    const expired = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/timeline?scope=all`, headers });
    expect(expired.statusCode).toBe(403);
  });

  it("refuses fabricated passkeys and consumes challenges once", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/api/auth/passkeys/register/options" });
    expect(anonymous.statusCode).toBe(401);
    const options = await app.inject({ method: "POST", url: "/api/auth/passkeys/register/options", headers: { cookie: ownerACookie } });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().data.authenticatorSelection.userVerification).toBe("required");
    const cookie = `${ownerACookie}; ${cookies(options)}`;
    const invalid = await app.inject({ method: "POST", url: "/api/auth/passkeys/register/verify", headers: { cookie }, payload: { response: { id: "fabricated", response: {} } } });
    expect(invalid.statusCode).toBe(400);
    expect(await Passkey.countDocuments()).toBe(0);
    expect(await PasskeyChallenge.countDocuments({ kind: "registration" })).toBe(0);
    const authOptions = await app.inject({ method: "POST", url: "/api/auth/passkeys/login/options" });
    expect(authOptions.statusCode).toBe(200);
    const failed = await app.inject({ method: "POST", url: "/api/auth/passkeys/login/verify", headers: { cookie: cookies(authOptions) }, payload: { response: { id: "fabricated", response: {} } } });
    expect(failed.statusCode).toBe(401);
    expect(await PasskeyChallenge.countDocuments({ kind: "authentication" })).toBe(0);
  });

  it("calculates local-day totals over all rows and counts payments received today on older bills", async () => {
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    await Appointment.insertMany(Array.from({ length: 105 }, () => ({ organizationId: orgB._id, clinicId: clinicB._id, doctorId: doctor._id, patientId: patient._id, appointmentTime: today, appointmentType: "walk-in", tokenNumber: 1, status: "completed" })));
    await Invoice.create([{ organizationId: orgB._id, clinicId: clinicB._id, doctorId: doctor._id, patientId: patient._id, invoiceNumber: "DAILY-1", items: [{ description: "Visit", amount: 100, quantity: 1 }], subtotal: 100, totalAmount: 100, status: "unpaid", createdAt: today }, { organizationId: orgB._id, clinicId: clinicB._id, doctorId: doctor._id, patientId: patient._id, invoiceNumber: "DAILY-2", items: [{ description: "Old visit", amount: 300, quantity: 1 }], subtotal: 300, totalAmount: 300, status: "partially_paid", amountPaid: 150, createdAt: yesterday, payments: [{ amount: 150, paymentMethod: "cash", paidAt: today }] }]);
    const start = new Date(today); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1); end.setMilliseconds(-1);
    const result = await app.inject({ method: "GET", url: `/api/analytics/daily-summary?${new URLSearchParams({ startDate: start.toISOString(), endDate: end.toISOString() })}`, headers: { cookie: ownerBCookie } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.completed).toBe(106);
    expect(result.json().data.collections).toBe(150);
    expect(result.json().data.outstanding).toBe(100);
  });
});
