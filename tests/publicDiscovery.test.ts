import { beforeAll, describe, expect, it } from "vitest";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { PublicLink } from "../models/PublicLink.ts";
import { publicSlug } from "../utilities/publicLinks.ts";
import { canCreateLocationBooking } from "../services/billing/SubscriptionAccess.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { Subscription } from "../models/Subscription.ts";

describe("Public discovery and owner publishing", () => {
  let org: any, location: any, hidden: any, doctor: any, owner: any, other: any;
  let ownerHeaders: { authorization: string };
  beforeAll(async () => {
    await app.ready();
    org = await Organization.create({ name: "Discovery Practice", city: "Surat", plan: "enterprise" });
    other = await Organization.create({ name: "Other Discovery Practice", city: "Surat" });
    location = await Location.create({ organizationId: org._id, name: "Published Branch", city: "Surat", upiVpa: "private-merchant@upi" });
    hidden = await Location.create({ organizationId: org._id, name: "Unpublished Branch", city: "Surat", isPublished: false });
    doctor = await User.create({ name: "Discovery Doctor", role: "doctor", email: "private-doctor@example.test" });
    await Doctor.create({ userId: doctor._id, organizationId: org._id, specialization: "Cardiology", image_url: "tenants/private/patient-photo.png" });
    await DoctorAssignment.create([location, hidden].map((item) => ({ organizationId: org._id, locationId: item._id, doctorId: doctor._id, fees: 100, workingHours: "{}" })));
    owner = await User.create({ name: "Discovery Owner", role: "admin", email: "discovery-owner@example.test" });
    await OrgMember.create({ userId: owner._id, organizationId: org._id, role: "admin" });
    await ModuleRegistry.create({ organizationId: org._id, moduleKey: "locations", enabled: true, priority: "P1", label: "Locations" });
    ownerHeaders = { authorization: `Bearer ${await fixtureAccessToken({ id: owner.id, email: owner.email, role: "admin", organization_id: org.id })}` };
  });

  it("discovers previously unvisited profiles with stable slugs and no private data", async () => {
    const first = await app.inject({ method: "GET", url: "/api/public/discovery" });
    expect(first.statusCode, first.body).toBe(200);
    const paths = first.json().data.paths;
    const slug = await publicSlug("location", location.id, location.name);
    const doctorSlug = await publicSlug("doctor", doctor.id, doctor.name);
    expect(paths).toContain(`/browse/${slug}`);
    expect(paths).toContain(`/doctor/${doctorSlug}?location=${slug}`);
    expect(paths.some((path: string) => path.includes("unpublished"))).toBe(false);
    expect(first.body).not.toContain(doctor.email);
    expect(first.body).not.toContain("private-merchant");
    expect(first.body).not.toContain(location.id);
    await Location.updateOne({ _id: location._id }, { name: "Renamed Branch" });
    const second = await app.inject({ method: "GET", url: "/api/public/discovery" });
    expect(second.json().data.paths).toEqual(paths);
    expect(await PublicLink.countDocuments({ kind: "location", targetId: location._id })).toBe(1);
    const detail = await app.inject({ method: "GET", url: `/api/public/locations/${slug}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).not.toHaveProperty("upiVpa");
    expect(detail.json().data).not.toHaveProperty("onlineBookingSafetyBuffer");
    expect(detail.body).not.toContain("tenants/private");
    const profile = await app.inject({ method: "GET", url: `/api/public/doctors/${doctorSlug}/profile` });
    expect(profile.json().data.imageUrl).toBeNull();
  });

  it("hides unpublished branches from detail, directory, doctor context, slots and QR registration", async () => {
    const slug = await publicSlug("location", hidden.id, hidden.name);
    const doctorSlug = await publicSlug("doctor", doctor.id, doctor.name);
    for (const url of [`/api/public/locations/${slug}`, `/api/public/doctors/${doctorSlug}/profile?location=${slug}`]) expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    const directory = await app.inject({ method: "GET", url: "/api/public/locations" });
    expect(directory.json().data.some((item: any) => item.id === hidden.id)).toBe(false);
    expect(await canCreateLocationBooking(hidden.id, true)).toBe(false);
    expect(await canCreateLocationBooking(hidden.id)).toBe(true);
    const slots = await app.inject({ method: "GET", url: `/api/public/doctors/${doctor.id}/slots?locationId=${hidden.id}&date=2026-10-09` });
    expect(slots.statusCode).toBe(409);
    const qr = await app.inject({ method: "POST", url: "/api/public/join-queue", payload: { locationId: hidden.id, doctorId: doctor.id, name: "Visitor", phone: "9876501122" } });
    expect(qr.statusCode).toBe(404);
  });

  it("omits disabled doctors even when their user and assignment remain active", async () => {
    await Doctor.updateOne({ userId: doctor._id }, { isActive: false });
    try {
      const doctorSlug = await publicSlug("doctor", doctor.id, doctor.name);
      expect((await app.inject({ method: "GET", url: `/api/public/doctors/${doctorSlug}/profile` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/public/doctors/${doctor.id}/slots?locationId=${location.id}&date=2026-10-09` })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/public/join-queue", payload: { locationId: location.id, doctorId: doctor.id, name: "Visitor", phone: "9876501133" } })).statusCode).toBe(400);
      const discovery = await app.inject({ method: "GET", url: "/api/public/discovery" });
      expect(discovery.json().data.paths.every((path: string) => !path.startsWith("/doctor/"))).toBe(true);
    } finally { await Doctor.updateOne({ userId: doctor._id }, { isActive: true }); }
  });


  it("rejects missing or foreign assignments instead of generating default slots", async () => {
    const unassigned = await User.create({ name: "Unassigned Doctor", role: "doctor", email: "unassigned-discovery@example.test" });
    const slots = (id: string) => app.inject({ method: "GET", url: "/api/public/doctors/" + id + "/slots?locationId=" + location.id + "&date=2026-10-09" });
    expect((await slots(unassigned.id)).statusCode).toBe(409);
    const foreign = await DoctorAssignment.create({ doctorId: unassigned._id, locationId: location._id, organizationId: other._id, workingHours: "{}" });
    try {
      expect((await slots(unassigned.id)).statusCode).toBe(409);
      const directory = await app.inject({ method: "GET", url: "/api/public/locations" });
      expect(directory.json().data.find((item: any) => item.id === location.id).doctorsSummary.some((item: any) => item.id === unassigned.id)).toBe(false);
    } finally { await DoctorAssignment.deleteOne({ _id: foreign._id }); }
  });

  it("retains an unchanged legacy logo on unrelated edits while keeping it out of public responses", async () => {
    const logo = "tenants/private/legacy-logo.png";
    const legacy = await Location.create({ organizationId: org._id, name: "Legacy Logo Branch", city: "Surat", logo });
    try {
      const updated = await app.inject({ method: "PUT", url: "/api/onboarding/locations/" + legacy.id, headers: ownerHeaders, payload: { name: "Renamed Legacy Branch", city: legacy.city, logo } });
      expect(updated.statusCode, updated.body).toBe(200);
      expect((await Location.findById(legacy._id))?.logo).toBe(logo);
      const slug = await publicSlug("location", legacy.id, legacy.name);
      expect((await app.inject({ method: "GET", url: "/api/public/locations/" + slug })).body).not.toContain(logo);
    } finally { await Location.deleteOne({ _id: legacy._id }); }
  });

  it("lets the owner change publication and rejects a cross-tenant edit", async () => {
    const foreign = await Location.create({ organizationId: other._id, name: "Foreign Branch", city: "Surat" });
    const denied = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${foreign.id}`, headers: ownerHeaders, payload: { name: foreign.name, city: "Surat", isPublished: false } });
    expect(denied.statusCode, denied.body).toBe(404);
    expect((await Location.findById(foreign._id))?.isPublished).toBe(true);
    const update = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${hidden.id}`, headers: ownerHeaders, payload: { name: hidden.name, city: "Surat", isPublished: true } });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json().data.isPublished).toBe(true);
    await Location.updateOne({ _id: hidden._id }, { isPublished: false });
    const invalid = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${hidden.id}`, headers: ownerHeaders, payload: { name: hidden.name, city: "Surat", isPublished: "invalid" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("excludes inactive organizations from every public organization representation", async () => {
    await Organization.updateOne({ _id: org._id }, { status: "inactive" });
    try {
      const discovery = await app.inject({ method: "GET", url: "/api/public/discovery" });
      expect(discovery.json().data.paths.some((path: string) => path.includes("published-branch"))).toBe(false);
      expect((await app.inject({ method: "GET", url: `/api/public/organizations/${org.id}` })).statusCode).toBe(404);
      const list = await app.inject({ method: "GET", url: "/api/public/organizations" });
      expect(list.json().data.some((item: any) => item.id === org.id)).toBe(false);
    } finally { await Organization.updateOne({ _id: org._id }, { status: "active" }); }
  });

  it("lets owners unpublish after expiry without allowing unrelated or foreign writes", async () => {
    await canCreateLocationBooking(location.id);
    const subscription = await Subscription.findOne({ organizationId: org._id });
    const status = subscription!.status;
    await Subscription.updateOne({ _id: subscription!._id }, { status: "cancelled" });
    try {
      const update = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}/publication`, headers: ownerHeaders, payload: { isPublished: false } });
      expect(update.statusCode, update.body).toBe(200);
      const extra = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}/publication`, headers: ownerHeaders, payload: { isPublished: true, name: "Unauthorized edit" } });
      expect(extra.statusCode).toBe(200); // Fastify strips additional fields; only publication changes.
      expect((await Location.findById(location._id))!.name).not.toBe("Unauthorized edit");
      const foreign = await Location.findOne({ organizationId: other._id });
      const denied = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${foreign!.id}/publication`, headers: ownerHeaders, payload: { isPublished: false } });
      expect(denied.statusCode).toBe(404);
    } finally {
      await Subscription.updateOne({ _id: subscription!._id }, { status });
      await Location.updateOne({ _id: location._id }, { isPublished: true });
    }
  });

  it("paginates the complete catalog and rejects malformed cursors", async () => {
    await Location.insertMany(Array.from({ length: 205 }, (_, index) => ({ organizationId: other._id, name: `Catalog Branch ${index}`, city: "Surat" })));
    const first = await app.inject({ method: "GET", url: "/api/public/discovery" });
    const cursor = first.json().data.nextCursor;
    expect(cursor).toMatch(/^[a-f0-9]{24}$/);
    const second = await app.inject({ method: "GET", url: `/api/public/discovery?cursor=${cursor}` });
    expect(second.json().data.nextCursor).toBeNull();
    const all = [...first.json().data.paths, ...second.json().data.paths].filter((path: string) => path.startsWith("/browse/"));
    expect(new Set(all).size).toBe(207);
    expect((await app.inject({ method: "GET", url: "/api/public/discovery?cursor=invalid" })).statusCode).toBe(400);
  });
});
