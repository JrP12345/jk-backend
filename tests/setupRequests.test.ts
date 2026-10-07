import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import app from "../index.ts";
import { User } from "../models/User.ts";
import { SetupRequest } from "../models/SetupRequest.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";

const request = () => ({ requestKey: crypto.randomUUID(), organization: "Care Clinic", city: "Surat", name: "Asha", email: "asha@example.test", planSlug: "" });
async function headers(role: string, impersonatedBy?: { id: string; name: string; email: string; originalRole: string }) {
  const user = await User.create({ name: role, email: `${crypto.randomUUID()}@example.test`, role });
  return { authorization: `Bearer ${(await fixtureAccessToken({ id: user.id, email: user.email!, role, ...(impersonatedBy ? { impersonatedBy } : {}) }))}` };
}
beforeEach(async () => { await SetupRequest.deleteMany({}); });
describe("Saved setup requests", () => {
  it("accepts an anonymous request once across retries and returns no contact details", async () => {
    const payload = request();
    const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/public/setup-requests", payload })));
    expect(results.every(result => result.statusCode === 201)).toBe(true);
    expect(results[0].json().data).toBeNull();
    expect(await SetupRequest.countDocuments()).toBe(1);
    expect(await SetupRequest.findOne()).toMatchObject({ organization: payload.organization, email: payload.email, status: "new", createdAt: expect.any(Date) });
  });
  it("validates practice details, rejects unavailable plans and keeps the configured plan name", async () => {
    for (const payload of [{ ...request(), email: "invalid" }, { ...request(), name: "   " }, { ...request(), planSlug: "unknown" }]) {
      expect((await app.inject({ method: "POST", url: "/api/public/setup-requests", payload })).statusCode).toBe(400);
    }
    const plan = await SaaSPlan.create({ name: "Configured Practice", slug: `setup-${crypto.randomUUID()}`, description: "Practice", status: "active" });
    const result = await app.inject({ method: "POST", url: "/api/public/setup-requests", payload: { ...request(), planSlug: plan.slug } });
    expect(result.statusCode, result.body).toBe(201);
    expect(await SetupRequest.findOne()).toMatchObject({ planSlug: plan.slug, planName: plan.name });
  });
  it("restricts reading and updating contact details to the platform root account", async () => {
    await app.inject({ method: "POST", url: "/api/public/setup-requests", payload: request() });
    const root = await headers("root");
    for (const session of [undefined, await headers("patient"), await headers("admin"), await headers("admin", { id: "111111111111111111111111", name: "Root", email: "root@example.test", originalRole: "root" })]) {
      const response = await app.inject({ method: "GET", url: "/api/admin/setup-requests", headers: session });
      expect([401, 403]).toContain(response.statusCode);
    }
    const inbox = await app.inject({ method: "GET", url: "/api/admin/setup-requests?status=new", headers: root });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const entry = inbox.json().data.items[0];
    expect(entry.email).toBe("asha@example.test");
    expect(entry.requestKey).toBeUndefined();
    expect((await app.inject({ method: "PATCH", url: `/api/admin/setup-requests/${entry.id}`, headers: await headers("admin"), payload: { status: "contacted" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/setup-requests/${entry.id}`, headers: root, payload: { status: "contacted" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/setup-requests?status=new", headers: root })).json().data.items).toEqual([]);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/setup-requests/${entry.id}`, headers: root, payload: { status: "activated" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/setup-requests/${crypto.randomBytes(12).toString("hex")}`, headers: root, payload: { status: "closed" } })).statusCode).toBe(404);
  });
});
