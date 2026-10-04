import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { disruptionService } from "../services/disruptionService.ts";
import { eventBus } from "../events/eventBus.ts";
import { SmsWhatsAppService } from "../services/SmsWhatsAppService.ts";
import { generateAccessToken } from "../utilities/helpers.ts";
import { clinicDayRange } from "../utilities/clinicTime.ts";

let clinicId: string, orgId: string, doctorId: string, replacementId: string, patientId: string, rootCookie: string;
beforeAll(async () => {
  const org = await Organization.create({ name: "Timezone Health", city: "New York", timezone: "America/New_York", countryCode: "US", currency: "USD" });
  orgId = org.id;
  const clinic = await Clinic.create({ name: "Timezone Clinic", city: "New York", organizationId: org._id, timezone: "America/New_York" }); clinicId = clinic.id;
  const users = await User.create([{ name: "Original", role: "doctor" }, { name: "Replacement", role: "doctor" }, { name: "Root", role: "root" }]);
  doctorId = users[0].id; replacementId = users[1].id;
  rootCookie = `access_token=${generateAccessToken({ id: users[2].id, email: "", role: "root" })}`;
  const patient = await Patient.create({ name: "Timezone Patient", phone: "+14155550199", organizationId: org._id }); patientId = patient.id;
  await DoctorAssignment.create([{ clinicId, organizationId: orgId, doctorId, workingHours: "[]" }, { clinicId, organizationId: orgId, doctorId: replacementId, workingHours: "[]" }]);
});
afterEach(() => vi.restoreAllMocks());
const appointment = (time: string, status: "checked-in" | "confirmed" | "disruption_triage", provider = doctorId, tokenNumber = 1) => Appointment.create({ clinicId, organizationId: orgId, doctorId: provider, patientId, appointmentTime: new Date(time), appointmentType: "reception", status, tokenNumber, queuePosition: tokenNumber });

describe("Disruption uses the clinic's calendar and clock", () => {
  it.each(["2026-03-08", "2026-11-01"])("lists exactly the local triage day across DST: %s", async date => {
    const range = clinicDayRange(date, "America/New_York");
    const docs = await Promise.all([
      appointment(new Date(range.start.getTime() - 1).toISOString(), "disruption_triage"),
      appointment(range.start.toISOString(), "disruption_triage"),
      appointment(range.end.toISOString(), "disruption_triage"),
      appointment(new Date(range.end.getTime() + 1).toISOString(), "disruption_triage"),
    ]);
    const result = await app.inject({ method: "GET", url: `/api/doctor-overrides/triage?clinicId=${clinicId}&date=${date}`, headers: { cookie: rootCookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.map((visit: { id: string }) => visit.id).sort()).toEqual([docs[1].id, docs[2].id].sort());
  });
  it("rejects impossible clinic dates before querying or setting overrides", async () => {
    const result = await app.inject({ method: "GET", url: `/api/doctor-overrides/triage?clinicId=${clinicId}&date=2026-02-30`, headers: { cookie: rootCookie } });
    expect(result.statusCode).toBe(400);
    const set = await app.inject({ method: "POST", url: "/api/doctor-overrides", headers: { cookie: rootCookie }, payload: { clinicId, doctorId, date: "2026-02-30", status: "unavailable" } });
    expect(set.statusCode).toBe(400);
  });
  it("uses local closing time and excludes visits on the next clinic day", async () => {
    vi.spyOn(eventBus, "publishDurable").mockResolvedValue(undefined as never);
    const before = await appointment("2027-01-10T21:59:00Z", "checked-in"); // 16:59 local
    const affected = await appointment("2027-01-10T22:00:00Z", "checked-in"); // 17:00 local
    const nextDay = await appointment("2027-01-11T05:00:00Z", "checked-in");
    const summary = await disruptionService.processDoctorDisruption({ clinicId, doctorId, date: "2027-01-10", status: "delayed", effectiveEndTime: "17:00", userId: doctorId, organizationId: orgId, disruptionId: new mongoose.Types.ObjectId() });
    expect(summary.checkedInTriageCount).toBe(1);
    expect((await Appointment.findById(before.id))?.status).toBe("checked-in");
    expect((await Appointment.findById(affected.id))?.status).toBe("disruption_triage");
    expect((await Appointment.findById(nextDay.id))?.status).toBe("checked-in");
  });
  it("counts replacement load on the local day rather than UTC day", async () => {
    await appointment("2027-02-10T04:59:00Z", "confirmed", replacementId);
    await appointment("2027-02-11T04:59:00Z", "confirmed", replacementId);
    await appointment("2027-02-11T05:00:00Z", "confirmed", replacementId);
    const replacements = await disruptionService.getEligibleReplacementDoctors(clinicId, "2027-02-10", doctorId);
    expect(replacements.find(provider => provider.doctorId === replacementId)?.currentBookingsCount).toBe(1);
  });
  it("batches replacement reads while retaining overrides, empty loads and clinic isolation", async () => {
    const providers = await User.create([{ name: "Unavailable", role: "doctor" }, { name: "Delayed", role: "doctor" }]);
    await DoctorAssignment.create(providers.map(provider => ({ clinicId, organizationId: orgId, doctorId: provider.id, workingHours: "[]" })));
    await DoctorDayOverride.create(providers.map((provider, index) => ({ clinicId, organizationId: orgId, doctorId: provider.id, date: "2027-03-10", status: index ? "delayed" as const : "unavailable" as const, createdBy: doctorId })));
    const otherClinic = await Clinic.create({ name: "Other", city: "New York", organizationId: orgId });
    await Appointment.create({ clinicId: otherClinic.id, organizationId: orgId, doctorId: providers[1].id, patientId, appointmentTime: new Date("2027-03-10T15:00:00Z"), appointmentType: "reception", status: "confirmed", tokenNumber: 1 });
    const overrideRead = vi.spyOn(DoctorDayOverride, "find");
    const loadRead = vi.spyOn(Appointment, "aggregate");
    const replacements = await disruptionService.getEligibleReplacementDoctors(clinicId, "2027-03-10", doctorId);
    expect(replacements.some(provider => provider.doctorId === providers[0].id)).toBe(false);
    expect(replacements.find(provider => provider.doctorId === providers[1].id)).toMatchObject({ overrideStatus: "delayed", currentBookingsCount: 0 });
    expect(overrideRead).toHaveBeenCalledOnce();
    expect(loadRead).toHaveBeenCalledOnce();
  });
  it("preserves an explicit midnight reschedule and allocates its token on the local day", async () => {
    vi.spyOn(eventBus, "publishDurable").mockResolvedValue(undefined as never);
    vi.spyOn(SmsWhatsAppService, "sendBookingConfirmation").mockResolvedValue(undefined as never);
    const original = await appointment("2027-01-12T15:00:00Z", "disruption_triage");
    await appointment("2027-01-15T04:59:00Z", "confirmed", doctorId, 99); // previous local day
    await appointment("2027-01-16T04:59:00Z", "confirmed", doctorId, 5); // chosen local day
    const result = await disruptionService.priorityReschedule({ appointmentId: original.id, targetDate: "2027-01-15", targetTimeSlot: "00:00", rescheduledByUserId: doctorId });
    expect(result.newAppt.appointmentTime.toISOString()).toBe("2027-01-15T05:00:00.000Z");
    expect(result.newAppt.tokenNumber).toBe(6);
  });
});
