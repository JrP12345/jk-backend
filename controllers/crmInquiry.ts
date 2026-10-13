import type { FastifyRequest, FastifyReply } from "fastify";
import { syncInquiryTask } from "../services/CrmTaskService.ts";
import mongoose from "mongoose";
import { Inquiry } from "../models/Inquiry.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { crmAuthority, crmPatientAuthority } from "../services/CrmAuthorityService.ts";
import { validateCrmAssignee } from "../services/CrmAssignmentService.ts";
import { CommandError, executeRecordedCommand } from "../services/CommandReceiptService.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";
import { successResponse, errorResponse, normalizePhone, escapeRegex } from "../utilities/helpers.ts";

function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, "Inquiry workflow failed");
  return reply.code(503).send(errorResponse("The inquiry result could not be confirmed. Retry the same request."));
}
export function inquiryDTO(row: any) {
  return { id: String(row._id), locationId: String(row.locationId), patientId: row.patientId ? String(row.patientId) : undefined,
    callerName: row.callerName || "", phone: row.phone || "", email: row.email || "", source: row.source, sourceEvidence: row.sourceEvidence,
    reasonForContact: row.reasonForContact, requestedService: row.requestedService || "", status: row.status, ownerId: row.ownerId ? String(row.ownerId._id || row.ownerId) : null,
    ownerName: row.ownerId?.name,
    nextAction: row.nextAction, closeReason: row.closeReason, duplicateInquiryId: row.duplicateInquiryId ? String(row.duplicateInquiryId) : undefined,
    appointmentId: row.appointmentId ? String(row.appointmentId) : undefined, revision: row.revision || 0, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function scopeFilter(authority: Awaited<ReturnType<typeof crmAuthority>>) {
  return { organizationId: authority.organizationId, ...(authority.locationIds ? { locationId: { $in: authority.locationIds } } : {}) };
}
export async function inquiryAuthority(req: FastifyRequest, id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new CommandError(400, "Invalid inquiry reference");
  const authority = await crmAuthority(req);
  const inquiry = await Inquiry.findOne({ _id: id, ...scopeFilter(authority) });
  if (!inquiry) throw new CommandError(404, "Inquiry not found in your branches");
  return { ...authority, inquiry };
}
async function normalizeInput(req: FastifyRequest, input: any, organizationId: string, actorId: string, current?: any) {
  const locationId = input.locationId || String(current?.locationId || "");
  const branch = await checkLocationAccess(req, locationId, { requireExplicitScope: true });
  if (!branch.allowed || branch.organizationId !== organizationId) throw new CommandError(404, "Branch not available in this workspace");
  const ownerId = input.ownerId === undefined ? (current ? current.ownerId?.toString() || null : req.user?.role === "root" ? null : actorId) : input.ownerId;
  const changingOwner = current ? (ownerId || "") !== (current.ownerId?.toString() || "") : ownerId !== actorId;
  if ((changingOwner && !(current && !current.ownerId && ownerId === actorId)) || (current && locationId !== String(current.locationId))) {
    if (!await requestHasAnyPermission(req, "ASSIGN_CRM_TASKS")) throw new CommandError(403, "Team assignment permission is required");
  }
  if (ownerId) await validateCrmAssignee(ownerId, organizationId, locationId, "MANAGE_CRM_INQUIRIES");
  if (input.patientId) await crmPatientAuthority(req, input.patientId);
  const phone = input.phone === undefined ? current?.phone : input.phone ? normalizePhone(input.phone) : "";
  if (phone && !/^\d{10}$/.test(phone)) throw new CommandError(400, "Enter a valid Indian contact number");
  const email = input.email === undefined ? current?.email : input.email.trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CommandError(400, "Enter a valid contact email");
  const source = input.source || current?.source || "unknown";
  const nextAction = input.nextAction || current?.nextAction;
  if (!nextAction?.kind || !Number.isFinite(new Date(nextAction.dueAt).getTime())) throw new CommandError(400, "Choose a next action and a valid due time");
  return { locationId, ownerId, patientId: input.patientId || current?.patientId, callerName: input.callerName?.trim() ?? current?.callerName,
    phone, email, source, sourceEvidence: source === "unknown" ? "unknown" : "staff_reported", reasonForContact: input.reasonForContact || current?.reasonForContact || "unknown",
    requestedService: input.requestedService?.trim() ?? current?.requestedService, nextAction };
}
export async function createInquiry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), input = req.body as any;
    const result = await executeRecordedCommand(`inquiry-create:${authority.organizationId}:${authority.actorId}`, input.clientRequestId, input, async () => {
      const fields = await normalizeInput(req, input, authority.organizationId, authority.actorId);
      const inquiry = await Inquiry.create({ ...fields, organizationId: authority.organizationId, createdBy: authority.actorId });
      await syncInquiryTask(inquiry, authority.actorId, true);
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: fields.locationId, inquiryId: inquiry._id, patientId: fields.patientId,
        actorId: authority.actorId, kind: "inquiry_created", outcome: fields.source, note: input.note?.trim(), revision: 0 });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: "CRM_INQUIRY_CREATED", targetId: inquiry._id, targetModel: "Inquiry", category: "ADMIN", details: { locationId: fields.locationId } });
      return inquiry.id;
    });
    const inquiry = await Inquiry.findOne({ _id: result.resultId, ...scopeFilter(authority) }).lean();
    if (!inquiry) throw new CommandError(404, "Inquiry is no longer in your branches");
    return reply.code(result.replayed ? 200 : 201).send(successResponse(inquiryDTO(inquiry), result.replayed ? "Existing inquiry restored" : "Inquiry captured"));
  } catch (error) { return failure(req, reply, error); }
}
export async function listInquiries(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), query = req.query as any;
    const filter: any = scopeFilter(authority);
    if (query.locationId) {
      const branch = await checkLocationAccess(req, query.locationId, { requireExplicitScope: true });
      if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(404, "Branch not available");
      filter.locationId = query.locationId;
    }
    if (query.cursor) { if (!mongoose.Types.ObjectId.isValid(query.cursor)) throw new CommandError(400, "Invalid page cursor"); filter._id = { $lt: query.cursor }; }
    if (query.owner === "mine") filter.ownerId = authority.actorId;
    else if (query.owner === "unassigned") filter.ownerId = null;
    if (query.status === "active" || !query.status) filter.status = { $in: ["open", "in_progress"] };
    else if (["closed", "converted", "open", "in_progress"].includes(query.status)) filter.status = query.status;
    else if (query.status !== "all") throw new CommandError(400, "Choose a valid inquiry status");
    if (query.overdue === "true") filter["nextAction.dueAt"] = { $lte: new Date() };
    if (query.search?.trim()) { const pattern = { $regex: escapeRegex(query.search.trim().slice(0, 120)), $options: "i" }; filter.$or = ["callerName", "phone", "email", "requestedService"].map(field => ({ [field]: pattern })); }
    const rows = await Inquiry.find(filter).populate("ownerId", "name").sort({ _id: -1 }).limit(21).maxTimeMS(5000).lean();
    return reply.send(successResponse({ items: rows.slice(0, 20).map(inquiryDTO), nextCursor: rows.length > 20 ? String(rows[19]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function getInquiry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await inquiryAuthority(req, (req.params as any).id);
    await authority.inquiry.populate("ownerId", "name");
    const cursor = (req.query as any).activityCursor;
    if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) throw new CommandError(400, "Invalid activity cursor");
    const activities = await CrmActivity.find({ organizationId: authority.organizationId, inquiryId: authority.inquiry._id, visibility: "administrative", ...(cursor ? { _id: { $lt: cursor } } : {}) })
      .select("kind outcome actorId createdAt revision +note").populate("actorId", "name").sort({ _id: -1 }).limit(21);
    return reply.send(successResponse({ inquiry: inquiryDTO(authority.inquiry), activities: activities.slice(0, 20).map(row => ({ id: row.id, kind: row.kind, outcome: row.outcome,
      actorName: (row.actorId as any)?.name || "Staff", createdAt: row.createdAt, note: row.note, revision: row.revision })), nextActivityCursor: activities.length > 20 ? activities[19].id : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function updateInquiry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await inquiryAuthority(req, (req.params as any).id), input = req.body as any, id = authority.inquiry.id;
    await executeRecordedCommand(`inquiry-update:${authority.organizationId}:${authority.actorId}:${id}`, input.clientRequestId, input, async () => {
      const current = await Inquiry.findOne({ _id: id, ...scopeFilter(authority) });
      if (!current || current.revision !== input.expectedRevision) throw new CommandError(409, "Inquiry changed. Reload before saving.");
      if (current.status === "converted") throw new CommandError(409, "Converted inquiries retain their canonical booking link");
      if (current.ownerId && String(current.ownerId) !== authority.actorId && !await requestHasAnyPermission(req, "ASSIGN_CRM_TASKS")) throw new CommandError(403, "Only the owner or an authorized team manager can change this inquiry");
      const fields = await normalizeInput(req, input, authority.organizationId, authority.actorId, current);
      const status = input.status || current.status;
      if (current.status === "closed" && status !== "closed" && !input.nextAction) throw new CommandError(400, "Choose a fresh next action when reopening");
      const changes: any = { ...fields, status };
      if (status === "closed") {
        if (!input.closeReason && !current.closeReason) throw new CommandError(400, "Choose a close outcome");
        changes.closeReason = input.closeReason || current.closeReason; changes.closedAt = current.status === "closed" ? current.closedAt : new Date();
        if (changes.closeReason === "other" && !input.note?.trim()) throw new CommandError(400, "Record a close reason");
        if (changes.closeReason === "duplicate_inquiry") {
          if (!input.duplicateInquiryId || input.duplicateInquiryId === id || !await Inquiry.exists({ _id: input.duplicateInquiryId, ...scopeFilter(authority) })) throw new CommandError(400, "Choose a separate inquiry in your authorized branches");
          changes.duplicateInquiryId = input.duplicateInquiryId;
        }
      }
      const changed = await Inquiry.updateOne({ _id: id, organizationId: authority.organizationId, revision: input.expectedRevision }, { $set: changes,
        ...(status !== "closed" ? { $unset: { closedAt: 1, closeReason: 1, duplicateInquiryId: 1 } } : {}), $inc: { revision: 1 } }, { runValidators: true });
      if (changed.modifiedCount !== 1) throw new CommandError(409, "Inquiry changed. Reload before saving.");
      await syncInquiryTask(await Inquiry.findOne({ _id: id, organizationId: authority.organizationId }), authority.actorId,
        !!input.nextAction || (current.status === "closed" && status !== "closed"));
      const kind = status === "closed" && current.status !== "closed" ? "inquiry_closed" : current.status === "closed" && status !== "closed" ? "inquiry_reopened"
        : String(fields.locationId) !== String(current.locationId) ? "inquiry_branch_transferred" : String(fields.ownerId || "") !== String(current.ownerId || "") ? "inquiry_reassigned" : "inquiry_updated";
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: fields.locationId, inquiryId: id, patientId: fields.patientId, actorId: authority.actorId,
        kind, outcome: changes.closeReason || status, note: input.note?.trim(), revision: input.expectedRevision + 1 });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: "CRM_INQUIRY_UPDATED", targetId: id, targetModel: "Inquiry", category: "ADMIN",
        details: { revision: input.expectedRevision + 1, status, ownerId: fields.ownerId, locationId: fields.locationId } });
      return id;
    });
    return getInquiry(req, reply);
  } catch (error) { return failure(req, reply, error); }
}
export async function listCrmAssignees(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), { locationId, cursor, purpose } = req.query as any;
    if (purpose && !["inquiry", "task", "relationship"].includes(purpose)) throw new CommandError(400, "Choose a valid assignment purpose");
    if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) throw new CommandError(400, "Invalid assignee cursor");
    const branch = await checkLocationAccess(req, locationId, { requireExplicitScope: true });
    if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(404, "Select an authorized branch");
    const team = await requestHasAnyPermission(req, "ASSIGN_CRM_TASKS");
    const members = await OrgMember.find({ organizationId: authority.organizationId, ...(team ? {} : { userId: authority.actorId }), ...(cursor ? { _id: { $gt: cursor } } : {}), role: { $nin: ["patient", "family_member", "guest", "root"] } }).sort({ _id: 1 }).limit(51).lean();
    const items = [];
    for (const member of members.slice(0, 50)) {
      try {
        await validateCrmAssignee(String(member.userId), authority.organizationId, locationId, purpose === "inquiry" ? "MANAGE_CRM_INQUIRIES" : purpose === "task" ? "MANAGE_CRM_TASKS" : "VIEW_CRM");
        const user = await User.findById(member.userId).select("name").lean();
        if (user) items.push({ id: String(user._id), name: user.name, role: member.role });
      } catch (error) { if (!(error instanceof CommandError)) throw error; }
    }
    return reply.send(successResponse({ items, nextCursor: members.length > 50 ? String(members[49]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
