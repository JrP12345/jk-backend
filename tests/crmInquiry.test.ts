import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Location } from "../models/Location.ts";
import { Inquiry } from "../models/Inquiry.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { createAuthSession } from "../utilities/helpers.ts";

async function fixture(role = "admin") {
  const org = await Organization.create({ name: "Inquiry clinic", city: "Pune" });
  const location = await Location.create({ name: "Inquiry branch", city: "Pune", organizationId: org.id });
  const actor = await User.create({ name: "Inquiry staff", email: `${crypto.randomUUID()}@example.test`, role });
  await OrgMember.create({ userId: actor.id, organizationId: org.id, role, locationAccess: { mode: "selected", locationIds: [location.id] } });
  const session = await createAuthSession({ id: actor.id, email: actor.email!, role, organization_id: org.id }, { organizationId: org.id, workspaceRole: role });
  const cookies = { access_token: session.accessToken };
  const input = { locationId: location.id, callerName: "Caller", source: "unknown", nextAction: { kind: "review", dueAt: new Date(Date.now() + 3600000).toISOString() }, clientRequestId: crypto.randomUUID() };
  const create = (extra: object = {}) => app.inject({ method: "POST", url: "/api/crm/inquiries", cookies, payload: { ...input, ...extra } });
  return { org, location, actor, cookies, input, create };
}
describe("Inquiry capture and progress", () => {
  it("captures anonymous inquiries atomically and restores concurrent requests without creating patient identities", async () => {
    const f = await fixture();
    const responses = await Promise.all([f.create({ callerName: "", note: "Asked about service opening hours" }), f.create({ callerName: "", note: "Asked about service opening hours" })]);
    expect(responses.map(row => row.statusCode).sort()).toEqual([200, 201]);
    const id = responses[0].json().data.id;
    expect(responses[1].json().data.id).toBe(id);
    expect(responses[0].json().data).toMatchObject({ callerName: "", source: "unknown", sourceEvidence: "unknown", ownerId: f.actor.id, status: "open" });
    expect(await Patient.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await Inquiry.countDocuments({ organizationId: f.org.id })).toBe(1);
    const details = await app.inject({ method: "GET", url: `/api/crm/inquiries/${id}`, cookies: f.cookies });
    expect(details.json().data.activities[0].note).toBe("Asked about service opening hours");
    expect(JSON.stringify(details.json())).not.toContain("enc:v1:");
    expect((await f.create({ callerName: "Different" })).statusCode).toBe(409);
  });
  it("allows repeated caller inquiries without treating shared phone as a duplicate identity", async () => {
    const f = await fixture();
    const one = await f.create({ phone: "9876543210", source: "phone" });
    const two = await f.create({ phone: "9876543210", clientRequestId: crypto.randomUUID() });
    expect(one.statusCode, one.body).toBe(201); expect(two.statusCode, two.body).toBe(201);
    expect(one.json().data.id).not.toBe(two.json().data.id);
    expect(one.json().data.sourceEvidence).toBe("staff_reported");
    const list = await app.inject({ method: "GET", url: "/api/crm/inquiries?search=9876543210&owner=mine", cookies: f.cookies });
    expect(list.json().data.items).toHaveLength(2);
  });
  it("closes with an outcome, requires a fresh action to reopen, and rejects stale/concurrent updates", async () => {
    const f = await fixture(), created = await f.create(), id = created.json().data.id;
    const update = (payload: object) => app.inject({ method: "PATCH", url: `/api/crm/inquiries/${id}`, cookies: f.cookies, payload: { clientRequestId: crypto.randomUUID(), ...payload } });
    expect((await update({ expectedRevision: 0, status: "closed" })).statusCode).toBe(400);
    const closed = await update({ expectedRevision: 0, status: "closed", closeReason: "resolved" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().data.inquiry.revision).toBe(1);
    expect((await update({ expectedRevision: 1, status: "open" })).statusCode).toBe(400);
    const competing = await Promise.all([update({ expectedRevision: 1, status: "open", nextAction: f.input.nextAction }), update({ expectedRevision: 1, status: "open", nextAction: f.input.nextAction })]);
    expect(competing.map(row => row.statusCode).sort()).toEqual([200, 409]);
    expect(await CrmActivity.countDocuments({ organizationId: f.org.id, inquiryId: id })).toBe(3);
    expect((await Inquiry.findById(id))?.closeReason).toBeUndefined();
  });
  it("fails closed across tenants and branches and only assigns eligible staff", async () => {
    const f = await fixture("receptionist"), created = await f.create(), id = created.json().data.id;
    const other = await fixture();
    expect((await app.inject({ method: "GET", url: `/api/crm/inquiries/${id}`, cookies: other.cookies })).statusCode).toBe(404);
    const ungranted = await Location.create({ name: "Other branch", city: "Pune", organizationId: f.org.id });
    expect((await f.create({ locationId: ungranted.id, clientRequestId: crypto.randomUUID() })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/crm/inquiries/${id}`, cookies: f.cookies, payload: { clientRequestId: crypto.randomUUID(), expectedRevision: 0, ownerId: other.actor.id } })).statusCode).toBe(403);
    const candidates = await app.inject({ method: "GET", url: `/api/crm/assignees?locationId=${f.location.id}`, cookies: f.cookies });
    expect(candidates.json().data.items.map((row: any) => row.id)).toEqual([f.actor.id]);
    expect(JSON.stringify(candidates.json())).not.toContain("@example.test");
  });
  it("rolls back inquiry, activity and receipt on audit failure", async () => {
    const f = await fixture(), spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Audit unavailable"));
    try { expect((await f.create()).statusCode).toBe(503); } finally { spy.mockRestore(); }
    expect(await Inquiry.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await CrmActivity.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: f.input.clientRequestId })).toBe(0);
    expect((await f.create()).statusCode).toBe(201);
  });
  it("paginates only authorized administrative inquiries", async () => {
    const f = await fixture();
    await Inquiry.insertMany(Array.from({ length: 24 }, (_, index) => ({ organizationId: f.org.id, locationId: f.location.id, createdBy: f.actor.id, callerName: `Caller ${index}`,
      nextAction: { kind: "review", dueAt: new Date() }, status: "open" })));
    const first = await app.inject({ method: "GET", url: "/api/crm/inquiries", cookies: f.cookies });
    expect(first.json().data.items).toHaveLength(20);
    const second = await app.inject({ method: "GET", url: `/api/crm/inquiries?cursor=${first.json().data.nextCursor}`, cookies: f.cookies });
    expect(second.json().data.items).toHaveLength(4);
    expect(new Set([...first.json().data.items, ...second.json().data.items].map(row => row.id)).size).toBe(24);
  });
});
