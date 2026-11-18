import mongoose from "mongoose";
import { expect, it } from "vitest";
import { createTenantRepository } from "../platform/TenantRepository.ts";
import { runWithContext } from "../utilities/context.ts";

const schema = new mongoose.Schema({ organizationId: mongoose.Schema.Types.ObjectId, name: String });
const Record = mongoose.models.ArchitectureTenantRecord || mongoose.model("ArchitectureTenantRecord", schema);
const repo = createTenantRepository(Record);

it("scopes reads and aggregates to the authenticated tenant, including facets", async () => {
  const a = new mongoose.Types.ObjectId(), b = new mongoose.Types.ObjectId();
  await Record.create([{ organizationId: a, name: "Tenant A" }, { organizationId: b, name: "Tenant B" }]);
  await runWithContext({ organizationId: String(a) }, async () => {
    expect(await repo.aggregate([{ $facet: { records: [{ $project: { _id: 0, name: 1 } }] } }])).toEqual([{ records: [{ name: "Tenant A" }] }]);
    await expect(repo.aggregate([], { organizationId: b })).rejects.toThrow(/does not match/);
  });
});

it.each(["$lookup", "$graphLookup", "$unionWith", "$out", "$merge", "$documents"])("rejects %s rather than treating a leading match as cross-collection authorization", async operation => {
  const organizationId = String(new mongoose.Types.ObjectId());
  await runWithContext({ organizationId }, async () => {
    await expect(repo.aggregate([{ [operation]: {} }] as any)).rejects.toThrow(/Tenant aggregation cannot use/);
    await expect(repo.aggregate([{ $facet: { nested: [{ [operation]: {} }] } }] as any)).rejects.toThrow(/Tenant aggregation cannot use/);
  });
});

it("fails closed when no tenant context is available", async () => {
  await expect(repo.aggregate([])).rejects.toThrow(/Missing or invalid organizationId/);
});
