import type { FastifyRequest, FastifyReply } from "fastify";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { deactivateDoctorAssignments } from '../services/DoctorAssignmentRecoveryEvents.ts';
import { Receptionist } from "../models/Receptionist.ts";
import { errorResponse, successResponse, revokeAllRefreshTokens } from "../utilities/helpers.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { revokeSession } from "../utilities/sessionResolver.ts";
import { WorkspaceError } from "../services/WorkspaceService.ts";
import { unassignRevokedCrmWork } from "../services/CrmRevocationService.ts";
import { assertOtherActiveAdministrator } from '../services/OrganizationGovernanceService.ts';
import { CommandError } from '../services/CommandReceiptService.ts';

export async function updateMemberLocationAccess(req: FastifyRequest, reply: FastifyReply) {
  const { id, userId } = req.params as { id: string; userId: string };
  if (req.user?.role !== "root" && req.user?.organization_id !== id) return reply.code(403).send(errorResponse("Unauthorized organization"));
  if (req.user!.id === userId) return reply.code(403).send(errorResponse("Another administrator must review your own location access"));
  const { mode, locationIds, expectedRevision } = req.body as { mode: "all" | "selected"; locationIds: string[]; expectedRevision: number };
  const ids = [...new Set(locationIds)];
  if (mode === "all" && ids.length) return reply.code(400).send(errorResponse("All-location access must not include selected locations"));
  const member = await OrgMember.findOne({ userId, organizationId: id }).select("role accessRevision").lean();
  if (!member || ["root", "patient", "family_member", "guest"].includes(member.role)) return reply.code(404).send(errorResponse("Staff membership not found"));
  const activeUser = await User.exists({ _id: userId, isActive: true });
  if (!activeUser) return reply.code(409).send(errorResponse("Member identity is inactive"));
  if (await Location.countDocuments({ _id: { $in: ids }, organizationId: id, isActive: { $ne: false } }) !== ids.length) {
    return reply.code(400).send(errorResponse("Select active locations in this organization"));
  }
  if ((member.accessRevision || 0) !== expectedRevision) return reply.code(409).send(errorResponse("Membership access changed; reload before saving"));
  let updated;
  let sessions;
  try {
    const result = await withTransaction(async (session) => {
      const updated = await OrgMember.findOneAndUpdate({ _id: member._id,
        ...(expectedRevision === 0 ? { $or: [{ accessRevision: 0 }, { accessRevision: { $exists: false } }] } : { accessRevision: expectedRevision }) },
        { $set: { locationAccess: { mode, locationIds: ids } }, $inc: { accessRevision: 1 } }, { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) });
      if (!updated) throw new WorkspaceError(409, "Membership access changed; reload before saving");
      const crmHandoff = mode === "selected" ? await unassignRevokedCrmWork(id, userId, ids) : undefined;
      await AuditLog.create([{ userId: req.user!.id, organizationId: id, action: "MEMBER_LOCATION_ACCESS_CHANGED",
        targetId: updated._id, targetModel: "OrgMember", details: { mode, locationIds: ids, accessRevision: updated.accessRevision, crmHandoff } }], session ? { session } : {});
      const sessions = await RefreshToken.find({ userId, organizationId: id, revoked: false }).select("_id").lean();
      await RefreshToken.updateMany({ userId, organizationId: id, revoked: false }, { $set: { revoked: true, revocationReason: "terminated" } }, session ? { session } : {});
      return { updated, sessions };
    });
    updated = result.updated;
    sessions = result.sessions;
  } catch (error) {
    if (error instanceof WorkspaceError) return reply.code(error.statusCode).send(errorResponse(error.message));
    throw error;
  }
  for (const session of sessions) await revokeSession(String(session._id), "terminated");
  return reply.send(successResponse({ locationAccess: updated.locationAccess, accessRevision: updated.accessRevision }, "Location access updated; affected sessions must sign in again"));
}

export async function removeOrganizationMember(req: FastifyRequest, reply: FastifyReply) {
  const { id, userId } = req.params as { id: string; userId: string };
  if (req.user?.role !== "root" && req.user?.organization_id !== id) return reply.code(403).send(errorResponse("Unauthorized organization"));
  if (req.user!.id === userId) return reply.code(400).send(errorResponse("Cannot remove your own active membership"));
  const member = await OrgMember.findOne({ userId, organizationId: id });
  const user = await User.findById(userId).select("role");
  if (!member || !user) return reply.code(404).send(errorResponse("Membership not found"));
  if (user.role === "root") return reply.code(403).send(errorResponse("Root identities are managed at platform level"));
  const sessions = await withTransaction(async (session) => {
    const options = session ? { session } : {};
    const current = await OrgMember.findOne({ userId, organizationId: id });
    if (!current) throw new CommandError(404, 'Membership not found');
    if (current.role === 'admin') await assertOtherActiveAdministrator(id, userId);
    await OrgMember.deleteOne({ _id: current._id, organizationId: id }, options);
    await Doctor.updateMany({ userId, organizationId: id }, { $set: { isActive: false } }, options);
    await deactivateDoctorAssignments(id, userId, req.user!.id);
    await Receptionist.deleteMany({ userId, organizationId: id }, options);
    const crmHandoff = await unassignRevokedCrmWork(id, userId);
    await AuditLog.create([{ organizationId: id, userId: req.user!.id, action: "ORGANIZATION_MEMBER_REMOVED", targetId: member._id, targetModel: "OrgMember", details: { userId, crmHandoff } }], options);
    const sessions = await RefreshToken.find({ userId, organizationId: id, revoked: false }).select("_id").lean();
    await RefreshToken.updateMany({ userId, organizationId: id, revoked: false }, { $set: { revoked: true, revocationReason: "terminated" } }, options);
    return sessions;
  });
  for (const session of sessions) await revokeSession(String(session._id), "terminated");
  return reply.send(successResponse(null, "Organization membership removed; the global identity is retained"));
}

export async function updateGlobalUserStatus(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== "root") return reply.code(403).send(errorResponse("Only Root can manage global identities"));
  const { id } = req.params as { id: string };
  const { isActive } = req.body as { isActive: boolean };
  if (id === req.user.id) return reply.code(400).send(errorResponse("Cannot deactivate your own active identity"));
  let user;
  try {
    user = await withTransaction(async () => {
      const memberships = !isActive ? await OrgMember.find({ userId: id }).select('organizationId role').limit(1001).lean() : [];
      if (memberships.length > 1000) throw new CommandError(409, 'This account requires a staged membership review');
      const changed = await User.findByIdAndUpdate(id, { $set: { isActive }, $inc: { authVersion: 1 } }, { returnDocument: 'after' }).select('name email role isActive');
      if (!changed) throw new CommandError(404, 'User not found');
      for (const member of memberships.sort((a, b) => String(a.organizationId).localeCompare(String(b.organizationId)))) {
        if (member.role === 'admin') await assertOtherActiveAdministrator(String(member.organizationId), id);
        await unassignRevokedCrmWork(String(member.organizationId), id);
        await deactivateDoctorAssignments(String(member.organizationId), id, req.user!.id);
      }
      await AuditLog.create({ userId: req.user!.id, action: 'GLOBAL_USER_STATUS_CHANGED', targetId: changed._id, targetModel: 'User', category: 'ADMIN', details: { isActive, affectedMemberships: memberships.length } });
      await RefreshToken.updateMany({ userId: id, revoked: false }, { $set: { revoked: true, revocationReason: 'terminated' } });
      return changed;
    });
  } catch (error) {
    if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    throw error;
  }
  await revokeAllRefreshTokens(id);
  return reply.send(successResponse(user));
}
