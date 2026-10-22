import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { Medicine } from "../models/Medicine.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { checkLocationAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";

function revisionFilter(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new CommandError(400, "Invalid expectedRevision");
  return revision;
}
function failure(reply: FastifyReply, error: unknown) {
  return reply.code(error instanceof CommandError ? error.statusCode : 500).send(errorResponse(error instanceof CommandError ? error.message : "Unable to record dispensing review"));
}
export async function getPharmacyProfessionalReview(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  const { locationId, userId, profession } = req.params as { locationId: string; userId: string; profession: "pharmacist" | "prescriber" };
  if (!mongoose.isValidObjectId(locationId) || !mongoose.isValidObjectId(userId) || !["pharmacist", "prescriber"].includes(profession)) return reply.code(400).send(errorResponse("Invalid professional review subject"));
  const access = await checkLocationAccess(req, locationId);
  if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
  return reply.send(successResponse(await PharmacyProfessionalReview.findOne({ organizationId: access.organizationId, locationId, userId, profession }).lean()));
}
export async function savePharmacyProfessionalReview(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId, userId, profession } = req.params as { locationId: string; userId: string; profession: "pharmacist" | "prescriber" };
    if (!mongoose.isValidObjectId(locationId) || !mongoose.isValidObjectId(userId) || !["pharmacist", "prescriber"].includes(profession)) throw new CommandError(400, "Invalid professional review subject");
    const access = await checkLocationAccess(req, locationId);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const { expectedRevision, ...declaration } = req.body as any;
    const revision = revisionFilter(expectedRevision);
    if (![declaration.registrationNumber, declaration.council, declaration.address, declaration.reviewReference].every(genuineDetail)) throw new CommandError(409, "Complete genuine professional evidence details");
    if (declaration.active && new Date(declaration.validUntil).getTime() <= Date.now()) throw new CommandError(409, "Active professional review must have a future review deadline");
    const saved = await withTransaction(async () => {
      const member = await OrgMember.findOneAndUpdate({ userId, organizationId: access.organizationId, role: { $nin: ["patient", "family_member", "guest"] } }, { $inc: { __v: 1 } });
      const user = await User.findOne({ _id: userId, isActive: true });
      if (!member || !user) throw new CommandError(404, "Active staff member not found");
      if (profession === "prescriber" && !await Doctor.exists({ userId, organizationId: access.organizationId, isActive: true, registrationNumber: declaration.registrationNumber })) throw new CommandError(409, "Prescriber registration must match the active doctor profile");
      const scope = { organizationId: access.organizationId, locationId, userId, profession };
      const current = await PharmacyProfessionalReview.findOne(scope);
      if ((current?.revision || 0) !== revision) throw new CommandError(409, "Professional review changed; reload before saving");
      const payload = { ...declaration, ...scope, revision: revision + 1, confirmedBy: req.user!.id, confirmedAt: new Date() };
      const result = current ? await PharmacyProfessionalReview.findOneAndUpdate({ _id: current._id, revision }, { $set: payload }, { returnDocument: "after", runValidators: true }) : await PharmacyProfessionalReview.create(payload);
      if (!result) throw new CommandError(409, "Professional review changed; reload before saving");
      await AuditLog.create({ organizationId: access.organizationId, userId: req.user!.id, action: "PHARMACY_PROFESSIONAL_REVIEWED", targetId: result._id, targetModel: "PharmacyProfessionalReview", category: "ADMIN", details: { revision: revision + 1, locationId, profession } });
      return result;
    });
    return reply.send(successResponse(saved));
  } catch (error) { return failure(reply, error); }
}
export async function reviewMedicineDispensing(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.isValidObjectId(id)) throw new CommandError(400, "Invalid medicine");
    const medicine = await Medicine.findOne({ _id: id, deletedAt: null });
    if (!medicine) throw new CommandError(404, "Medicine not found");
    const access = await checkOperationalRecordAccess(req, medicine);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const { expectedRevision, scheduleType, reviewReference } = req.body as any;
    const revision = revisionFilter(expectedRevision);
    if (!genuineDetail(reviewReference)) throw new CommandError(409, "A genuine classification review reference is required");
    const saved = await withTransaction(async () => {
      const updated = await Medicine.findOneAndUpdate({ _id: id, locationId: medicine.locationId, deletedAt: null,
        ...(revision ? { dispensingRevision: revision } : { $or: [{ dispensingRevision: 0 }, { dispensingRevision: { $exists: false } }] }) },
      { $set: { scheduleType, dispensingReview: { scheduleType, reviewReference, confirmedBy: req.user!.id, confirmedAt: new Date() } }, $inc: { dispensingRevision: 1 } }, { returnDocument: "after", runValidators: true });
      if (!updated) throw new CommandError(409, "Dispensing classification changed; reload before saving");
      await AuditLog.create({ organizationId: access.organizationId, userId: req.user!.id, action: "PHARMACY_DISPENSING_CLASSIFICATION_REVIEWED", targetId: medicine._id, targetModel: "Medicine", category: "ADMIN", details: { revision: revision + 1, scheduleType } });
      return updated;
    });
    return reply.send(successResponse({ id: saved.id, dispensingRevision: saved.dispensingRevision, scheduleType: saved.scheduleType, dispensingReview: saved.dispensingReview }));
  } catch (error) { return failure(reply, error); }
}
