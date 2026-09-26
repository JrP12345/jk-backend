import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { revokeSession } from "../utilities/sessionResolver.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function listOwnerSessionPolicies(_req: FastifyRequest, reply: FastifyReply) {
  const owners = await User.find({ role: "admin" }).select("name email isActive adminSessionLimit").sort({ name: 1 }).lean();
  const memberships = await OrgMember.find({ userId: { $in: owners.map((owner) => owner._id) } }).populate("organizationId", "name").lean();
  const sessions = await RefreshToken.find({ userId: { $in: owners.map((owner) => owner._id) }, revoked: false, expiresAt: { $gt: new Date() } }).select("userId").lean();
  return reply.send(successResponse(owners.map((owner) => ({
    id: owner._id.toString(), name: owner.name, email: owner.email,
    limit: (owner as any).adminSessionLimit ?? null,
    activeSessions: sessions.filter((session) => session.userId.equals(owner._id)).length,
    organizations: memberships.filter((member) => member.userId.equals(owner._id)).map((member: any) => member.organizationId?.name).filter(Boolean),
  }))));
}

export async function updateOwnerSessionPolicy(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req.params as { userId: string };
  const { limit } = req.body as { limit: number | null };
  if (!mongoose.Types.ObjectId.isValid(userId) || (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1000))) {
    return reply.code(400).send(errorResponse("Use a limit between 1 and 1000, or null for unlimited sessions"));
  }
  const owner = await User.findOneAndUpdate({ _id: userId, role: "admin" }, { $set: { adminSessionLimit: limit } }, { new: true });
  if (!owner) return reply.code(404).send(errorResponse("Organization owner not found"));
  if (limit !== null) {
    const sessions = await RefreshToken.find({ userId, revoked: false, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).select("_id").lean();
    for (const session of sessions.slice(limit)) await revokeSession(session._id.toString(), "displaced");
  }
  return reply.send(successResponse({ limit }, "Owner session limit updated"));
}
