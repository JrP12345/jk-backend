import crypto from "node:crypto";
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
