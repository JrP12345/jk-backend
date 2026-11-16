import crypto from "node:crypto";
import mongoose from "mongoose";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { PharmacyOfflineChallenge, PharmacyOfflineDevice } from "../models/PharmacyOfflineDevice.ts";
import { PharmacyOfflineDeviceHistory } from "../models/PharmacyOfflineDeviceHistory.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Medicine } from "../models/Medicine.ts";
import { Invoice } from "../models/Invoice.ts";
import { Location } from "../models/Location.ts";
import { SERVICE_PUBLIC_KEY } from "../utilities/keys.ts";
import { allocateInvoiceNumber, allocatePharmacyInvoiceNumber, indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { enrollmentProofMessage, enrollOfflineDevice, createDeviceChallenge, type EnrollmentIntent } from "../services/PharmacyOfflineDeviceService.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const owner = () => fixture(["MANAGE_ORGANIZATION", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]);
const route = (f: Fixture, suffix = "") => `/api/pharmacy/locations/${f.locationId}/offline-device${suffix}`;
const get = (f: Fixture) => app.inject({ method: "GET", url: route(f), headers: f.headers });
const post = (f: Fixture, action: string, payload: object) => app.inject({ method: "POST", url: route(f, `/${action}`), headers: f.headers, payload });
const identity = () => { const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = pair.publicKey.export({ format: "jwk" }); return { pair, deviceId: crypto.randomUUID(), publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } }; };
const intent = (revision = 0): EnrollmentIntent => ({ expectedRevision: 0, expectedNumberingRevision: revision, expectedFinancialYear: indiaFinancialYear().label, count: 3, deviceName: "Synthetic counter PC", reviewReference: "Synthetic reviewed enrollment", confirmed: true });
async function prepare(f: Fixture, fields = intent(), device = identity()) {
  const challenge = await post(f, "challenge", { deviceId: device.deviceId, publicKey: device.publicKey }); expect(challenge.statusCode, challenge.body).toBe(200);
  const context = challenge.json().data;
  const proof = crypto.sign("sha256", Buffer.from(enrollmentProofMessage(context.context, fields)), { key: device.pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { input: { ...fields, challengeId: context.challengeId, proof }, device, context };
}
const evidence = (response: Awaited<ReturnType<typeof get>>) => JSON.parse(response.json().data.device.payload);
async function configure(f: Fixture, digits = 4) {
  const payload = { expectedRevision: 0, expectedFinancialYear: indiaFinancialYear().label, prefixTemplate: `P${crypto.randomBytes(2).toString("hex").toUpperCase()}/`, digits, resetPolicy: "continuous", nextNumber: digits === 1 ? 8 : 137, reviewReference: "Synthetic numbering review" };
  const result = await app.inject({ method: "PUT", url: `/api/pharmacy/locations/${f.locationId}/invoice-numbering`, headers: f.headers, payload }); expect(result.statusCode, result.body).toBe(200); return payload;
}

it("restricts all device actions to organization managers and authorized branches", async () => {
  const staff = await fixture(["PHARMACY_MANAGE_SETTINGS"]), f = await owner(), foreign = await owner();
  expect((await get(staff)).statusCode).toBe(403);
  for (const action of ["challenge", "enroll", "revoke", "cancel"]) expect((await post(staff, action, {})).statusCode).toBe(403);
  const response = await app.inject({ method: "GET", url: route(foreign), headers: f.headers }); expect([403, 404]).toContain(response.statusCode);
  expect((await app.inject({ method: "GET", url: route(f) })).statusCode).toBe(401);
});
it("reads status without creating identity or consuming invoice numbers", async () => {
  const f = await owner(), response = await get(f); expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store"); expect(response.json().data).toMatchObject({ locationId: f.locationId, organizationId: f.organizationId, device: null, checkoutEnabled: false, numberingRevision: 0 });
  expect(await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000001")).toBe(true);
});
it("reserves default numbers atomically, signs only numbering evidence and leaves online billing, stock and payments intact", async () => {
  const f = await owner(); await allocateInvoiceNumber(f.locationId);
  const value = await prepare(f), result = await post(f, "enroll", value.input); expect(result.statusCode, result.body).toBe(200);
  const row = result.json().data, grant = evidence(result);
  expect(row).toMatchObject({ checkoutEnabled: false, device: { revision: 1, status: "enrolled", deviceId: value.device.deviceId } });
  expect(grant).toMatchObject({ version: 1, purpose: "ekavyu.pharmacy.number-reservation.v1", checkoutEnabled: false, actorId: f.user.id, lease: { next: 2, last: 4 } });
  expect(Date.parse(grant.lease.validUntil) - Date.parse(grant.lease.validFrom)).toBeLessThanOrEqual(86400000);
  expect(crypto.verify("RSA-SHA256", Buffer.from(`ekavyu.pharmacy.number-reservation.v1\n${row.device.payload}`), SERVICE_PUBLIC_KEY, Buffer.from(row.device.signature, "base64url"))).toBe(true);
  expect((await allocateInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000005")).toBe(true);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10); expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  const asAccess = await app.inject({ method: "GET", url: route(f), headers: { authorization: `Bearer ${row.device.payload}.${row.device.signature}` } }); expect(asAccess.statusCode).toBe(401);
});
it("reserves custom owner numbering and fences settings edits while the PC is unresolved", async () => {
  const f = await owner(), config = await configure(f), value = await prepare(f, intent(1));
  const result = await post(f, "enroll", value.input); expect(result.statusCode, result.body).toBe(200);
  expect(evidence(result).lease).toMatchObject({ prefix: config.prefixTemplate, next: 137, last: 139, format: { configurationRevision: 1, digits: 4 } });
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber).toBe(`${config.prefixTemplate}0140`);
  const change = await app.inject({ method: "PUT", url: `/api/pharmacy/locations/${f.locationId}/invoice-numbering`, headers: f.headers, payload: { ...config, expectedRevision: 1, nextNumber: 141 } });
  expect(change.statusCode, change.body).toBe(409); expect(change.json().message).toMatch(/Reconcile/);
});
it("recovers exact enrollment after lost response and challenge deletion without allocating again", async () => {
  const f = await owner(), value = await prepare(f), first = await post(f, "enroll", value.input); expect(first.statusCode, first.body).toBe(200);
  await PharmacyOfflineChallenge.deleteMany({ locationId: f.locationId });
  const replay = await post(f, "enroll", value.input); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.device).toEqual(first.json().data.device);
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000004")).toBe(true);
  expect((await post(f, "enroll", { ...value.input, count: 4 })).statusCode).toBe(409);
  expect(await AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_OFFLINE_PC_ENROLLED" })).toBe(1);
});
it("permits only one winning PC when independent devices enroll concurrently", async () => {
  const f = await owner(), a = await prepare(f), b = await prepare(f);
  const results = await Promise.all([post(f, "enroll", a.input), post(f, "enroll", b.input)]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  expect(await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId })).toBe(1);
  const loser = results[0].statusCode === 409 ? a : b;
  const cancel = await post(f, "cancel", { challengeId: loser.input.challengeId, confirmed: true }); expect(cancel.statusCode, cancel.body).toBe(200);
  expect((await PharmacyOfflineChallenge.findOne({ challengeId: loser.input.challengeId }))!.consumedAt).toBeTruthy();
  expect(cancel.json().data.device.status).toBe("enrolled");
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000004")).toBe(true);
});
it("serializes identical enrollment submissions and concurrent online numbering", async () => {
  const f = await owner(), value = await prepare(f);
  const [one, two, online] = await Promise.all([post(f, "enroll", value.input), post(f, "enroll", value.input), allocatePharmacyInvoiceNumber(f.locationId)]);
  expect(one.statusCode, one.body).toBe(200); expect(two.statusCode, two.body).toBe(200); expect(one.json().data.device).toEqual(two.json().data.device);
  const lease = evidence(one).lease, sequence = Number(online.invoiceNumber.split("/").at(-1)); expect(sequence < lease.next || sequence > lease.last).toBe(true);
  expect(await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId })).toBe(1);
});
it("rejects proof tampering, changed intent, foreign challenges and expired proof without consuming it", async () => {
  const f = await owner(), other = await owner(), value = await prepare(f);
  expect((await post(f, "enroll", { ...value.input, count: 4 })).statusCode).toBe(403);
  expect((await post(other, "enroll", value.input)).statusCode).toBe(409);
  expect((await PharmacyOfflineChallenge.findOne({ challengeId: value.input.challengeId }))!.consumedAt).toBeUndefined();
  await PharmacyOfflineChallenge.updateOne({ challengeId: value.input.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  expect((await post(f, "enroll", value.input)).statusCode).toBe(409);
  expect(await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("rejects malformed fields and private-key material without silently stripping or coercing", async () => {
  const f = await owner(), key = identity();
  expect((await post(f, "challenge", { deviceId: key.deviceId, publicKey: { ...key.publicKey, d: "secret" } })).statusCode).toBe(400);
  expect((await post(f, "challenge", { deviceId: key.deviceId, publicKey: key.publicKey, extra: true })).statusCode).toBe(400);
  const value = await prepare(f);
  for (const changes of [{ count: "3" }, { count: 0 }, { count: 1001 }, { confirmed: false }, { expectedRevision: -1 }, { reviewReference: "  " }, { deviceName: "x\nY" }, { enabled: true }])
    expect((await post(f, "enroll", { ...value.input, ...changes })).statusCode).toBe(400);
});
it("rolls back number reservation, challenge consumption and device creation if required audit fails", async () => {
  const f = await owner(), value = await prepare(f); vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit failure"));
  expect((await post(f, "enroll", value.input)).statusCode).toBe(500);
  expect(await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await PharmacyOfflineChallenge.findOne({ challengeId: value.input.challengeId }))!.consumedAt).toBeUndefined();
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000001")).toBe(true);
  expect((await post(f, "enroll", value.input)).statusCode).toBe(200);
});
it("rejects exhausted allocations, disabled branches and stale numbering/year", async () => {
  const f = await owner(); await configure(f, 1); const exhausted = await prepare(f, intent(1)); expect((await post(f, "enroll", exhausted.input)).statusCode).toBe(409);
  expect(await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId })).toBe(0);
  const normal = await owner(), value = await prepare(normal); await Location.updateOne({ _id: normal.locationId }, { $set: { "pharmacyCapability.enabled": false, "pharmacyCapability.revision": 1 } });
  expect((await post(normal, "enroll", value.input)).statusCode).toBe(409);
  const stale = await owner(); const staleInput = await prepare(stale, { ...intent(), expectedFinancialYear: "2000-01" }); expect((await post(stale, "enroll", staleInput.input)).statusCode).toBe(409);
  const revision = await prepare(stale); await configure(stale); expect((await post(stale, "enroll", revision.input)).statusCode).toBe(409);
});
it("revokes with revision/audit, retains all numbers and forbids blind PC replacement", async () => {
  const f = await owner(), value = await prepare(f), saved = await post(f, "enroll", value.input); expect(saved.statusCode, saved.body).toBe(200);
  const revoke = await post(f, "revoke", { expectedRevision: 1, reviewReference: "Synthetic device loss review", confirmed: true }); expect(revoke.statusCode, revoke.body).toBe(200);
  expect(revoke.json().data.device).toMatchObject({ status: "revoked", revision: 2, payload: saved.json().data.device.payload });
  expect((await post(f, "revoke", { expectedRevision: 1, reviewReference: "Synthetic second request", confirmed: true })).statusCode).toBe(409);
  expect((await post(f, "challenge", { deviceId: value.device.deviceId, publicKey: value.device.publicKey })).statusCode).toBe(409);
  expect((await post(f, "enroll", value.input)).json().data.device.status).toBe("revoked");
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000004")).toBe(true);
  await expect(PharmacyOfflineDevice.updateOne({ locationId: f.locationId }, { $set: { payload: "changed" } })).rejects.toThrow(/immutable/);
  await expect(PharmacyOfflineDevice.deleteMany({ locationId: f.locationId })).rejects.toThrow(/removed/);
});
it("cancels uncommitted proof and resolves cancellation racing a late enrollment", async () => {
  const f = await owner(), value = await prepare(f);
  const cancel = await post(f, "cancel", { challengeId: value.input.challengeId, confirmed: true }); expect(cancel.statusCode, cancel.body).toBe(200); expect(cancel.json().data.device).toBeNull();
  expect((await post(f, "enroll", value.input)).statusCode).toBe(409);
  const second = await prepare(f), results = await Promise.all([post(f, "enroll", second.input), post(f, "cancel", { challengeId: second.input.challengeId, confirmed: true })]);
  expect(results[1].statusCode, results[1].body).toBe(200); expect([200, 409]).toContain(results[0].statusCode);
  const count = await PharmacyOfflineDevice.countDocuments({ locationId: f.locationId }), next = await allocatePharmacyInvoiceNumber(f.locationId);
  expect(next.invoiceNumber.endsWith(count ? "000004" : "000001")).toBe(true);
});
it("replaces a revoked unused PC with fresh numbers, preserving immutable original evidence and exact response recovery", async () => {
  const f = await owner(), first = await prepare(f), saved = await post(f, "enroll", first.input); expect(saved.statusCode, saved.body).toBe(200);
  expect((await post(f, "revoke", { expectedRevision: 1, reviewReference: "Synthetic reconciled replacement", confirmed: true })).statusCode).toBe(200);
  const replacement = await prepare(f, { ...intent(), expectedRevision: 2 }), replaced = await post(f, "enroll", replacement.input); expect(replaced.statusCode, replaced.body).toBe(200);
  expect(replaced.json().data.device).toMatchObject({ status: "enrolled", revision: 3, deviceId: replacement.device.deviceId });
  expect(evidence(replaced).lease).toMatchObject({ next: 4, last: 6 });
  expect((await post(f, "enroll", replacement.input)).json().data.device).toEqual(replaced.json().data.device);
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000007")).toBe(true);
  const archive = await PharmacyOfflineDeviceHistory.findOne({ locationId: f.locationId }); expect(archive!.evidence.payload).toBe(saved.json().data.device.payload);
  const history = await app.inject({ method: "GET", url: route(f, `/history/${first.device.deviceId}`), headers: f.headers }); expect(history.statusCode, history.body).toBe(200);
  expect(history.headers["cache-control"]).toBe("no-store"); expect(history.json().data.device).toMatchObject({ deviceId: first.device.deviceId, status: "revoked", publicKey: first.device.publicKey });
  const foreign = await owner(); expect((await app.inject({ method: "GET", url: route(foreign, `/history/${first.device.deviceId}`), headers: foreign.headers })).statusCode).toBe(404);
  await expect(PharmacyOfflineDeviceHistory.updateOne({ _id: archive!._id }, { $set: { evidence: {} } })).rejects.toThrow(/immutable/);
  expect(await AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_OFFLINE_PC_REPLACED" })).toBe(1);
});
it("rolls back replacement history, new number range and original PC mutation when required audit fails", async () => {
  const f = await owner(), first = await prepare(f); await post(f, "enroll", first.input);
  await post(f, "revoke", { expectedRevision: 1, reviewReference: "Synthetic replacement review", confirmed: true });
  const replacement = await prepare(f, { ...intent(), expectedRevision: 2 }); vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit failure"));
  expect((await post(f, "enroll", replacement.input)).statusCode).toBe(500);
  expect(await PharmacyOfflineDeviceHistory.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await get(f)).json().data.device).toMatchObject({ deviceId: first.device.deviceId, status: "revoked", revision: 2 });
  expect((await allocatePharmacyInvoiceNumber(f.locationId)).invoiceNumber.endsWith("000004")).toBe(true);
  expect((await post(f, "enroll", replacement.input)).statusCode).toBe(200);
});
it("caps reservation at the India fiscal boundary and recovers expired evidence unchanged", async () => {
  const f = await owner(), scope = { organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id }, key = identity();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2027-03-31T18:00:00.000Z"));
  const challenge = await createDeviceChallenge(scope, key.deviceId, key.publicKey), fields = intent();
  const input = { ...fields, challengeId: challenge.challengeId, proof: crypto.sign("sha256", Buffer.from(enrollmentProofMessage(challenge.context, fields)), { key: key.pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  const result = await enrollOfflineDevice(scope, input), grant = JSON.parse(result.device!.payload); expect(grant.lease.validUntil).toBe("2027-03-31T18:29:59.999Z");
  vi.setSystemTime(new Date("2027-04-02T00:00:00.000Z")); const replay = await enrollOfflineDevice(scope, input); expect(replay.device!.payload).toBe(result.device!.payload);
});
it("fails closed before enrollment if a required unique device index is absent", async () => {
  const f = await owner(); vi.spyOn(PharmacyOfflineDevice.collection, "listIndexes").mockReturnValue({ toArray: async () => [] } as never);
  const key = identity(), result = await post(f, "challenge", { deviceId: key.deviceId, publicKey: key.publicKey }); expect(result.statusCode, result.body).toBe(503);
});

it("serializes owner settings changes against a competing first device enrollment", async () => {
  const f = await owner(), value = await prepare(f);
  const config = { expectedRevision: 0, expectedFinancialYear: indiaFinancialYear().label, prefixTemplate: `R${crypto.randomBytes(2).toString("hex").toUpperCase()}/`, digits: 4, resetPolicy: "continuous", nextNumber: 100, reviewReference: "Synthetic concurrent settings" };
  const results = await Promise.all([post(f, "enroll", value.input), app.inject({ method: "PUT", url: `/api/pharmacy/locations/${f.locationId}/invoice-numbering`, headers: f.headers, payload: config })]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  const next = await allocatePharmacyInvoiceNumber(f.locationId);
  if (results[0].statusCode === 200) expect(next.invoiceNumber.endsWith("000004")).toBe(true);
  else expect(next.invoiceNumber).toBe(`${config.prefixTemplate}0100`);
});
