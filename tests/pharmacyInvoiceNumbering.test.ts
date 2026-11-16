import crypto from "node:crypto";
import mongoose from "mongoose";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { PharmacyInvoiceNumbering, PharmacyInvoicePrefix } from "../models/PharmacyInvoiceNumbering.ts";
import { Invoice } from "../models/Invoice.ts";
import { Counter } from "../models/Counter.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Medicine } from "../models/Medicine.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { allocateInvoiceNumber, allocatePharmacyInvoiceNumber, allocateCreditNoteNumber, indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { pharmacyNumberPrefix, validPharmacyInvoiceNumber } from "../utilities/pharmacyInvoiceNumberFormat.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof fixture>>;
const owner = () => fixture(["MANAGE_ORGANIZATION", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_VIEW_SALES"]);
const fields = () => ({ expectedRevision: 0, expectedFinancialYear: indiaFinancialYear().label, prefixTemplate: `P${crypto.randomBytes(2).toString("hex").toUpperCase()}/{FY}/`, digits: 4, resetPolicy: "financial_year" as const, nextNumber: 137, reviewReference: "Synthetic owner numbering review" });
const put = (f: Fixture, payload: object, locationId = f.locationId) => app.inject({ method: "PUT", url: `/api/pharmacy/locations/${locationId}/invoice-numbering`, headers: f.headers, payload });
const read = (f: Fixture, locationId = f.locationId) => app.inject({ method: "GET", url: `/api/pharmacy/locations/${locationId}/invoice-numbering`, headers: f.headers });
async function paid(f: Fixture, key = crypto.randomUUID()) {
  const q = await app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload: { locationId: f.locationId, lines: f.input.lines.map(({ expectedStockRevision: _r, ...line }) => line) } });
  expect(q.statusCode, q.body).toBe(200);
  const input = { ...q.json().data.issueInput, includeDocument: true, payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true,
    cashTenderedPaise: 2500, entries: [{ componentId: crypto.randomUUID(), amountPaise: 2000, paymentMethod: "cash" }] } };
  return { response: await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key }, payload: input }), input, key };
}

