import { providerFixtureSlug } from "./helpers/providerFixture.ts";
import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { Subscription } from "../models/Subscription.ts";

describe("Dynamic public clinic catalog", () => {
  let top: string, cheap: string, unrated: string, disabledLocationId: string, hiddenLocationId: string, publicDoctorId: string, hiddenDoctorId: string, assignmentOnlyDoctorId: string;
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
      const location = await Location.create({ name: definition.name, city: definition.city, organizationId, createdAt: definition.createdAt, ...coordinates });
      const user = await User.create({ name: `${definition.name} doctor`, role: "doctor", isActive: !definition.inactiveDoctor });
      await Doctor.create({ userId: user._id, organizationId, specialization: definition.specialization });
      await DoctorAssignment.create({ locationId: location._id, doctorId: user._id, organizationId, fees: definition.fees, feeType: definition.fees === 0 ? "free" : "fixed", workingHours: "{}" });
      if (definition.ratings.length) await PatientFeedback.collection.insertMany(definition.ratings.map(rating => ({
        locationId: location._id, doctorId: user._id, patientId: new mongoose.Types.ObjectId(), appointmentId: new mongoose.Types.ObjectId(), rating, npsScore: 8,
      })));
      if (definition.name === "Highest Rating") top = location.id;
      if (definition.name === "Highest Rating") publicDoctorId = user.id;
      if (definition.name === "Hidden Clinic") hiddenDoctorId = user.id;
      if (definition.name === "Hidden Clinic") hiddenLocationId = location.id;
      if (definition.name === "Lowest Fee") cheap = location.id;
      if (definition.name === "Unrated Clinic") unrated = location.id;
      if (definition.name === "Disabled Doctor Clinic") disabledLocationId = location.id;
    }
    // An active clinician assignment can belong to an account with a location staff role.
    const assignmentOnlyDoctor = await User.create({ name: "Clinic listed doctor", role: "admin", isActive: true });
    assignmentOnlyDoctorId = assignmentOnlyDoctor.id;
    await DoctorAssignment.create({ locationId: hiddenLocationId, doctorId: assignmentOnlyDoctor._id, organizationId: hiddenOrg._id, fees: 50, workingHours: "{}" });
    await DoctorAssignment.create({ locationId: top, doctorId: assignmentOnlyDoctor._id, organizationId: org._id, fees: 250, workingHours: "{}" });
  });

  it("serves only active public doctor profiles and their clinic locations", async () => {
    const response = await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", publicDoctorId)}/profile` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ id: publicDoctorId, organizationName: "Published Catalog" });
    expect(response.json().data.locations[0]).toMatchObject({ id: top, fees: 300 });
    expect(response.body).not.toContain("password");
    expect((await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", hiddenDoctorId)}/profile` })).statusCode).toBe(404);
  });

  it("serves a listed doctor even when the optional profile record is missing", async () => {
    const response = await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", assignmentOnlyDoctorId)}/profile` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ id: assignmentOnlyDoctorId, name: "Clinic listed doctor", locations: [{ id: top, fees: 250 }] });
    expect(response.json().data.locations).toHaveLength(1);
    const location = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", top)}?doctorId=${await providerFixtureSlug("doctor", assignmentOnlyDoctorId)}` });
    expect(location.statusCode, location.body).toBe(200);
    expect(location.json().data.doctors.map((doctor: { id: string }) => doctor.id)).toEqual([assignmentOnlyDoctorId]);
    const search = await app.inject({ method: "GET", url: "/api/public/locations?search=Clinic%20listed%20doctor" });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().data.map((item: { id: string }) => item.id)).toContain(top);
  });

  it("uses the linked clinic's organization when a doctor practices across organizations", async () => {
    const otherOrg = await Organization.create({ name: "Other Practice", city: "Surat", isActive: true });
    const otherLocation = await Location.create({ name: "Other Practice Branch", city: "Surat", organizationId: otherOrg._id });
    try {
      await DoctorAssignment.create({ locationId: otherLocation._id, doctorId: publicDoctorId, organizationId: otherOrg._id, fees: 450, workingHours: "{}" });
      const linked = await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", publicDoctorId)}/profile?location=${await providerFixtureSlug("location", otherLocation.id)}` });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json().data).toMatchObject({ organizationName: "Other Practice", locations: [{ id: otherLocation.id, fees: 450 }] });
      const stale = await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", publicDoctorId)}/profile?location=${await providerFixtureSlug("location", cheap)}` });
      expect(stale.statusCode).toBe(404);
    } finally {
      await DoctorAssignment.deleteMany({ locationId: otherLocation._id });
      await Location.deleteOne({ _id: otherLocation._id });
      await Organization.deleteOne({ _id: otherOrg._id });
    }
  });

  it("limits doctor booking context to the selected assignment", async () => {
    const response = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", top)}?doctorId=${await providerFixtureSlug("doctor", publicDoctorId)}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.doctors.map((doctor: { id: string }) => doctor.id)).toEqual([publicDoctorId]);
    expect(response.body).not.toContain(assignmentOnlyDoctorId);
    const invalid = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", top)}?doctorId=invalid` });
    expect(invalid.statusCode).toBe(400);
    const hidden = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", hiddenLocationId)}` });
    expect(hidden.statusCode).toBe(404);
    const disabledDoctor = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", disabledLocationId)}` });
    expect(disabledDoctor.statusCode, disabledDoctor.body).toBe(200);
    expect(disabledDoctor.json().data.doctors).toEqual([]);
    expect(disabledDoctor.json().data.bookingStatus).toBe("no_doctors");
  });

  it("shows contact status consistently when the organization cannot accept bookings", async () => {
    const location = await Location.findById(top).select("organizationId").lean();
    await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", top)}` });
    const subscription = await Subscription.findOne({ organizationId: location!.organizationId });
    expect(subscription).toBeTruthy();
    const previousStatus = subscription!.status;
    try {
      subscription!.status = "cancelled";
      await subscription!.save();
      const list = await app.inject({ method: "GET", url: "/api/public/locations?search=Highest%20Rating" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data[0]).toMatchObject({ id: top, bookingStatus: "contact_location", onlineBookingAvailable: false });
      const detail = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", top)}` });
      expect(detail.json().data).toMatchObject({ bookingStatus: "contact_location", onlineBookingAvailable: false });
      const doctor = await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", publicDoctorId)}/profile?location=${await providerFixtureSlug("location", top)}` });
      expect(doctor.json().data.locations[0]).toMatchObject({ bookingStatus: "contact_location", onlineBookingAvailable: false });
    } finally {
      subscription!.status = previousStatus;
      await subscription!.save();
    }
  });

  it("publishes full-directory facets even when the result page has one clinic", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/locations?sort=rating&limit=1" });
    expect(response.statusCode, response.body).toBe(200);
    const { data, filters } = response.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(top);
    expect(data[0].rating).toBe(4.5);
    expect(data[0].reviewsCount).toBe(2);
    expect(data[0].bookingStatus).toBe(data[0].onlineBookingAvailable ? "check_availability" : "contact_location");
    expect(data[0].doctorsSummary[0]).toMatchObject({ feeType: "fixed", fees: 300 });
    expect(filters.cities).toEqual(["Mumbai", "Pune", "Surat", "Valsad"]);
    expect(filters.specialties).toEqual(["Cardiology", "Dermatology", "General Physician / Consultant"]);
    expect(response.body).not.toContain("patientId");
    expect(response.body).not.toContain("Hidden Specialty");
  });

  it("sorts ratings before pagination and places unreviewed locations last without fake five-star ratings", async () => {
    const first = await app.inject({ method: "GET", url: "/api/public/locations?sort=rating&limit=1" });
    const cursor = String(first.headers["x-next-cursor"] || "");
    expect(cursor).toBeTruthy();
    const second = await app.inject({ method: "GET", url: `/api/public/locations?sort=rating&limit=1&cursor=${encodeURIComponent(cursor)}` });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data[0].id).toBe(cheap);
    const all = await app.inject({ method: "GET", url: "/api/public/locations?sort=rating" });
    expect(all.json().data.slice(0, 2).map((location: { id: string }) => location.id)).toEqual([top, cheap]);
    const noReviews = all.json().data.find((location: { id: string }) => location.id === unrated);
    expect(noReviews.rating).toBeNull();
    expect(noReviews.reviewsCount).toBe(0);
  });

  it("sorts free consultation first and keeps unavailable fees last", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/locations?sort=fee_low" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.map((location: { name: string }) => location.name)).toEqual([
      "Lowest Fee", "Unrated Clinic", "Highest Rating", "Disabled Doctor Clinic",
    ]);
    const filtered = await app.inject({ method: "GET", url: "/api/public/locations?specialization=Cardiology&sort=fee_low" });
    expect(filtered.json().data.map((location: { id: string }) => location.id)).toEqual([cheap]);
  });

  it("ranks nearby locations across cities before pagination and keeps unmapped locations last", async () => {
    const all = await app.inject({ method: "GET", url: "/api/public/locations?sort=nearby&latitude=0&longitude=0" });
    expect(all.statusCode, all.body).toBe(200);
    const data = all.json().data;
    expect(data.map((location: { id: string }) => location.id)).toEqual([cheap, unrated, top, disabledLocationId]);
    expect(data[0].distanceKm).toBeCloseTo(4.448, 2);
    expect(data[1].distanceKm).toBeCloseTo(13.343, 2);
    expect(data[2].distanceKm).toBeGreaterThan(20);
    expect(data[3].distanceKm).toBeNull();
    expect(all.body).not.toContain(hiddenLocationId);
    const ids: string[] = [];
    let cursor = "";
    do {
      const page = await app.inject({ method: "GET", url: `/api/public/locations?sort=nearby&latitude=0&longitude=0&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` });
      expect(page.statusCode, page.body).toBe(200);
      ids.push(...page.json().data.map((location: { id: string }) => location.id));
      cursor = String(page.headers["x-next-cursor"] || "");
    } while (cursor);
    expect(ids).toEqual([cheap, unrated, top, disabledLocationId]);
    const filter = await app.inject({ method: "GET", url: "/api/public/locations?sort=nearby&latitude=0&longitude=0&city=Valsad" });
    expect(filter.json().data.map((location: { id: string }) => location.id)).toEqual([top]);
  });

  it("rejects invalid origins and location-mismatched cursors", async () => {
    for (const query of ["", "&latitude=0", "&latitude=91&longitude=0", "&latitude=0&longitude=-181", "&latitude=NaN&longitude=0", "&latitude=&longitude=0"]) {
      expect((await app.inject({ method: "GET", url: `/api/public/locations?sort=nearby${query}` })).statusCode).toBe(400);
    }
    const first = await app.inject({ method: "GET", url: "/api/public/locations?sort=nearby&latitude=0&longitude=0&limit=1" });
    const cursor = encodeURIComponent(String(first.headers["x-next-cursor"] || ""));
    expect((await app.inject({ method: "GET", url: `/api/public/locations?sort=nearby&latitude=1&longitude=0&cursor=${cursor}` })).statusCode).toBe(400);
  });

  it("handles negative coordinates and distances across the date line without hiding unlocated locations", async () => {
    const location = await Location.findById(cheap);
    const original = { latitude: location!.latitude, longitude: location!.longitude };
    try {
      await Location.updateOne({ _id: cheap }, { latitude: -10, longitude: -179.99 });
      const result = await app.inject({ method: "GET", url: "/api/public/locations?sort=nearby&latitude=-10&longitude=179.99" });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().data[0].id).toBe(cheap);
      expect(result.json().data[0].distanceKm).toBeCloseTo(2.19, 1);
      await Location.updateOne({ _id: cheap }, { latitude: 100, longitude: 0 });
      const invalid = await app.inject({ method: "GET", url: "/api/public/locations?sort=nearby&latitude=0&longitude=0" });
      expect(invalid.statusCode, invalid.body).toBe(200);
      expect(invalid.json().data.find((item: { id: string }) => item.id === cheap).distanceKm).toBeNull();
    } finally { await Location.updateOne({ _id: cheap }, original); }
  });

  it("rejects unsupported sorts and cursors from another sort", async () => {
    const invalid = await app.inject({ method: "GET", url: "/api/public/locations?sort=featured" });
    expect(invalid.statusCode).toBe(400);
    const page = await app.inject({ method: "GET", url: "/api/public/locations?sort=rating&limit=1" });
    const invalidCursor = await app.inject({ method: "GET", url: `/api/public/locations?sort=fee_low&cursor=${encodeURIComponent(String(page.headers["x-next-cursor"] || ""))}` });
    expect(invalidCursor.statusCode).toBe(400);
    for (const value of ["null", "invalid-json", JSON.stringify({ sort: "rating", id: 1, value: 5, hasValue: 1 })]) {
      const cursor = Buffer.from(value).toString("base64url");
      const malformed = await app.inject({ method: "GET", url: `/api/public/locations?sort=rating&cursor=${cursor}` });
      expect(malformed.statusCode, malformed.body).toBe(400);
    }
  });
});


