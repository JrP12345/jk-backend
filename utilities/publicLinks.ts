import crypto from "node:crypto";
import { Types } from "mongoose";
import { PublicLink } from "../models/PublicLink.ts";

// Names remain readable; a random suffix distinguishes names without exposing database IDs.
export async function publicSlug(kind: "location" | "doctor", targetId: string, name: string) {
  const existing = await PublicLink.findOne({ kind, targetId }).lean();
  if (existing) return existing.slug;
  const label = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || kind;
  try {
    const link = await PublicLink.create({ kind, targetId, slug: `${label}-${crypto.randomBytes(6).toString("hex")}` });
    return link.slug;
  } catch (error) {
    // Concurrent directory reads may both assign the first link.
    const winner = await PublicLink.findOne({ kind, targetId }).lean();
    if (winner) return winner.slug;
    throw error;
  }
}

export async function resolvePublicId(kind: "location" | "doctor", link: string) {
  if (!/^[a-z0-9-]{1,100}$/.test(link)) return null;
  const record = await PublicLink.findOne({ kind, slug: link }).lean();
  return record ? record.targetId.toString() : null;
}

/** Assign stable public links in batches without a read/write for every sitemap entry. */
export async function publicSlugs(targets: Array<{ kind: "location" | "doctor"; targetId: string; name: string }>) {
  const unique = [...new Map(targets.map((target) => [`${target.kind}:${target.targetId}`, target])).values()];
  if (!unique.length) return new Map<string, string>();
  const filter = { $or: unique.map(({ kind, targetId }) => ({ kind, targetId })) };
  let records = await PublicLink.find(filter).lean();
  const existing = new Set(records.map((record) => `${record.kind}:${record.targetId}`));
  const missing = unique.filter((target) => !existing.has(`${target.kind}:${target.targetId}`));
  if (missing.length) {
    try {
      await PublicLink.bulkWrite(missing.map(({ kind, targetId, name }) => {
        const objectId = new Types.ObjectId(targetId);
        const label = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || kind;
        return { updateOne: { filter: { kind, targetId: objectId }, update: { $setOnInsert: { kind, targetId: objectId, slug: `${label}-${crypto.randomBytes(6).toString("hex")}` } }, upsert: true } };
      }), { ordered: false });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    }
    records = await PublicLink.find(filter).lean();
  }
  const result = new Map(records.map((record) => [`${record.kind}:${record.targetId}`, record.slug]));
  if (unique.some((target) => !result.has(`${target.kind}:${target.targetId}`))) throw new Error("Could not assign public discovery links");
  return result;
}
