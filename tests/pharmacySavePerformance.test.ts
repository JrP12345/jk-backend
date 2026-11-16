import crypto from "node:crypto";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { app } from "../index.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { createAuthSession } from "../utilities/helpers.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });

// Disposable replica-set data only. Counts expose round trips without logging query values.
it.each([1, 10, 20])("profiles a %i-line paid save with historical lots", async lineCount => {
  const fixture = await pharmacyRetailFixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]);
  const medicine = (await Medicine.findById(fixture.medicine.id).lean())!;
  const lot = (await MedicineBatch.findOne({ medicineId: medicine._id }).lean())!;
  const products = Array.from({ length: lineCount }, (_, index) => ({ ...medicine, _id: new mongoose.Types.ObjectId(), name: `Benchmark product ${index}` }));
  await Medicine.insertMany(products);
  await MedicineBatch.insertMany(products.flatMap(product => Array.from({ length: 51 }, (_, index) => ({
    ...lot, _id: new mongoose.Types.ObjectId(), medicineId: product._id, receiptLineId: crypto.randomUUID(),
    batchNumber: `BENCH-${index}`, quantity: index ? 0 : 10, status: index ? "depleted" : "active",
  }))));
  const samples: Array<{ elapsedMs: number; queries: number; medicineReads: number; lotReads: number; timing: unknown }> = [];
  for (let sample = 0; sample < 3; sample++) {
    let queries = 0, medicineReads = 0, lotReads = 0;
    const previous = mongoose.get("debug");
    mongoose.set("debug", (collection, method) => {
      queries++;
      if (collection === Medicine.collection.name && ["find", "findOne"].includes(method)) medicineReads++;
      if (collection === MedicineBatch.collection.name && method === "find") lotReads++;
    });
    const total = lineCount * 1000, started = performance.now();
    let response;
    try {
      response = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...fixture.headers, "idempotency-key": crypto.randomUUID() }, payload: {
        locationId: fixture.locationId, confirmationMode: "current_total", expectedTotalPaise: total, includeDocument: true,
        lines: products.map(product => ({ lineId: crypto.randomUUID(), medicineId: String(product._id), quantity: 1, expectedUnitVersion: 1, discountPaise: 0, expectedLineTotalPaise: 1000 })),
        payment: { locationId: fixture.locationId, expectedPaymentRevision: 0, expectedBalancePaise: total, manualConfirmed: true, cashTenderedPaise: total,
          entries: [{ componentId: crypto.randomUUID(), amountPaise: total, paymentMethod: "cash" }] },
      } });
    } finally { mongoose.set("debug", previous); }
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ status: "paid", totalPaise: total });
    expect(lotReads).toBe(lineCount);
    expect(medicineReads).toBe(lineCount + 1);
    samples.push({ elapsedMs: Math.round(performance.now() - started), queries, medicineReads, lotReads, timing: response.headers["server-timing"] });
  }
  const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const report = { probe: "pharmacy-save", lines: lineCount, historicalLotsPerProduct: 50, samples, coldMs: samples[0].elapsedMs, warmMs: samples.slice(1).map(sample => sample.elapsedMs), p50Ms: sorted[1], p95Ms: sorted[2] };
  await mkdir(".cache/pharmacy-save-benchmark", { recursive: true });
  await writeFile(`.cache/pharmacy-save-benchmark/${lineCount}.json`, JSON.stringify(report, null, 2));
  expect((await Medicine.findById(products[0]._id))!.stockQuantity).toBe(7);
}, 60_000);

it("measures competing tills and commits only one paid sale when both request the last stock", async () => {
  const f = await pharmacyRetailFixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]);
  const second = await User.create({ name: "Second synthetic cashier", email: `${crypto.randomUUID()}@example.test`, role: f.role });
  await OrgMember.create({ organizationId: f.organizationId, userId: second.id, role: f.role, locationAccess: { mode: "selected", locationIds: [f.locationId] } });
  const session = await createAuthSession({ id: second.id, role: f.role, email: second.email!, organization_id: f.organizationId });
  const original = (await CashierShift.findOne({ locationId: f.locationId }).lean())!;
  await CashierShift.create({ ...original, _id: new mongoose.Types.ObjectId(), cashierId: second.id, cashierName: second.name, drawerCode: "SYNTHETIC-2" });
  const total = 6000, input = { locationId: f.locationId, confirmationMode: "current_total", expectedTotalPaise: total, includeDocument: true,
    lines: [{ lineId: crypto.randomUUID(), medicineId: f.medicine.id, quantity: 6, expectedUnitVersion: 1, discountPaise: 0, expectedLineTotalPaise: total }],
    payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: total, manualConfirmed: true, cashTenderedPaise: total, entries: [{ componentId: crypto.randomUUID(), amountPaise: total, paymentMethod: "cash" }] } };
  const started = performance.now();
  const results = await Promise.all([f.headers, { authorization: `Bearer ${session.accessToken}` }].map(async headers => {
    const at = performance.now(), response = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: input });
    return { response, elapsedMs: Math.round(performance.now() - at) };
  }));
  expect(results.map(result => result.response.statusCode).sort()).toEqual([201, 409]);
  const winner = results.find(result => result.response.statusCode === 201)!.response.json().data;
  expect(winner.status).toBe("paid");
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(1);
  expect(await InvoiceCollectionReceipt.countDocuments({ invoiceId: winner.invoiceId })).toBe(1);
  const drawers = await CashierShift.find({ locationId: f.locationId }).lean();
  expect(drawers).toHaveLength(2);
  await mkdir(".cache/pharmacy-save-benchmark", { recursive: true });
  await writeFile(".cache/pharmacy-save-benchmark/competing-tills.json", JSON.stringify({ probe: "pharmacy-competing-tills", tills: 2, requestedPerTill: 6, initialStock: 10, remainingStock: 4, invoices: 1, receipts: 1,
    elapsedMs: Math.round(performance.now() - started), results: results.map(result => ({ status: result.response.statusCode, elapsedMs: result.elapsedMs, timing: result.response.headers["server-timing"] })) }, null, 2));
}, 60_000);
