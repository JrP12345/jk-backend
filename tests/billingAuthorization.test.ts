import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { User } from "../models/User.ts";
import { Role } from "../models/Role.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { SaaSConfig } from "../models/SaaSConfig.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";

describe("SaaS billing tenant authorization", () => {
  let orgA: string;
  let orgB: string;
  let planId: string;
  let rootCookie: string;
  let adminCookie: string;
  let staffCookie: string;
  let impersonatedCookie: string;

  beforeAll(async () => {
    const a = await Organization.create({ name: "Billing Auth A", city: "Delhi" });
    const b = await Organization.create({ name: "Billing Auth B", city: "Mumbai" });
    orgA = a.id; orgB = b.id;
    await Role.create({ name: "admin", permissions: ["MANAGE_ORGANIZATION"] });
    await Role.create({ name: "receptionist", permissions: ["MANAGE_BILLING"] });
    const root = await User.create({ name: "Billing Root", email: "billing-root@test.local", password: "Password123!", role: "root" });
    const admin = await User.create({ name: "Billing Admin", email: "billing-admin@test.local", password: "Password123!", role: "admin" });
    const staff = await User.create({ name: "Billing Staff", email: "billing-staff@test.local", password: "Password123!", role: "receptionist" });
    const cookie = async (user: any, role: string, organization_id?: string, impersonatedBy?: any) =>
      `access_token=${(await fixtureAccessToken({ id: user.id, email: user.email, role, organization_id, impersonatedBy }))}`;
    rootCookie = (await cookie(root, "root"));
    adminCookie = (await cookie(admin, "admin", orgA));
    staffCookie = (await cookie(staff, "receptionist", orgA));
    impersonatedCookie = (await cookie(staff, "receptionist", orgA, { id: root.id, email: root.email, name: root.name, originalRole: "root" }));
    const plan = await SaaSPlan.create({ name: "Billing Auth Pro", slug: "billing_auth_pro", description: "Paid", monthlyPrice: 499, annualPrice: 4999 });
    planId = plan.id;
    await SaaSConfig.create({ key: "platform_config", razorpayKeyId: "rzp_test_auth_key", razorpayKeySecret: "auth_test_secret", razorpayWebhookSecret: "auth_webhook_secret", isLiveMode: false });
  });

  const checkout = (cookie: string, organizationId?: string) => app.inject({
    method: "POST", url: "/api/billing/checkout", headers: { cookie },
    payload: { planId, billingCycle: "monthly", ...(organizationId ? { organizationId } : {}) },
  });

  it("lets Root select a target and keeps Root's organization authoritative", async () => {
    const result = await checkout(rootCookie, orgB);
    expect(result.statusCode).toBe(200);
    expect(await SubscriptionPayment.countDocuments({ organizationId: orgB })).toBe(1);
  });

  it("lets an organization admin pay for its own tenant", async () => {
    const result = await checkout(adminCookie);
    expect(result.statusCode).toBe(200);
    expect(await SubscriptionPayment.countDocuments({ organizationId: orgA })).toBe(1);
  });

  it("rejects staff and a mismatched tenant", async () => {
    expect((await checkout(staffCookie)).statusCode).toBe(403);
    expect((await checkout(adminCookie, orgB)).statusCode).toBe(403);
    expect(await SubscriptionPayment.countDocuments({ organizationId: orgB })).toBe(1);
    const history = await app.inject({ method: "GET", url: `/api/billing/payment-attempts?organizationId=${orgB}`, headers: { cookie: adminCookie } });
    expect(history.statusCode).toBe(403);
  });

  it("scopes Root impersonation to the impersonated organization", async () => {
    expect((await checkout(impersonatedCookie)).statusCode).toBe(200);
    expect((await checkout(impersonatedCookie, orgB)).statusCode).toBe(403);
    expect(await SubscriptionPayment.countDocuments({ organizationId: orgA })).toBe(1);
  });

  it("persists invoice contact details only for the authorized organization", async () => {
    const payload = { gstin: "22AAAAA0000A1Z5", billingEmail: "billing-a@test.local", billingAddress: "Delhi office" };
    const save = (cookie: string, organizationId?: string) => app.inject({ method: "PUT", url: "/api/billing/details",
      headers: { cookie }, payload: { ...payload, ...(organizationId ? { organizationId } : {}) } });
    expect((await save(staffCookie)).statusCode).toBe(403);
    expect((await save(adminCookie, orgB)).statusCode).toBe(403);
    expect((await save(adminCookie)).statusCode).toBe(200);
    const own = await app.inject({ method: "GET", url: "/api/billing/details", headers: { cookie: adminCookie } });
    expect(own.json().data).toEqual(payload);
    const other = await app.inject({ method: "GET", url: `/api/billing/details?organizationId=${orgB}`, headers: { cookie: rootCookie } });
    expect(other.json().data.billingEmail).toBe("");
    expect((await save(impersonatedCookie, orgB)).statusCode).toBe(403);
  });
});
