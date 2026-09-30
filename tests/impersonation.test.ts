import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { SaaSConfig } from "../models/SaaSConfig.ts";
import { Subscription } from "../models/Subscription.ts";
import crypto from "node:crypto";

describe("Root Superadmin Impersonation Engine Tests", () => {
  let rootAccessToken: string;
  let rootUserId: string;
  let rootEmail: string;

  let testOrgId: string;
  let doctorUserId: string;
  let doctorEmail: string;
  let adminUserId: string;
  let adminAccessToken: string;
  let paidPlanId: string;

  beforeAll(async () => {
    // 1. Create Root User
    rootEmail = `root_impersonate_${Date.now()}@platform.internal`;
    const password = "Password123!";
    const rootUser = await (User as any).create({
      email: rootEmail,
      name: "Root Test Platform Admin",
      password: await bcrypt.hash(password, 10),
      role: "root",
    });
    rootUserId = (rootUser as any)._id.toString();

    // 2. Create Tenant Org & Doctor User
    const org = await (Organization as any).create({
      name: "Impersonation Test Clinic",
      email: `clinic_${Date.now()}@platform.internal`,
      phone: "+919876543210",
      city: "Ahmedabad",
      plan: "pro",
    });
    testOrgId = (org as any)._id.toString();

    doctorEmail = `dr_smith_${Date.now()}@platform.internal`;
    const doctorUser = await (User as any).create({
      email: doctorEmail,
      name: "Dr. Smith Test",
      password: await bcrypt.hash(password, 10),
      role: "doctor",
      organization_id: org._id,
    });
    doctorUserId = (doctorUser as any)._id.toString();

    await OrgMember.create({
      userId: doctorUser._id,
      organizationId: org._id,
      role: "doctor",
    });
    const adminUser = await (User as any).create({
      email: `admin_billing_${Date.now()}@platform.internal`,
      name: "Organization Billing Admin",
      password: await bcrypt.hash(password, 10),
      role: "admin", organization_id: org._id,
    });
    adminUserId = adminUser.id;
    await OrgMember.create({ userId: adminUser._id, organizationId: org._id, role: "admin" });
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: adminUser.email, password } });
    adminAccessToken = adminLogin.cookies.find((c) => c.name === "access_token")?.value || "";
    await SaaSConfig.findOneAndUpdate({ key: "platform_config" }, {
      razorpayKeyId: "rzp_test_mock_impersonation", razorpayKeySecret: "mock_impersonation_secret",
      razorpayWebhookSecret: "mock_impersonation_webhook",
    }, { upsert: true });
    const paidPlan = await SaaSPlan.create({ name: "Billing Integration Pro", slug: `billing_impersonation_${Date.now()}`, description: "Billing context test", monthlyPrice: 499, annualPrice: 4999 });
    paidPlanId = paidPlan.id;

    // 3. Login as Root to get root cookies
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: rootEmail, password },
    });

    rootAccessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";
  });

  afterAll(async () => {
    await OrgMember.deleteMany({ organizationId: testOrgId });
    await User.deleteMany({ _id: { $in: [rootUserId, doctorUserId, adminUserId] } });
    await Organization.deleteMany({ _id: testOrgId });
    await SaaSPlan.deleteOne({ _id: paidPlanId });
  });

  it("should list organization members via GET /api/onboarding/organizations/:id/members", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/onboarding/organizations/${testOrgId}/members`,
      cookies: { access_token: rootAccessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.members).toBeDefined();
    expect(body.data.members.length).toBeGreaterThanOrEqual(1);

    const doc = body.data.members.find((m: any) => m.id === doctorUserId);
    expect(doc).toBeDefined();
    expect(doc.name).toBe("Dr. Smith Test");
    expect(doc.role).toBe("doctor");
  });

  it("uses the selected tenant for Root and the session tenant for admins, while denying doctors commercial billing", async () => {
    const rootSelected = await app.inject({ method: "GET", url: `/api/billing/subscription?organizationId=${testOrgId}`, cookies: { access_token: rootAccessToken } });
    expect(rootSelected.statusCode, rootSelected.body).toBe(200);
    expect(rootSelected.json().data.summary).toBeDefined();
    const rootUnselected = await app.inject({ method: "GET", url: "/api/billing/subscription", cookies: { access_token: rootAccessToken } });
    expect(rootUnselected.statusCode).toBe(400);
    const admin = await app.inject({ method: "GET", url: "/api/billing/subscription", cookies: { access_token: adminAccessToken } });
    expect(admin.statusCode, admin.body).toBe(200);
    const doctorLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: doctorEmail, password: "Password123!" } });
    const doctorToken = doctorLogin.cookies.find((c) => c.name === "access_token")?.value || "";
    const forbidden = await app.inject({ method: "POST", url: "/api/billing/switch-plan", payload: { planId: "000000000000000000000001" }, cookies: { access_token: doctorToken } });
    expect(forbidden.statusCode).toBe(403);
    const forbiddenPlanEdit = await app.inject({ method: "PUT", url: `/api/organizations/${testOrgId}`, payload: { plan: "enterprise" }, cookies: { access_token: adminAccessToken } });
    expect(forbiddenPlanEdit.statusCode).toBe(400);
    const impersonate = await app.inject({ method: "POST", url: "/api/auth/impersonate", payload: { organizationId: testOrgId, role: "admin" }, cookies: { access_token: rootAccessToken } });
    expect(impersonate.statusCode, impersonate.body).toBe(200);
    const impersonatedToken = impersonate.cookies.find((c) => c.name === "access_token")?.value || "";
    const impersonatedBilling = await app.inject({ method: "GET", url: "/api/billing/subscription", cookies: { access_token: impersonatedToken } });
    expect(impersonatedBilling.statusCode, impersonatedBilling.body).toBe(200);

    const checkoutPayload = { planId: paidPlanId, billingCycle: "monthly" };
    const rootCheckout = await app.inject({ method: "POST", url: "/api/billing/checkout", payload: { ...checkoutPayload, organizationId: testOrgId }, cookies: { access_token: rootAccessToken } });
    expect(rootCheckout.statusCode, rootCheckout.body).toBe(200);
    const adminCheckout = await app.inject({ method: "POST", url: "/api/billing/checkout", payload: checkoutPayload, cookies: { access_token: adminAccessToken } });
    expect(adminCheckout.statusCode, adminCheckout.body).toBe(200);
    const impersonatedCheckout = await app.inject({ method: "POST", url: "/api/billing/checkout", payload: checkoutPayload, cookies: { access_token: impersonatedToken } });
    expect(impersonatedCheckout.statusCode, impersonatedCheckout.body).toBe(200);
    const orderId = rootCheckout.json().data.orderId;
    const paymentId = "pay_root_context_test";
    const razorpaySignature = crypto.createHmac("sha256", "mock_impersonation_secret").update(`${orderId}|${paymentId}`).digest("hex");
    const rootVerification = await app.inject({ method: "POST", url: "/api/billing/verify-payment", payload: {
      organizationId: testOrgId, razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature,
    }, cookies: { access_token: rootAccessToken } });
    expect(rootVerification.statusCode, rootVerification.body).toBe(200);
    expect(rootVerification.json().data.success).toBe(true);
    const subscriptionId = (await Subscription.findOne({ organizationId: testOrgId }))?.id;
    const missingReason = await app.inject({ method: "POST", url: `/api/admin/billing/subscriptions/${subscriptionId}/activate`, payload: { planSlug: "starter" }, cookies: { access_token: rootAccessToken } });
    expect(missingReason.statusCode).toBe(400);
  });

  it("shows the same paid entitlement and primary admin in the organization list", async () => {
    const response = await app.inject({ method: "GET", url: "/api/organizations", cookies: { access_token: rootAccessToken } });
    expect(response.statusCode, response.body).toBe(200);
    const organization = response.json().data.find((item: any) => item.id === testOrgId);
    expect(organization.primaryAdmin.name).toBe("Organization Billing Admin");
    expect(organization.subscriptionSummary.basis).toBe("paid");
    expect(organization.subscriptionSummary.paymentStatus).toBe("created");
    expect(organization.subscriptionSummary.bookingAvailable).toBe(true);
  });

  it("rejects impersonating a user into an unrelated organization context", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/impersonate",
      payload: { userId: doctorUserId, organizationId: "000000000000000000000001" },
      cookies: { access_token: rootAccessToken },
    });
    expect(response.statusCode).toBe(403);
  });

  it("records an attributed manual grant without describing it as paid", async () => {
    const subscription = await Subscription.findOne({ organizationId: testOrgId });
    const plan = await SaaSPlan.findById(paidPlanId);
    const response = await app.inject({
      method: "POST", url: `/api/admin/billing/subscriptions/${subscription!.id}/activate`,
      payload: { planSlug: plan!.slug, billingCycle: "monthly", reason: "Approved commercial exception" },
      cookies: { access_token: rootAccessToken },
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = await Subscription.findById(subscription!.id);
    expect(updated?.entitlementSource).toBe("manual");
    expect(updated?.manualGrantReason).toBe("Approved commercial exception");
    expect(updated?.manualGrantedBy?.toString()).toBe(rootUserId);
    expect((await Organization.findById(testOrgId))?.plan).toBe(plan!.slug);
  });

  it("should fetch global users via GET /api/admin/users", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/users?role=doctor&q=Smith`,
      cookies: { access_token: rootAccessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.users).toBeDefined();
    const found = body.data.users.find((u: any) => u.id === doctorUserId);
    expect(found).toBeDefined();
    expect(found.role).toBe("doctor");
    expect(found.organizationName).toBe("Impersonation Test Clinic");
  });

  it("should fetch platform hierarchy via GET /api/admin/hierarchy", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hierarchy",
      cookies: { access_token: rootAccessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.organizations).toBeDefined();
    expect(body.data.summary).toBeDefined();
    const targetOrg = body.data.organizations.find((o: any) => o.id === testOrgId);
    expect(targetOrg).toBeDefined();
    expect(targetOrg.name).toBe("Impersonation Test Clinic");
  });

  it("should allow root superadmin to impersonate a doctor without password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/impersonate",
      cookies: { access_token: rootAccessToken },
      payload: { userId: doctorUserId },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe(doctorUserId);
    expect(body.data.user.role).toBe("doctor");
    expect(body.data.user.impersonatedBy).toBeDefined();
    expect(body.data.user.impersonatedBy.id).toBe(rootUserId);
    expect(body.data.user.impersonatedBy.originalRole).toBe("root");

    const impersonatedToken = (res.cookies as any[]).find((c: any) => c.name === "access_token")?.value || "";
    expect(impersonatedToken).toBeTruthy();

    // Verify GET /api/auth/me reflects impersonated doctor identity with impersonatedBy flag
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `access_token=${impersonatedToken}` },
    });

    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body);
    expect(meBody.data.user.role).toBe("doctor");
    expect(meBody.data.user.name).toBe("Dr. Smith Test");
    expect(meBody.data.user.impersonatedBy.originalRole).toBe("root");
  });

  it("should stop impersonation and return back to Root Superadmin", async () => {
    // 1. Impersonate doctor first
    const impRes = await app.inject({
      method: "POST",
      url: "/api/auth/impersonate",
      cookies: { access_token: rootAccessToken },
      payload: { userId: doctorUserId },
    });
    const impToken = (impRes.cookies as any[]).find((c: any) => c.name === "access_token")?.value || "";

    // 2. Stop impersonation using the impersonated token
    const stopRes = await app.inject({
      method: "POST",
      url: "/api/auth/stop-impersonation",
      headers: { cookie: `access_token=${impToken}` },
    });

    expect(stopRes.statusCode).toBe(200);
    const stopBody = JSON.parse(stopRes.body);
    expect(stopBody.success).toBe(true);
    expect(stopBody.data.user.role).toBe("root");
    expect(stopBody.data.user.id).toBe(rootUserId);
    expect(stopBody.data.user.impersonatedBy).toBeFalsy();

    const restoredToken = (stopRes.cookies as any[]).find((c: any) => c.name === "access_token")?.value || "";
    expect(restoredToken).toBeTruthy();

    // 3. Confirm GET /api/auth/me with restored token shows Root Superadmin
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `access_token=${restoredToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body);
    expect(meBody.data.user.role).toBe("root");
    expect(meBody.data.user.email).toBe(rootEmail);
  });

  it("should reject non-root users from attempting impersonation", async () => {
    // Login as doctor
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: doctorEmail, password: "Password123!" },
    });
    const doctorToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // Doctor attempts to impersonate
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/impersonate",
      cookies: { access_token: doctorToken },
      payload: { userId: rootUserId },
    });

    expect(res.statusCode).toBe(403);
  });
});
