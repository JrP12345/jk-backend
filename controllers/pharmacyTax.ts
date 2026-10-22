import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { Medicine } from "../models/Medicine.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { checkLocationAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { inclusiveTax, validatePharmacyProfile } from "../utilities/pharmacyTax.ts";

function expectedRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new CommandError(409, "Reload settings and provide a valid expectedRevision");
}
function respondError(reply: FastifyReply, error: unknown) {
  return reply.code(error instanceof CommandError ? error.statusCode : 500).send(errorResponse(error instanceof CommandError ? error.message : "Unable to save pharmacy tax settings"));
}
export async function getPharmacyTaxProfile(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  const { locationId } = req.params as { locationId: string };
  if (!mongoose.isValidObjectId(locationId)) return reply.code(400).send(errorResponse("Invalid location"));
  const access = await checkLocationAccess(req, locationId);
  if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
  const profile = await PharmacyTaxProfile.findOne({ locationId, organizationId: access.organizationId }).lean();
  return reply.send(successResponse(profile ? { ...profile, issueSupported: profile.pricesIncludeTax && !profile.electronicReportingRequired } : null));
}
export async function savePharmacyTaxProfile(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId } = req.params as { locationId: string };
    if (!mongoose.isValidObjectId(locationId)) throw new CommandError(400, "Invalid location");
    const access = await checkLocationAccess(req, locationId);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const { expectedRevision: revision, ...profile } = req.body as any;
    expectedRevision(revision);
    // Preserve a valid declaration of unsupported requirements so it disables future issue,
    // rather than leaving an older supported profile active after a rejected edit.
    validatePharmacyProfile(profile, false);
    const saved = await withTransaction(async () => {
      const location = await Location.findOneAndUpdate({ _id: locationId, organizationId: access.organizationId, isActive: true }, { $inc: { __v: 1 } });
      const organization = await Organization.findById(access.organizationId).select("countryCode currency").lean();
      if (!location || !organization || organization.countryCode !== "IN" || organization.currency !== "INR") throw new CommandError(409, "This pharmacy document profile requires an explicit India/INR organization");
      const current = await PharmacyTaxProfile.findOne({ locationId, organizationId: access.organizationId });
      if ((current?.revision || 0) !== revision) throw new CommandError(409, "Pharmacy profile changed; reload before saving");
      const payload = { ...profile, gstin: profile.registration === "unregistered" ? "" : profile.gstin, organizationId: access.organizationId, locationId, revision: revision + 1,
        confirmedBy: req.user!.id, confirmedAt: new Date() };
      const result = current ? await PharmacyTaxProfile.findOneAndUpdate({ _id: current._id, revision }, { $set: payload }, { returnDocument: "after", runValidators: true }) : await PharmacyTaxProfile.create(payload);
      if (!result) throw new CommandError(409, "Pharmacy profile changed; reload before saving");
      await AuditLog.create({ organizationId: access.organizationId, userId: req.user!.id, action: "PHARMACY_TAX_PROFILE_REVIEWED", targetId: result._id,
        targetModel: "PharmacyTaxProfile", category: "ADMIN", details: { revision: revision + 1, locationId } });
      return result;
    });
    const issueSupported = saved.pricesIncludeTax && !saved.electronicReportingRequired;
    return reply.send(successResponse({ ...saved.toJSON(), issueSupported }, issueSupported ? "Reviewed pharmacy issuer profile saved"
      : "Profile saved; pharmacy document issue is blocked by unsupported requirements"));
  } catch (error) { return respondError(reply, error); }
}
export async function reviewMedicineTax(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.isValidObjectId(id)) throw new CommandError(400, "Invalid medicine");
    const medicine = await Medicine.findOne({ _id: id, deletedAt: null });
    if (!medicine) throw new CommandError(404, "Medicine not found");
    const access = await checkOperationalRecordAccess(req, medicine);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const { expectedRevision: revision, hsnCode, unitCode, gstRate, treatment, reviewReference } = req.body as any;
    expectedRevision(revision);
    inclusiveTax(0, gstRate);
    if (!/^\d{4}(\d{2})?(\d{2})?$/.test(hsnCode) || !/^[A-Z]{3}$/.test(unitCode) || !["taxable", "exempt", "nil_rated"].includes(treatment) ||
        (treatment === "taxable" ? gstRate <= 0 : gstRate !== 0) || typeof reviewReference !== "string" || reviewReference.trim().length < 3) {
      throw new CommandError(409, "Review the medicine HSN, tax treatment, rate and supporting reference");
    }
    const saved = await withTransaction(async () => {
      const updated = await Medicine.findOneAndUpdate({ _id: id, locationId: medicine.locationId, deletedAt: null,
        ...(revision === 0 ? { $or: [{ taxRevision: 0 }, { taxRevision: { $exists: false } }] } : { taxRevision: revision }) },
      { $set: { hsnCode, gstRate, taxClassification: { hsnCode, unitCode, gstRate, treatment, reviewReference,
        confirmedBy: req.user!.id, confirmedAt: new Date() } }, $inc: { taxRevision: 1 } }, { returnDocument: "after", runValidators: true });
      if (!updated) throw new CommandError(409, "Medicine tax classification changed; reload before saving");
      await AuditLog.create({ organizationId: access.organizationId, userId: req.user!.id, action: "PHARMACY_MEDICINE_TAX_REVIEWED", targetId: medicine._id,
        targetModel: "Medicine", category: "ADMIN", details: { revision: revision + 1 } });
      return updated;
    });
    return reply.send(successResponse({ id: saved.id, taxRevision: saved.taxRevision, taxClassification: saved.taxClassification,
      hsnCode: saved.hsnCode, gstRate: saved.gstRate }, "Reviewed medicine tax classification saved"));
  } catch (error) { return respondError(reply, error); }
}
