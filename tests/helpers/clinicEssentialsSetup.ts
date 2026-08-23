import type { FastifyInstance } from "fastify";

export interface OnboardedOrgContext {
  orgId: string;
  adminCookies: string[];
}

export interface CeOrgFixture extends OnboardedOrgContext {
  clinicId: string;
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
  const orgRes = await app.inject({
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

  const body = JSON.parse(orgRes.body);
  const adminCookies = (orgRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  const orgId = body.data.organization.id as string;

  return { orgId, adminCookies };
}

export async function createTestClinic(
  app: FastifyInstance,
  adminCookies: string[],
  name = "Test Clinic",
  city = "Chennai",
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboarding/clinics",
    headers: cookieHeader(adminCookies),
    payload: { name, city },
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

export async function assignDoctorToClinic(
  app: FastifyInstance,
  adminCookies: string[],
  doctorId: string,
  clinicId: string,
  fees = 300,
) {
  await app.inject({
    method: "POST",
    url: "/api/onboarding/doctors/assignments",
    headers: cookieHeader(adminCookies),
    payload: { doctorId, clinicId, fees, workingHours: "09:00 - 17:00" },
  });
}

/** Org + clinic + doctor assignment — common CE test fixture. */
export async function setupCeOrgFixture(
  app: FastifyInstance,
  label: string,
  clinicName = "Test Clinic",
): Promise<CeOrgFixture> {
  const { orgId, adminCookies } = await onboardTestOrganization(app, label);
  const clinicId = await createTestClinic(app, adminCookies, clinicName);
  const doctorId = await createTestDoctor(app, adminCookies, label);
  await assignDoctorToClinic(app, adminCookies, doctorId, clinicId);
  return { orgId, adminCookies, clinicId, doctorId };
}

export async function bookWalkInAppointment(
  app: FastifyInstance,
  adminCookies: string[],
  payload: {
    clinicId: string;
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
