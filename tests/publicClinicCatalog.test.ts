import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { Subscription } from "../models/Subscription.ts";

describe("Dynamic public clinic catalog", () => {
  let top: string, cheap: string, unrated: string, disabledClinicId: string, hiddenClinicId: string, publicDoctorId: string, hiddenDoctorId: string, assignmentOnlyDoctorId: string;
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
      const coordinates = definition.inactiveDoctor ? {} : { latitude: 0, longitude: definition.hidden ? 0.001 : definition.name === "Lowest Fee" ? 0.04 : definition.name === "Unrated Clinic" ? 0.12 : 0.3 };
      const clinic = await Clinic.create({ name: definition.name, city: definition.city, organizationId, createdAt: definition.createdAt, ...coordinates });
      const user = await User.create({ name: `${definition.name} doctor`, role: "doctor", isActive: !definition.inactiveDoctor });
      await Doctor.create({ userId: user._id, organizationId, specialization: definition.specialization });
      await DoctorAssignment.create({ clinicId: clinic._id, doctorId: user._id, organizationId, fees: definition.fees, feeType: definition.fees === 0 ? "free" : "fixed", workingHours: "{}" });
      if (definition.ratings.length) await PatientFeedback.collection.insertMany(definition.ratings.map(rating => ({
        clinicId: clinic._id, doctorId: user._id, patientId: new mongoose.Types.ObjectId(), appointmentId: new mongoose.Types.ObjectId(), rating, npsScore: 8,
      })));
      if (definition.name === "Highest Rating") top = clinic.id;
      if (definition.name === "Highest Rating") publicDoctorId = user.id;
      if (definition.name === "Hidden Clinic") hiddenDoctorId = user.id;
      if (definition.name === "Hidden Clinic") hiddenClinicId = clinic.id;
      if (definition.name === "Lowest Fee") cheap = clinic.id;
      if (definition.name === "Unrated Clinic") unrated = clinic.id;
      if (definition.name === "Disabled Doctor Clinic") disabledClinicId = clinic.id;
    }
    // An active clinician assignment can belong to an account with a clinic staff role.
    const assignmentOnlyDoctor = await User.create({ name: "Clinic listed doctor", role: "admin", isActive: true });
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
    const clinic = await app.inject({ method: "GET", url: `/api/public/clinics/${top}?doctorId=${assignmentOnlyDoctorId}` });
    expect(clinic.statusCode, clinic.body).toBe(200);
    expect(clinic.json().data.doctors.map((doctor: { id: string }) => doctor.id)).toEqual([assignmentOnlyDoctorId]);
    const search = await app.inject({ method: "GET", url: "/api/public/clinics?search=Clinic%20listed%20doctor" });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().data.map((item: { id: string }) => item.id)).toContain(top);
  });

  it("uses the linked clinic's organization when a doctor practices across organizations", async () => {
    const otherOrg = await Organization.create({ name: "Other Practice", city: "Surat", isActive: true });
    const otherClinic = await Clinic.create({ name: "Other Practice Branch", city: "Surat", organizationId: otherOrg._id });
    try {
      await DoctorAssignment.create({ clinicId: otherClinic._id, doctorId: publicDoctorId, organizationId: otherOrg._id, fees: 450, workingHours: "{}" });
      const linked = await app.inject({ method: "GET", url: `/api/public/doctors/${publicDoctorId}/profile?clinicId=${otherClinic.id}` });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json().data).toMatchObject({ organizationName: "Other Practice", locations: [{ id: otherClinic.id, fees: 450 }] });
      const stale = await app.inject({ method: "GET", url: `/api/public/doctors/${publicDoctorId}/profile?clinicId=${cheap}` });
      expect(stale.statusCode).toBe(404);
    } finally {
      await DoctorAssignment.deleteMany({ clinicId: otherClinic._id });
      await Clinic.deleteOne({ _id: otherClinic._id });
      await Organization.deleteOne({ _id: otherOrg._id });
    }
  });

  it("limits doctor booking context to the selected assignment", async () => {
    const response = await app.inject({ method: "GET", url: `/api/public/clinics/${top}?doctorId=${publicDoctorId}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.doctors.map((doctor: { id: string }) => doctor.id)).toEqual([publicDoctorId]);
    expect(response.body).not.toContain(assignmentOnlyDoctorId);
    const invalid = await app.inject({ method: "GET", url: `/api/public/clinics/${top}?doctorId=invalid` });
    expect(invalid.statusCode).toBe(400);
    const hidden = await app.inject({ method: "GET", url: `/api/public/clinics/${hiddenClinicId}` });
    expect(hidden.statusCode).toBe(404);
    const disabledDoctor = await app.inject({ method: "GET", url: `/api/public/clinics/${disabledClinicId}` });
    expect(disabledDoctor.statusCode, disabledDoctor.body).toBe(200);
    expect(disabledDoctor.json().data.doctors).toEqual([]);
    expect(disabledDoctor.json().data.bookingStatus).toBe("no_doctors");
  });

  it("shows contact status consistently when the organization cannot accept bookings", async () => {
    const clinic = await Clinic.findById(top).select("organizationId").lean();
    await app.inject({ method: "GET", url: `/api/public/clinics/${top}` });
    const subscription = await Subscription.findOne({ organizationId: clinic!.organizationId });
    expect(subscription).toBeTruthy();
    const previousStatus = subscription!.status;
    try {
      subscription!.status = "cancelled";
      await subscription!.save();
      const list = await app.inject({ method: "GET", url: "/api/public/clinics?search=Highest%20Rating" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data[0]).toMatchObject({ id: top, bookingStatus: "contact_clinic", onlineBookingAvailable: false });
      const detail = await app.inject({ method: "GET", url: `/api/public/clinics/${top}` });
      expect(detail.json().data).toMatchObject({ bookingStatus: "contact_clinic", onlineBookingAvailable: false });
      const doctor = await app.inject({ method: "GET", url: `/api/public/doctors/${publicDoctorId}/profile?clinicId=${top}` });
      expect(doctor.json().data.locations[0]).toMatchObject({ bookingStatus: "contact_clinic", onlineBookingAvailable: false });
    } finally {
      subscription!.status = previousStatus;
      await subscription!.save();
    }
  });

  it("publishes full-directory facets even when the result page has one clinic", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/clinics?sort=rating&limit=1" });
    expect(response.statusCode, response.body).toBe(200);
    const { data, filters } = response.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(top);
    expect(data[0].rating).toBe(4.5);
    expect(data[0].reviewsCount).toBe(2);
    expect(data[0].bookingStatus).toBe(data[0].onlineBookingAvailable ? "check_availability" : "contact_clinic");
    expect(data[0].doctorsSummary[0]).toMatchObject({ feeType: "fixed", fees: 300 });
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

  it("ranks nearby clinics across cities before pagination and keeps unmapped clinics last", async () => {
    const all = await app.inject({ method: "GET", url: "/api/public/clinics?sort=nearby&latitude=0&longitude=0" });
    expect(all.statusCode, all.body).toBe(200);
    const data = all.json().data;
    expect(data.map((clinic: { id: string }) => clinic.id)).toEqual([cheap, unrated, top, disabledClinicId]);
    expect(data[0].distanceKm).toBeCloseTo(4.448, 2);
    expect(data[1].distanceKm).toBeCloseTo(13.343, 2);
    expect(data[2].distanceKm).toBeGreaterThan(20);
    expect(data[3].distanceKm).toBeNull();
    expect(all.body).not.toContain(hiddenClinicId);
    const ids: string[] = [];
    let cursor = "";
    do {
      const page = await app.inject({ method: "GET", url: `/api/public/clinics?sort=nearby&latitude=0&longitude=0&limit=1&format=paginated${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` });
      expect(page.statusCode, page.body).toBe(200);
      ids.push(...page.json().data.items.map((clinic: { id: string }) => clinic.id));
      cursor = page.json().data.nextCursor;
    } while (cursor);
    expect(ids).toEqual([cheap, unrated, top, disabledClinicId]);
    const filter = await app.inject({ method: "GET", url: "/api/public/clinics?sort=nearby&latitude=0&longitude=0&city=Valsad" });
    expect(filter.json().data.map((clinic: { id: string }) => clinic.id)).toEqual([top]);
  });

  it("rejects invalid origins and location-mismatched cursors", async () => {
    for (const query of ["", "&latitude=0", "&latitude=91&longitude=0", "&latitude=0&longitude=-181", "&latitude=NaN&longitude=0", "&latitude=&longitude=0"]) {
      expect((await app.inject({ method: "GET", url: `/api/public/clinics?sort=nearby${query}` })).statusCode).toBe(400);
    }
    const first = await app.inject({ method: "GET", url: "/api/public/clinics?sort=nearby&latitude=0&longitude=0&limit=1&format=paginated" });
    const cursor = encodeURIComponent(first.json().data.nextCursor);
    expect((await app.inject({ method: "GET", url: `/api/public/clinics?sort=nearby&latitude=1&longitude=0&cursor=${cursor}` })).statusCode).toBe(400);
  });

  it("handles negative coordinates and distances across the date line without hiding unlocated clinics", async () => {
    const clinic = await Clinic.findById(cheap);
    const original = { latitude: clinic!.latitude, longitude: clinic!.longitude };
    try {
      await Clinic.updateOne({ _id: cheap }, { latitude: -10, longitude: -179.99 });
      const result = await app.inject({ method: "GET", url: "/api/public/clinics?sort=nearby&latitude=-10&longitude=179.99" });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().data[0].id).toBe(cheap);
      expect(result.json().data[0].distanceKm).toBeCloseTo(2.19, 1);
      await Clinic.updateOne({ _id: cheap }, { latitude: 100, longitude: 0 });
      const invalid = await app.inject({ method: "GET", url: "/api/public/clinics?sort=nearby&latitude=0&longitude=0" });
      expect(invalid.statusCode, invalid.body).toBe(200);
      expect(invalid.json().data.find((item: { id: string }) => item.id === cheap).distanceKm).toBeNull();
    } finally { await Clinic.updateOne({ _id: cheap }, original); }
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
