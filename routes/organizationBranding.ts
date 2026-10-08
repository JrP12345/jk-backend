import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrganizationBrandingAsset } from "../models/OrganizationBrandingAsset.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { detectMagicBytes, scanForActiveMaliciousContent } from "../utilities/fileSecurity.ts";
import { uploadOrganizationImage, deleteObjectFromStorage, getObjectBuffer } from "../utilities/r2.ts";
import { brandingReference } from "../services/OrganizationBranding.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

const maxBytes = 5 * 1024 * 1024;
const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
export default async function organizationBrandingRoutes(app: FastifyInstance) {
  app.post("/api/organizations/branding/uploads", {
    bodyLimit: 8 * 1024 * 1024,
    preHandler: [authenticate, checkAnyPermission("MANAGE_ORGANIZATION", "MANAGE_LOCATIONS")],
  }, async (req, reply) => {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const organizationId = (req.body as any)?.forCreation === true && req.user?.role === "root" ? undefined : scope.organizationId;
    if (!scope.organizationId && req.user?.role !== "root") return reply.code(403).send(errorResponse("Organization context is required"));
    const { base64Data, contentType } = req.body as any;
    if (!allowedTypes.has(contentType) || typeof base64Data !== "string") return reply.code(400).send(errorResponse("Select a PNG, JPEG or WebP image"));
    const encoded = base64Data.replace(/^data:[^;]+;base64,/, "");
    if (!/^[A-Za-z\d+/]*={0,2}$/.test(encoded) || encoded.length > Math.ceil(maxBytes / 3) * 4) return reply.code(400).send(errorResponse("Image must be at most 5 MB"));
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > maxBytes || detectMagicBytes(buffer) !== contentType || !scanForActiveMaliciousContent(buffer).clean) return reply.code(400).send(errorResponse("Invalid or unsafe image"));
    if (organizationId && !await Organization.exists({ _id: organizationId })) return reply.code(404).send(errorResponse("Organization not found"));
    let key: string | undefined;
    try {
      key = await uploadOrganizationImage(buffer, contentType, req.user!.id);
      const asset = await OrganizationBrandingAsset.create({ ownerId: req.user!.id, organizationId: organizationId || null, objectKey: key, contentType, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) });
      return reply.code(201).send(successResponse({ id: asset.id, reference: brandingReference(asset.id) }));
    } catch (error) {
      if (key) await deleteObjectFromStorage(key).catch(() => undefined);
      req.log.error({ error }, "Organization branding upload failed");
      return reply.code(503).send(errorResponse("Image upload failed. Please retry."));
    }
  });

  app.delete("/api/organizations/branding/uploads/:id", { preHandler: [authenticate, checkAnyPermission("MANAGE_ORGANIZATION", "MANAGE_LOCATIONS")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!mongoose.isValidObjectId(id)) return reply.code(400).send(errorResponse("Invalid upload"));
    const asset = await OrganizationBrandingAsset.findOneAndUpdate({ _id: id, ownerId: req.user!.id, state: "staged" }, { $set: { state: "deleting" } });
    if (!asset) return reply.code(404).send(errorResponse("Staged upload not found"));
    try {
      await deleteObjectFromStorage(asset.objectKey);
      await asset.deleteOne();
    } catch (error) { req.log.warn({ error }, "Branding cleanup will be retried"); }
    return reply.send(successResponse(null));
  });

  app.get("/api/public/organization-branding/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!mongoose.isValidObjectId(id)) return reply.code(404).send();
    const asset = await OrganizationBrandingAsset.findOne({ _id: id, state: "attached" }).lean();
    if (!asset) return reply.code(404).send();
    const ref = brandingReference(id);
    const active = await Organization.exists({ _id: asset.organizationId, isActive: true, status: { $ne: "inactive" } });
    if (!active) return reply.code(404).send();
    const linked = await Organization.exists({ _id: asset.organizationId, $or: [{ logo_url: ref }, { image_url: ref }, { images: ref }] }) ||
      await Location.exists({ organizationId: asset.organizationId, isActive: true, isPublished: { $ne: false }, $or: [{ logo: ref }, { images: ref }] });
    if (!linked) return reply.code(404).send();
    try {
      const buffer = await getObjectBuffer(asset.objectKey);
      return reply.header("Cache-Control", "public, max-age=300").header("X-Content-Type-Options", "nosniff").type(asset.contentType).send(buffer);
    } catch { return reply.code(503).send(); }
  });


}