it("requires owner authority and hides foreign branch settings", async () => {
  const staff = await fixture(["PHARMACY_MANAGE_SETTINGS"]), f = await owner(), foreign = await owner();
  expect((await read(staff)).statusCode).toBe(403); expect((await put(staff, fields())).statusCode).toBe(403);
  expect([403, 404]).toContain((await read(f, foreign.locationId)).statusCode);
  expect([403, 404]).toContain((await put(f, fields(), foreign.locationId)).statusCode);
});
it("reads defaults without consuming a number, and configures owner prefix/start/padding", async () => {
  const f = await owner(), input = fields();
  expect((await read(f)).json().data).toMatchObject({ revision: 0, configuration: null, nextNumber: null, preview: null });
  const result = await put(f, input); expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({ revision: 1, nextNumber: 137, preview: `${pharmacyNumberPrefix(input, indiaFinancialYear().label)}0137` });
  expect(await PharmacyInvoicePrefix.countDocuments({ locationId: f.locationId })).toBe(99);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("paid Save, exact recovery and reprints retain the captured custom number after settings change", async () => {
  const f = await owner(), input = fields(); expect((await put(f, input)).statusCode).toBe(200);
  const saved = await paid(f); expect(saved.response.statusCode, saved.response.body).toBe(201);
  const data = saved.response.json().data;
  expect(data.invoiceNumber).toBe(`${pharmacyNumberPrefix(input, indiaFinancialYear().label)}0137`);
  expect(data.document).toMatchObject({ invoiceNumber: data.invoiceNumber, numberingVersion: 3, numberingSnapshot: { sequence: 137, configurationRevision: 1, prefixTemplate: input.prefixTemplate }, status: "paid", amountPaid: 20 });
  expect(data.collection.invoiceNumber).toBe(data.invoiceNumber); expect(validPharmacyInvoiceNumber(await Invoice.findById(data.invoiceId))).toBe(true);
  expect((await put(f, { ...input, expectedRevision: 1, nextNumber: 138, prefixTemplate: `R${crypto.randomBytes(2).toString("hex").toUpperCase()}/`, resetPolicy: "continuous" })).statusCode).toBe(200);
  const replay = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": saved.key }, payload: saved.input });
  expect(replay.statusCode, replay.body).toBe(201); expect(replay.json().data.invoiceNumber).toBe(data.invoiceNumber);
  const document = await app.inject({ method: "GET", url: `/api/pharmacy/invoices/${data.invoiceId}?locationId=${f.locationId}`, headers: f.headers });
  expect(document.statusCode, document.body).toBe(200); expect(document.json().data).toMatchObject({ invoiceNumber: data.invoiceNumber, numberingSnapshot: data.document.numberingSnapshot });
  await expect(Invoice.updateOne({ _id: data.invoiceId }, { $set: { "numberingSnapshot.sequence": 999 } })).rejects.toThrow(/rewritten|immutable/);
  expect((await allocateCreditNoteNumber(f.locationId)).startsWith("C")).toBe(true);
  const source = await app.inject({ method: "GET", url: `/api/pharmacy/invoices/${data.invoiceId}/return-source?locationId=${f.locationId}`, headers: f.headers });
  expect(source.statusCode, source.body).toBe(200);
  const line = source.json().data.lines[0], returnedInput = { locationId: f.locationId, reason: "Actual returned goods", reviewReference: "Synthetic return review", confirmedQuarantine: true,
    lines: [{ sourceLineId: line.sourceLineId, sourceBatchId: line.sourceBatchId, quantity: 1, condition: "unopened" }] };
  const reviewed = await app.inject({ method: "POST", url: `/api/pharmacy/invoices/${data.invoiceId}/returns/quote`, headers: f.headers, payload: returnedInput });
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  const returned = await app.inject({ method: "POST", url: `/api/pharmacy/invoices/${data.invoiceId}/returns`, headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: reviewed.json().data.issueInput });
  expect(returned.statusCode, returned.body).toBe(201);
  expect((await Invoice.findById(data.invoiceId)).invoiceNumber).toBe(data.invoiceNumber);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(9);
});
it("serializes concurrent bills and owner configuration changes without duplicate numbers", async () => {
  const f = await owner(), input = fields(); expect((await put(f, input)).statusCode).toBe(200);
  const numbers = await Promise.all(Array.from({ length: 6 }, () => allocatePharmacyInvoiceNumber(f.locationId)));
  expect(new Set(numbers.map(row => row.invoiceNumber)).size).toBe(6);
  expect(numbers.map(row => row.numberingSnapshot?.sequence).sort((a, b) => a! - b!)).toEqual([137, 138, 139, 140, 141, 142]);
  expect((await put(f, { ...input, expectedRevision: 1, nextNumber: 137 })).statusCode).toBe(409);
  expect((await read(f)).json().data.nextNumber).toBe(143);
  const changes = await Promise.all([put(f, { ...input, expectedRevision: 1, nextNumber: 150 }), put(f, { ...input, expectedRevision: 1, nextNumber: 160 })]);
  expect(changes.map(row => row.statusCode).sort()).toEqual([200, 409]);
});
it("never reassigns a prefix, including a future fiscal expansion, to another branch", async () => {
  const a = await owner(), branch = await Location.create({ organizationId: a.organizationId, name: "Second branch", city: "Pune" });
  await OrgMember.updateOne({ organizationId: a.organizationId, userId: a.user.id }, { $push: { "locationAccess.locationIds": branch._id } });
  const b = { ...a, locationId: branch.id }, input = fields(); expect((await put(a, input)).statusCode).toBe(200);
  expect((await put(b, input)).statusCode).toBe(409);
  expect((await put(b, { ...input, prefixTemplate: pharmacyNumberPrefix(input, "2030-31"), resetPolicy: "continuous" })).statusCode).toBe(409);
  expect(await PharmacyInvoiceNumbering.countDocuments({ locationId: b.locationId })).toBe(0);
});
it("resets yearly sequences on the Indian April boundary and continues non-yearly sequences", async () => {
  const f = await owner(), input = fields(); expect((await put(f, input)).statusCode).toBe(200);
  const before = await allocatePharmacyInvoiceNumber(f.locationId, new Date("2030-03-31T18:29:59Z"));
  const after = await allocatePharmacyInvoiceNumber(f.locationId, new Date("2030-03-31T18:30:00Z"));
  expect(before.invoiceNumber.endsWith("29-30/0001")).toBe(true); expect(after.invoiceNumber.endsWith("30-31/0001")).toBe(true);
  expect((await put(f, { ...input, expectedRevision: 1, prefixTemplate: `Q${crypto.randomBytes(2).toString("hex").toUpperCase()}/`, resetPolicy: "continuous", nextNumber: 51 })).statusCode).toBe(200);
  const first = await allocatePharmacyInvoiceNumber(f.locationId, new Date("2030-03-31T18:29:59Z")), second = await allocatePharmacyInvoiceNumber(f.locationId, new Date("2030-03-31T18:30:00Z"));
  expect(first.invoiceNumber.endsWith("0051")).toBe(true); expect(second.invoiceNumber.endsWith("0052")).toBe(true);
});
it("rejects invalid/oversized/internal series and requests lacking exact input contracts", async () => {
  const f = await owner(), base = fields();
  for (const change of [{ prefixTemplate: "PJP" }, { prefixTemplate: "PJP/{FY}/{FY}/" }, { prefixTemplate: "PJP/{FY}/", resetPolicy: "continuous" }, { prefixTemplate: "I00012627/", resetPolicy: "continuous" },
    { prefixTemplate: "TOO-LONG-PREFIX/{FY}/" }, { nextNumber: 10000 }, { nextNumber: 0 }, { digits: 0 }, { nextNumber: 1.5 }, { expectedRevision: 0.5 }, { expectedFinancialYear: "2000-01" }, { reviewReference: " " }, { unexpected: true }])
    { const response = await put(f, { ...base, ...change }); expect([400, 409], JSON.stringify(change) + response.body).toContain(response.statusCode); }
  expect(await PharmacyInvoiceNumbering.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("rolls back prefix reservations, counters and settings when the required audit fails", async () => {
  const f = await owner(), input = fields();
  vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic required audit failure"));
  expect((await put(f, input)).statusCode).toBe(500);
  expect(await PharmacyInvoiceNumbering.countDocuments({ locationId: f.locationId })).toBe(0); expect(await PharmacyInvoicePrefix.countDocuments({ locationId: f.locationId })).toBe(0);
  expect(await Counter.findOne({ id: `pharmacy-number-v3:${f.organizationId}:${pharmacyNumberPrefix(input, indiaFinancialYear().label)}` })).toBeNull();
});
it("allows independent owners to issue the same chosen number without cross-organization lookup or payment leakage", async () => {
  const a = await owner(), b = await owner(), input = fields();
  expect((await put(a, input)).statusCode).toBe(200); expect((await put(b, input)).statusCode).toBe(200);
  const one = await paid(a), two = await paid(b);
  expect(one.response.statusCode, one.response.body).toBe(201); expect(two.response.statusCode, two.response.body).toBe(201);
  const billA = one.response.json().data, billB = two.response.json().data;
  expect(billA.invoiceNumber).toBe(billB.invoiceNumber); expect(billA.invoiceId).not.toBe(billB.invoiceId);
  const foreign = await app.inject({ method: "GET", url: `/api/pharmacy/invoices/${billB.invoiceId}?locationId=${a.locationId}`, headers: a.headers });
  expect([403, 404]).toContain(foreign.statusCode);
  await expect(Invoice.collection.insertOne({ invoiceNumber: billA.invoiceNumber, organizationId: new mongoose.Types.ObjectId(a.organizationId) })).rejects.toMatchObject({ code: 11000 });
});
it("exhausted custom numbering rolls back the paid bill, stock and collection", async () => {
  const f = await owner(), input = { ...fields(), prefixTemplate: `E${crypto.randomBytes(2).toString("hex").toUpperCase()}/`, resetPolicy: "continuous", digits: 1, nextNumber: 9 };
  expect((await put(f, input)).statusCode).toBe(200); const last = await allocatePharmacyInvoiceNumber(f.locationId); expect(last.invoiceNumber.endsWith("9")).toBe(true);
  const saved = await paid(f); expect(saved.response.statusCode).toBe(409);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
});
it("default branches and general clinical numbering retain the existing format", async () => {
  const f = await owner(), defaultNumber = await allocatePharmacyInvoiceNumber(f.locationId);
  expect(defaultNumber.numberingVersion).toBe(2); expect(defaultNumber.invoiceNumber).toMatch(/^I[A-Z0-9]{8}\/[0-9]{6}$/);
  expect((await put(f, fields())).statusCode).toBe(200);
  const clinical = await allocateInvoiceNumber(f.locationId); expect(clinical.numberingVersion).toBe(2); expect(clinical.invoiceNumber).toMatch(/^I[A-Z0-9]{8}\/[0-9]{6}$/);
  expect(await Location.exists({ _id: f.locationId })).toBeTruthy();
});
it("blocks configuration while the obsolete global invoice constraint is still present", async () => {
  const f = await owner();
  vi.spyOn(Invoice.collection, "listIndexes").mockReturnValue({ toArray: async () => [
    { unique: true, key: { organizationId: 1, invoiceNumber: 1 } }, { unique: true, key: { invoiceNumber: 1 } },
  ] } as never);
  const response = await put(f, fields()); expect(response.statusCode, response.body).toBe(503);
  expect(await PharmacyInvoiceNumbering.countDocuments({ locationId: f.locationId })).toBe(0);
});