describe("Public provider links", () => {
  it("publishes stable readable slugs and rejects database IDs", async () => {
    const list = await app.inject({ method: "GET", url: "/api/public/locations?limit=100" });
    expect(list.statusCode).toBe(200);
    const location = list.json().data.find((item: any) => item.doctorsSummary.length);
    const doctor = location.doctorsSummary[0];
    expect(location.slug).toMatch(/^[a-z0-9-]+$/);
    expect(location.slug).not.toContain(location.id);
    expect(doctor.slug).not.toContain(doctor.id);
    const detail = await app.inject({ method: "GET", url: "/api/public/locations/" + location.slug });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.id).toBe(location.id);
    const profile = await app.inject({ method: "GET", url: "/api/public/doctors/" + doctor.slug + "/profile?location=" + location.slug });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data).toMatchObject({ id: doctor.id, slug: doctor.slug, locations: expect.arrayContaining([expect.objectContaining({ id: location.id, slug: location.slug })]) });
    await Location.updateOne({ _id: location.id }, { name: "Renamed Clinic" });
    const oldLink = await app.inject({ method: "GET", url: "/api/public/locations/" + location.slug });
    expect(oldLink.json().data).toMatchObject({ slug: location.slug, name: "Renamed Clinic" });
    expect((await app.inject({ method: "GET", url: "/api/public/locations/" + location.id })).statusCode).toBe(404);
    await Location.updateOne({ _id: location.id }, { isActive: false });
    expect((await app.inject({ method: "GET", url: "/api/public/locations/" + location.slug })).statusCode).toBe(404);
    await Location.updateOne({ _id: location.id }, { isActive: true });
  });
  it("counts all active organization locations independently of directory filters and pagination", async () => {
    const organization = await Organization.create({ name: "Single practice", city: "Test City" });
    const location = await Location.create({ name: "Location one", city: "Test City", organizationId: organization._id });
    await Location.create({ name: "Inactive location", city: "Other City", organizationId: organization._id, isActive: false });
    let detail = await app.inject({ method: "GET", url: "/api/public/locations/" + await providerFixtureSlug("location", location.id) });
    expect(detail.json().data.organizationLocationCount).toBe(1);
    await Location.create({ name: "Location two", city: "Other City", organizationId: organization._id });
    detail = await app.inject({ method: "GET", url: "/api/public/locations/" + await providerFixtureSlug("location", location.id) });
    expect(detail.json().data.organizationLocationCount).toBe(2);
    const filtered = await app.inject({ method: "GET", url: "/api/public/locations?city=Test%20City&limit=1" });
    expect(filtered.json().data[0].organizationLocationCount).toBe(2);
  });
});
