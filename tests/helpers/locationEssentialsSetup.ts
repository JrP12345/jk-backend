import { provisioningFixtureHeaders, provisionedAdminCookies } from "./provisioningFixture.ts";
import type { FastifyInstance } from "fastify";

export interface OnboardedOrgContext {
  orgId: string;
  adminCookies: string[];
}

export interface CeOrgFixture extends OnboardedOrgContext {
  locationId: string;
  doctorId: string;
}

export function cookieHeader(cookies: string[]): { cookie: string } {
  return { cookie: cookies.join("; ") };
}

/** Create a test organization and return admin session cookies. */
export async function onboardTestOrganization(
  app: FastifyInstance,
  label: string,
): Promise<OnboardedOrgContext> {
  const suffix = `${label}-${Date.now()}`;
  const orgRes = await app.inject({ headers: await provisioningFixtureHeaders(),
    method: "POST",
    url: "/api/onboarding/organization",
    payload: {
      org_name: `${label} Org ${suffix}`,
      city: "Chennai",
      admin_name: `${label} Admin`,
      admin_email: `${suffix}@test.com`,
      admin_password: "Password123!",
    },
  });

  if (orgRes.statusCode !== 201) throw new Error(`Organization fixture failed: ${orgRes.statusCode} ${orgRes.body}`);
  const body = JSON.parse(orgRes.body);
  const adminCookies = (await provisionedAdminCookies(orgRes));
  const orgId = body.data.organization.id as string;

  return { orgId, adminCookies };
}

export async function createTestLocation(
  app: FastifyInstance,
  adminCookies: string[],
  name = "Test Clinic",
  city = "Chennai",
) {
  const res = await reuseOnboardingLocation(app, {
    headers: cookieHeader(adminCookies), payload: { name, city }
  });
  return JSON.parse(res.body).data.id as string;
}

export async function createTestDoctor(
  app: FastifyInstance,
  adminCookies: string[],
  label: string,
) {
  const suffix = `${label}-${Date.now()}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/onboarding/doctor",
    headers: cookieHeader(adminCookies),
    payload: {
      name: `Dr ${label}`,
      email: `dr-${suffix}@test.com`,
      password: "Password123!",
      specialization: "General",
    },
  });
  return JSON.parse(res.body).data.id as string;
}

export async function assignDoctorToLocation(
  app: FastifyInstance,
  adminCookies: string[],
  doctorId: string,
  locationId: string,
  fees = 300,
) {
  await app.inject({
    method: "POST",
    url: "/api/onboarding/doctors/assignments",
    headers: cookieHeader(adminCookies),
    payload: {
      doctorId,
      locationId,
      fees,
      workingHours: JSON.stringify({ all: { start: "00:00", end: "23:59" } }),
    },
  });
}

/** Org + location + doctor assignment — common CE test fixture. */
export async function setupCeOrgFixture(
  app: FastifyInstance,
  label: string,
  locationName = "Test Clinic",
): Promise<CeOrgFixture> {
  const { orgId, adminCookies } = await onboardTestOrganization(app, label);
  const locationId = await createTestLocation(app, adminCookies, locationName);
  const doctorId = await createTestDoctor(app, adminCookies, label);
  await assignDoctorToLocation(app, adminCookies, doctorId, locationId);
  return { orgId, adminCookies, locationId, doctorId };
}

export async function bookWalkInAppointment(
  app: FastifyInstance,
  adminCookies: string[],
  payload: {
    locationId: string;
    doctorId: string;
    patientId?: string;
    patientDetails?: Record<string, unknown>;
    appointmentTime?: string;
  },
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/appointments",
    headers: cookieHeader(adminCookies),
    payload: {
      appointmentTime: payload.appointmentTime || new Date().toISOString(),
      appointmentType: "walk-in",
      forceBooking: true,
      ...payload,
    },
  });
  const body = JSON.parse(res.body);
  return {
    statusCode: res.statusCode,
    body,
    appointmentId: body.data?.id as string | undefined,
    patientId: (body.data?.patientId as string | undefined) || payload.patientId,
  };
}

export async function loginTestUser(
  app: FastifyInstance,
  email: string,
  password = "Password123!",
): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  return (res.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
}

export async function createTestStaffMember(
  app: FastifyInstance,
  adminCookies: string[],
  payload: { name: string; email: string; role: string; password?: string },
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboarding/staff",
    headers: cookieHeader(adminCookies),
    payload: { password: "Password123!", ...payload },
  });
  return JSON.parse(res.body).data;
}

/** Configure the location provisioned by onboarding instead of consuming a second branch. */
export async function reuseOnboardingLocation(
  app: FastifyInstance,
  options: { headers: Record<string, string>; payload: Record<string, unknown> }
) {
  const listing = await app.inject({ method: "GET", url: "/api/onboarding/locations", headers: options.headers });
  if (listing.statusCode !== 200) throw new Error(`Clinic fixture listing failed: ${listing.statusCode} ${listing.body}`);
  const locations = JSON.parse(listing.body).data;
  if (!Array.isArray(locations) || locations.length !== 1) throw new Error("Fixture must reuse exactly one onboarding clinic");
  const response = await app.inject({
    method: "PUT", url: `/api/onboarding/locations/${locations[0].id}`,
    headers: options.headers, payload: options.payload
  });
  if (response.statusCode !== 200) throw new Error(`Clinic fixture update failed: ${response.statusCode} ${response.body}`);
  return response;
}
