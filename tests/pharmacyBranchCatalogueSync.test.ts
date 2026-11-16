import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Medicine } from "../models/Medicine.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof pharmacyRetailFixture>>;
type Page = { version: number; locationId: string; after: string | null; through: string | null; hash: string; count: number; nextCursor: string | null; items: Array<{ id: string; name: string; eligible: boolean }> | null };
const read = (f: Fixture, query: Record<string, string> = {}) => app.inject({ method: "GET", url: `/api/pharmacy/sales/catalogue?${new URLSearchParams({ locationId: f.locationId, ...query })}`, headers: f.headers });

it("projects only anonymous counter product fields and reuses an unchanged page by its fingerprint", async () => {
  const f = await pharmacyRetailFixture();
  const first = await read(f); expect(first.statusCode, first.body).toBe(200); expect(first.headers["cache-control"]).toBe("no-store");
  const page: Page = first.json().data; expect(page).toMatchObject({ version: 1, locationId: f.locationId, after: null, count: 1, nextCursor: null });
  expect(page.items).toMatchObject([{ id: f.medicine.id, eligible: true }]); expect(page.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(first.body).not.toMatch(/costPrice|purchaseCost|confirmedBy|reviewReference|taxClassification|patient|supplier/);
  const same = await read(f, { knownHash: page.hash }); expect(same.json().data).toMatchObject({ hash: page.hash, items: null, count: 1 });
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { price: 12, scheduleType: "schedule_h", stockQuantity: 0 } });
  const changed = (await read(f, { knownHash: page.hash })).json().data;
  expect(changed.hash).not.toBe(page.hash); expect(changed.items).toMatchObject([{ retailPricePaise: 1200, eligible: false, stockQuantity: 0 }]);
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { deletedAt: new Date() } });
  const empty = (await read(f, { knownHash: changed.hash })).json().data; expect(empty).toMatchObject({ items: [], count: 0, through: null, nextCursor: null });
});

it("bounds pages and traversal while later additions are picked up on the next refresh", async () => {
  const f = await pharmacyRetailFixture();
  await Medicine.insertMany(Array.from({ length: 200 }, (_, n) => ({ locationId: f.locationId, name: `Page item ${n}`, genericName: "Synthetic", price: 1 })));
  const first: Page = (await read(f)).json().data; expect(first.items).toHaveLength(200); expect(first.nextCursor).toBeTruthy();
  const added = await Medicine.create({ locationId: f.locationId, name: "Later product", genericName: "Synthetic", price: 1 });
  const final: Page = (await read(f, { after: first.nextCursor!, through: first.through! })).json().data;
  expect(final.count).toBe(1); expect(final.nextCursor).toBeNull(); expect(final.items!.some(item => item.id === added.id)).toBe(false);
  const refresh: Page = (await read(f, { knownHash: first.hash })).json().data; expect(refresh.items).toBeNull(); expect(refresh.through).toBe(added.id);
  const latest: Page = (await read(f, { after: refresh.nextCursor!, through: refresh.through! })).json().data; expect(latest.items!.some(item => item.id === added.id)).toBe(true);
  expect((await read(f, { after: first.nextCursor! })).statusCode).toBe(400);
  expect((await read(f, { after: first.through!, through: first.nextCursor! })).statusCode).toBe(400);
  expect((await read(f, { knownHash: "invalid" })).statusCode).toBe(400);
});

it("enforces authentication, sell permission, module state and branch/organization ownership", async () => {
  const f = await pharmacyRetailFixture(), foreign = await pharmacyRetailFixture(), reader = await pharmacyRetailFixture(["PHARMACY_VIEW_SALES"]);
  const path = `/api/pharmacy/sales/catalogue?locationId=${f.locationId}`;
  expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: path, headers: foreign.headers })).statusCode).toBe(404);
  expect((await read(reader)).statusCode).toBe(403);
  expect((await read(f, { organizationId: foreign.organizationId })).statusCode).toBe(403);
  const disabled = await ModuleRegistry.create({ organizationId: f.organizationId, moduleKey: "pharmacy", enabled: false, priority: "P1", label: "Pharmacy" });
  try { expect((await read(f)).statusCode).toBe(403); } finally { await ModuleRegistry.deleteOne({ _id: disabled._id }); }
});

it("returns catalogue-specific read failures without suggesting a financial retry", async () => {
  const f = await pharmacyRetailFixture(), find = vi.spyOn(Medicine, "find").mockImplementationOnce(() => { throw Error("Synthetic timeout"); });
  try { const response = await read(f); expect(response.statusCode).toBe(503); expect(response.body).toContain("Existing cached preparation is unchanged"); expect(response.body).not.toContain("same reference"); } finally { find.mockRestore(); }
});

it("traverses a 10,000-product branch without leaking another branch or repeating product IDs", async () => {
  const f = await pharmacyRetailFixture(), foreign = await pharmacyRetailFixture();
  await Medicine.insertMany(Array.from({ length: 9999 }, (_, n) => ({ locationId: f.locationId, name: `Catalogue ${n}`, genericName: "Synthetic", price: 1 })));
  const ids = new Set<string>(); let after: string | null = null, through: string | null = null, calls = 0;
  do {
    const response = await read(f, after ? { after, through: through! } : {}); expect(response.statusCode, response.body).toBe(200);
    const page: Page = response.json().data; through = page.through; after = page.nextCursor; calls++;
    for (const row of page.items!) { expect(ids.has(row.id)).toBe(false); expect(row.id).not.toBe(foreign.medicine.id); ids.add(row.id); }
  } while (after && calls < 51);
  expect(ids.size).toBe(10_000); expect(calls).toBe(50); expect(after).toBeNull();
});
