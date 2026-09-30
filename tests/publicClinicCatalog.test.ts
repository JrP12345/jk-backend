import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";

describe("Dynamic public clinic catalog", () => {
  let top: string, cheap: string, unrated: string, hiddenClinicId: string, publicDoctorId: string, hiddenDoctorId: string, assignmentOnlyDoctorId: string;
  beforeAll(async () => {
    const org = await Organization.create({ name: "Published Catalog", city: "Surat", isActive: true });
    const hiddenOrg = await Organization.create({ name: "Hidden Catalog", city: "Hidden City", isActive: false });
    const definitions = [
      { name: "Highest Rating", city: "Valsad", fees: 300, ratings: [4, 5], specialization: "General Physician / Consultant", createdAt: new Date("2020-01-01") },
      { name: "Lowest Fee", city: "Surat", fees: 0, ratings: [3], specialization: "Cardiology", createdAt: new Date("2021-01-01") },
      { name: "Unrated Clinic", city: "Mumbai", fees: 100, ratings: [], specialization: "Dermatology", createdAt: new Date("2026-01-01") },
      { name: "Disabled Doctor Clinic", city: "Pune", fees: 10, ratings: [], specialization: "Unavailable Specialty", inactiveDoctor: true },
      { name: "Hidden Clinic", city: "Hidden City", fees: 1, ratings: [5], specialization: "Hidden Specialty", hidden: true },
    ];
    for (const definition of definitions) {
      const organizationId = definition.hidden ? hiddenOrg._id : org._id;
      const clinic = await Clinic.create({ name: definition.name, city: definition.city, organizationId, createdAt: definition.createdAt });
      const user = await User.create({ name: `${definition.name} doctor`, role: "doctor", isActive: !definition.inactiveDoctor });
      await Doctor.create({ userId: user._id, organizationId, specialization: definition.specialization });
      await DoctorAssignment.create({ clinicId: clinic._id, doctorId: user._id, organizationId, fees: definition.fees, workingHours: "{}" });
      if (definition.ratings.length) await PatientFeedback.collection.insertMany(definition.ratings.map(rating => ({
        clinicId: clinic._id, doctorId: user._id, patientId: new mongoose.Types.ObjectId(), appointmentId: new mongoose.Types.ObjectId(), rating, npsScore: 8,
      })));
      if (definition.name === "Highest Rating") top = clinic.id;
      if (definition.name === "Highest Rating") publicDoctorId = user.id;
      if (definition.name === "Hidden Clinic") hiddenDoctorId = user.id;
      if (definition.name === "Hidden Clinic") hiddenClinicId = clinic.id;
      if (definition.name === "Lowest Fee") cheap = clinic.id;
      if (definition.name === "Unrated Clinic") unrated = clinic.id;
    }
    const assignmentOnlyDoctor = await User.create({ name: "Clinic listed doctor", role: "doctor", isActive: true });
    assignmentOnlyDoctorId = assignmentOnlyDoctor.id;
    await DoctorAssignment.create({ clinicId: hiddenClinicId, doctorId: assignmentOnlyDoctor._id, organizationId: hiddenOrg._id, fees: 50, workingHours: "{}" });
    await DoctorAssignment.create({ clinicId: top, doctorId: assignmentOnlyDoctor._id, organizationId: org._id, fees: 250, workingHours: "{}" });
  });

  it("serves only active public doctor profiles and their clinic locations", async () => {
    const response = await app.inject({ method: "GET", url: `/api/public/doctors/${publicDoctorId}/profile` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ id: publicDoctorId, organizationName: "Published Catalog" });
    expect(response.json().data.locations[0]).toMatchObject({ id: top, fees: 300 });
    expect(response.body).not.toContain("password");
    expect((await app.inject({ method: "GET", url: `/api/public/doctors/${hiddenDoctorId}/profile` })).statusCode).toBe(404);
  });

  it("serves a listed doctor even when the optional profile record is missing", async () => {
    const response = await app.inject({ method: "GET", url: `/api/public/doctors/${assignmentOnlyDoctorId}/profile` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ id: assignmentOnlyDoctorId, name: "Clinic listed doctor", locations: [{ id: top, fees: 250 }] });
    expect(response.json().data.locations).toHaveLength(1);
  });

  it("publishes full-directory facets even when the result page has one clinic", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/clinics?sort=rating&limit=1" });
    expect(response.statusCode, response.body).toBe(200);
    const { data, filters } = response.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(top);
    expect(data[0].rating).toBe(4.5);
    expect(data[0].reviewsCount).toBe(2);
    expect(filters.cities).toEqual(["Mumbai", "Pune", "Surat", "Valsad"]);
    expect(filters.specialties).toEqual(["Cardiology", "Dermatology", "General Physician / Consultant"]);
    expect(response.body).not.toContain("patientId");
    expect(response.body).not.toContain("Hidden Specialty");
  });

  it("sorts ratings before pagination and places unreviewed clinics last without fake five-star ratings", async () => {
    const first = await app.inject({ method: "GET", url: "/api/public/clinics?sort=rating&limit=1&format=paginated" });
    const cursor = first.json().data.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await app.inject({ method: "GET", url: `/api/public/clinics?sort=rating&limit=1&cursor=${encodeURIComponent(cursor)}` });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.items[0].id).toBe(cheap);
    const all = await app.inject({ method: "GET", url: "/api/public/clinics?sort=rating" });
    expect(all.json().data.slice(0, 2).map((clinic: { id: string }) => clinic.id)).toEqual([top, cheap]);
    const noReviews = all.json().data.find((clinic: { id: string }) => clinic.id === unrated);
    expect(noReviews.rating).toBeNull();
    expect(noReviews.reviewsCount).toBe(0);
  });

  it("sorts free consultation first and keeps unavailable fees last", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/clinics?sort=fee_low" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.map((clinic: { name: string }) => clinic.name)).toEqual([
      "Lowest Fee", "Unrated Clinic", "Highest Rating", "Disabled Doctor Clinic",
    ]);
    const filtered = await app.inject({ method: "GET", url: "/api/public/clinics?specialization=Cardiology&sort=fee_low" });
    expect(filtered.json().data.map((clinic: { id: string }) => clinic.id)).toEqual([cheap]);
  });

  it("rejects unsupported sorts and cursors from another sort", async () => {
    const invalid = await app.inject({ method: "GET", url: "/api/public/clinics?sort=featured" });
    expect(invalid.statusCode).toBe(400);
    const page = await app.inject({ method: "GET", url: "/api/public/clinics?sort=rating&limit=1&format=paginated" });
    const invalidCursor = await app.inject({ method: "GET", url: `/api/public/clinics?sort=fee_low&cursor=${encodeURIComponent(page.json().data.nextCursor)}` });
    expect(invalidCursor.statusCode).toBe(400);
    for (const value of ["null", "invalid-json", JSON.stringify({ sort: "rating", id: 1, value: 5, hasValue: 1 })]) {
      const cursor = Buffer.from(value).toString("base64url");
      const malformed = await app.inject({ method: "GET", url: `/api/public/clinics?sort=rating&cursor=${cursor}` });
      expect(malformed.statusCode, malformed.body).toBe(400);
    }
  });
});
