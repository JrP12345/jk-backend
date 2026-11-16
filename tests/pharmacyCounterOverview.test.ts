import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { Invoice } from "../models/Invoice.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Location } from "../models/Location.ts";
import { locationDateKey, locationDayRange } from "../utilities/locationTime.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const read = (f: Awaited<ReturnType<typeof fixture>>, locationId = f.locationId) => app.inject({ method: "GET", url: `/api/pharmacy/sales/overview?locationId=${locationId}`, headers: f.headers });
it("returns a complete local-day branch total and only the three newest original bills, with no customer details", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_VIEW_STOCK"]);
  await Location.updateOne({ _id: f.locationId }, { $set: { timezone: "America/Los_Angeles" } });
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const checked = await app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload: { locationId: f.locationId, lines: f.input.lines.map(({ lineId, medicineId, expectedUnitVersion, discountPaise }) => ({ lineId, medicineId, quantity: 1, expectedUnitVersion, discountPaise })) } });
    expect(checked.statusCode, checked.body).toBe(200);
    const saved = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: checked.json().data.issueInput });
    expect(saved.statusCode, saved.body).toBe(201); ids.push(saved.json().data.invoiceId);
  }
  const result = await read(f); expect(result.statusCode, result.body).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
  const data = result.json().data;
  expect(data).toMatchObject({ locationId: f.locationId, timezone: "America/Los_Angeles", salesPaise: 5000, bills: 5, drawer: { active: true, cashPaise: 100000 }, stock: { low: 1, expiring: 0, expired: 0, days: 90 } });
  expect(data.recent.map((row: { id: string }) => row.id)).toEqual(ids.slice(-3).reverse());
  expect(data.recent[0]).not.toHaveProperty("customerSnapshot");
  // Move one synthetic issued source outside this branch-local day to exercise the time boundary.
  const start = locationDayRange(locationDateKey(new Date(), "America/Los_Angeles"), "America/Los_Angeles").start;
  await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(ids[0]) }, { $set: { issuedAt: new Date(start.getTime() - 1) } });
  expect((await read(f)).json().data).toMatchObject({ salesPaise: 4000, bills: 4 });
  await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(ids[1]) }, { $set: { documentVersion: 3 } });
  expect((await read(f)).json().data).toMatchObject({ salesPaise: 3000, bills: 3 });
});
it("does not expose stock or drawer data without those grants, and rejects other branches and tenants", async () => {
  const seller = await fixture(), outsider = await fixture();
  const response = await read(seller); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ stock: null, drawer: null, bills: 0, salesPaise: 0, recent: [] });
  expect((await read(seller, outsider.locationId)).statusCode).toBeGreaterThanOrEqual(400);
  const stockOnly = await fixture(["PHARMACY_VIEW_STOCK"]);
  expect((await read(stockOnly)).statusCode).toBe(403);
});
it("keeps already expired and future expiring lots disjoint and does not leak stock costs", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_VIEW_STOCK"]);
  await MedicineBatch.collection.updateOne({ medicineId: new mongoose.Types.ObjectId(f.medicine.id) }, { $set: { expiryDate: new Date(Date.now() - 1000) } });
  const expired = await read(f); expect(expired.json().data.stock).toMatchObject({ expired: 1, expiring: 0 }); expect(expired.body).not.toContain("purchaseCost");
  await MedicineBatch.collection.updateOne({ medicineId: new mongoose.Types.ObjectId(f.medicine.id) }, { $set: { expiryDate: new Date(Date.now() + 86400000) } });
  expect((await read(f)).json().data.stock).toMatchObject({ expired: 0, expiring: 1 });
});
