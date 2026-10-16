import { beforeAll, describe, expect, it } from "vitest";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import mongoose from "mongoose";

describe("Readiness cross-module reporting and assignment boundaries", () => {
  let org: any, own: any, sibling: any, foreign: any, doctor: any, patient: any, doctorCookie: string, nurseCookie: string;
  beforeAll(async () => {
    org = await Organization.create({ name: "Reporting fixture", city: "Surat" });
    foreign = await Organization.create({ name: "Foreign reporting fixture", city: "Surat" });
    own = await Location.create({ organizationId: org.id, name: "Granted branch", city: "Surat" });
    sibling = await Location.create({ organizationId: org.id, name: "Restricted branch", city: "Surat" });
    doctor = await User.create({ name: "Restricted doctor", role: "doctor" });
    const nurse = await User.create({ name: "Clinical nurse", role: "nurse" });
    for (const user of [doctor, nurse]) await OrgMember.create({ userId: user.id, organizationId: org.id, role: user.role, locationAccess: { mode: "selected", locationIds: [own.id] } });
    doctorCookie = `access_token=${await fixtureAccessToken({ id: doctor.id, role: "doctor", email: "", organization_id: org.id })}`;
    nurseCookie = `access_token=${await fixtureAccessToken({ id: nurse.id, role: "nurse", email: "", organization_id: org.id })}`;
    await DoctorAssignment.create([own, sibling].map(branch => ({ doctorId: doctor.id, organizationId: org.id, locationId: branch.id, isActive: true, workingHours: "[]" })));
    patient = await Patient.create({ name: "Reporting patient", organizationId: org.id });
    await Invoice.collection.insertMany([
      { status: "paid", totalAmount: 1000, amountPaid: 1000 },
      { status: "partially_paid", totalAmount: 500, amountPaid: 125 },
      { status: "unpaid", totalAmount: 400, amountPaid: 0 },
      { status: "cancelled", totalAmount: 10000, amountPaid: 0 },
    ].map((item, index) => ({ ...item, invoiceNumber: `READY-${index}`, organizationId: org._id, locationId: own._id, doctorId: doctor._id, patientId: patient._id, currency: "INR", createdAt: new Date() })));
    await Invoice.collection.insertMany([
      { invoiceNumber: "READY-SIBLING", organizationId: org._id, locationId: sibling._id },
      { invoiceNumber: "READY-CORRUPT-FOREIGN", organizationId: foreign._id, locationId: own._id },
    ].map(item => ({ ...item, doctorId: doctor._id, patientId: patient._id, status: "paid", totalAmount: 9999, amountPaid: 9999, currency: "INR", createdAt: new Date() })));
    await Appointment.collection.insertMany([own, sibling].map(branch => ({ organizationId: org._id, locationId: branch._id, doctorId: doctor._id, patientId: patient._id, status: "completed", appointmentTime: new Date(), appointmentType: "walk-in" })));
  });
  it("excludes restricted branch assignments and denies explicit ungranted selections", async () => {
    const response = await app.inject({ method: "GET", url: "/api/onboarding/doctors/assignments", headers: { cookie: doctorCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: any) => row.locationId.id)).toEqual([own.id]);
    expect((await app.inject({ method: "GET", url: `/api/onboarding/doctors/assignments?locationId=${sibling.id}`, headers: { cookie: doctorCookie } })).statusCode).toBe(403);
  });
  it("keeps executive totals inside grants and includes partial receipts and outstanding balances", async () => {
    const response = await app.inject({ method: "GET", url: "/api/analytics/executive", headers: { cookie: doctorCookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.locationsPerformance.map((row: any) => row.id)).toEqual([own.id]);
    expect(response.json().data.overall).toMatchObject({ totalRevenue: 1125, outstandingBilling: 775 });
    expect(response.json().data.appointmentStats.total).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/analytics/executive?locationId=${sibling.id}`, headers: { cookie: doctorCookie } })).statusCode).toBe(404);
  });
  it("requires reporting permission for every reporting entry, including direct URLs", async () => {
    for (const endpoint of ["executive", "nabh-kpis", "clinical-summary", "export"]) {
      expect((await app.inject({ method: "GET", url: `/api/analytics/${endpoint}`, headers: { cookie: nurseCookie } })).statusCode, endpoint).toBe(403);
    }
  });
  it("scopes clinical search and quality metrics to granted locations and keeps result links on real pages", async () => {
    const encounterId = new mongoose.Types.ObjectId();
    for (const [organization, branch, value] of [[org, own, "72"], [org, sibling, "99"], [foreign, own, "150"]]) {
      await Observation.create({ organizationId: organization.id, locationId: branch.id, patientId: patient.id, encounterId, recordedBy: doctor.id, code: "HR", name: "Heart rate", value });
      await ObservationScore.create({ organizationId: organization.id, locationId: branch.id, patientId: patient.id, encounterId, algorithmId: "NEWS2", algorithmVersion: "1", totalScore: Number(value), riskCategory: "High", isComplete: true });
    }
    const response = await app.inject({ method: "GET", url: `/api/patients/${patient.id}/search?category=observation`, headers: { cookie: doctorCookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items).toHaveLength(1);
    expect(response.json().data.items[0].snippet).toContain("72");
    expect(response.json().data.items[0].resourceRef.link).toBe(`/dashboard/patients/${patient.id}/timeline`);
    const metrics = await app.inject({ method: "GET", url: "/api/analytics/quality-metrics", headers: { cookie: doctorCookie } });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().data.clinical.totalNews2Evaluations).toBe(1);
  });
});
