import type { FastifyRequest, FastifyReply } from "fastify";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { errorResponse, successResponse, revokeAllRefreshTokens } from "../utilities/helpers.ts";
import { withTransaction } from "../utilities/transaction.ts";

export async function removeOrganizationMember(req: FastifyRequest, reply: FastifyReply) {
  const { id, userId } = req.params as { id: string; userId: string };
  if (req.user?.role !== "root" && req.user?.organization_id !== id) return reply.code(403).send(errorResponse("Unauthorized organization"));
  if (req.user!.id === userId) return reply.code(400).send(errorResponse("Cannot remove your own active membership"));
  const member = await OrgMember.findOne({ userId, organizationId: id });
  const user = await User.findById(userId).select("role");
  if (!member || !user) return reply.code(404).send(errorResponse("Membership not found"));
  if (user.role === "root") return reply.code(403).send(errorResponse("Root identities are managed at platform level"));
  if (member.role === "admin") {
    const others = await OrgMember.find({ organizationId: id, role: "admin", userId: { $ne: userId } }).populate("userId", "isActive").lean();
    if (!others.some((m: any) => m.userId && m.userId.isActive !== false)) return reply.code(409).send(errorResponse("Keep at least one active organization administrator"));
  }
  await withTransaction(async (session) => {
    const options = session ? { session } : {};
    await OrgMember.deleteOne({ _id: member._id }, options);
    await Doctor.updateMany({ userId, organizationId: id }, { $set: { isActive: false } }, options);
    await DoctorAssignment.updateMany({ doctorId: userId, organizationId: id }, { $set: { isActive: false } }, options);
    await Receptionist.deleteMany({ userId, organizationId: id }, options);
    await User.updateOne({ _id: userId }, { $inc: { authVersion: 1 } }, options);
  });
  await revokeAllRefreshTokens(userId);
  return reply.send(successResponse(null, "Organization membership removed; the global identity is retained"));
}

export async function updateGlobalUserStatus(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== "root") return reply.code(403).send(errorResponse("Only Root can manage global identities"));
  const { id } = req.params as { id: string };
  const { isActive } = req.body as { isActive: boolean };
  if (id === req.user.id) return reply.code(400).send(errorResponse("Cannot deactivate your own active identity"));
  const user = await User.findByIdAndUpdate(id, { $set: { isActive }, $inc: { authVersion: 1 } }, { returnDocument: "after" }).select("name email role isActive");
  if (!user) return reply.code(404).send(errorResponse("User not found"));
  await revokeAllRefreshTokens(id);
  return reply.send(successResponse(user));
}
