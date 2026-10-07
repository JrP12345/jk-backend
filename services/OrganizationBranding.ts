import type { FastifyRequest } from "fastify";
import type { ClientSession } from "mongoose";
import { Organization } from "../models/Organization.ts";
import { OrganizationBrandingAsset } from "../models/OrganizationBrandingAsset.ts";
import { deleteObjectFromStorage } from "../utilities/r2.ts";

const referencePattern = /^\/api\/public\/organization-branding\/([a-f\d]{24})$/i;
export const brandingReference = (id: string) => `/api/public/organization-branding/${id}`;
export const brandingAssetId = (value: unknown) => typeof value === "string" ? referencePattern.exec(value)?.[1] : undefined;
const references = (org: any): string[] => [org?.logo_url, org?.image_url, ...(org?.images || [])].filter((v): v is string => typeof v === "string" && !!v);

export class BrandingValidationError extends Error {}

/** Validate before any organization write. Stored references remain editable. */
export async function validateBrandingReferences(req: FastifyRequest, next: any, current?: any) {
  const previous = new Set(references(current));
  for (const ref of references(next)) {
    const id = brandingAssetId(ref);
    if (!id) {
      // Preserve public external image URLs; reject arbitrary private vault keys.
      if (/^https?:\/\//i.test(ref)) continue;
      throw new BrandingValidationError("Upload organization images through the branding uploader");
    }
    if (previous.has(ref)) continue;
    const asset = await OrganizationBrandingAsset.findById(id).lean();
    if (!asset || asset.state !== "staged" || asset.expiresAt <= new Date() || asset.ownerId.toString() !== req.user?.id) {
      throw new BrandingValidationError("The branding upload is unavailable; select the image again");
    }
    if (asset.organizationId && asset.organizationId.toString() !== current?._id?.toString()) {
      throw new BrandingValidationError("Branding upload belongs to another organization");
    }
  }
}

export async function attachBranding(org: any, session?: ClientSession | null) {
  const ids = new Set(references(org).map(brandingAssetId).filter(Boolean));
  for (const id of ids) {
    const asset = await OrganizationBrandingAsset.findOneAndUpdate({ _id: id, state: "staged", expiresAt: { $gt: new Date() } }, {
      $set: { organizationId: org._id, state: "attached", expiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
    }, session ? { session } : {});
    if (asset) continue;
    let query = OrganizationBrandingAsset.findOne({ _id: id, state: "attached", organizationId: org._id });
    if (session) query = query.session(session);
    if (!await query) throw new BrandingValidationError("Branding upload was cancelled or expired. Select the image again.");
  }
}

export async function retireUnusedBranding(previous: any, current: any, session?: ClientSession | null) {
  const retained = new Set(references(current));
  const ids = references(previous).filter((ref) => !retained.has(ref)).map(brandingAssetId).filter(Boolean);
  if (ids.length) await OrganizationBrandingAsset.updateMany({ _id: { $in: ids }, state: "attached" }, { $set: { expiresAt: new Date() } }, session ? { session } : {});
}

/** A sweep retries failed deletes and abandoned uploads. Never delete a referenced object. */
export async function cleanupBrandingAssets(now = new Date()) {
  const candidates = await OrganizationBrandingAsset.find({
    $or: [{ state: { $in: ["staged", "attached"] }, expiresAt: { $lte: now } }, { state: "deleting" }],
  }).sort({ lastCheckedAt: 1 }).limit(200).lean();
  for (const asset of candidates) {
    const reference = brandingReference(asset._id.toString());
    const linked = await Organization.exists({ $or: [{ logo_url: reference }, { image_url: reference }, { images: reference }] });
    if (linked) {
      await OrganizationBrandingAsset.updateOne({ _id: asset._id }, { $set: { lastCheckedAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) } });
      continue;
    }
    // Claim cleanup atomically: a concurrent save cannot attach a deleting upload.
    const claimed = await OrganizationBrandingAsset.findOneAndUpdate({ _id: asset._id, state: asset.state }, { $set: { state: "deleting" } });
    if (!claimed) continue;
    try {
      await deleteObjectFromStorage(asset.objectKey);
      await OrganizationBrandingAsset.deleteOne({ _id: asset._id, state: "deleting" });
    } catch (error) {
      console.error("organization.branding.cleanup.failed", { assetId: asset._id.toString(), error });
    }
  }
}

export function organizationImageReference(org: any, slot: "logo_url" | "image_url" | number): string | null {
  const value = typeof slot === "number" ? org?.images?.[slot] : org?.[slot];
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || brandingAssetId(value)) return value;
  return null;
}
