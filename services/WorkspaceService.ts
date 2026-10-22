import crypto from "node:crypto";
import mongoose from "mongoose";
import { OrgMember } from "../models/OrgMember.ts";
import { Organization } from "../models/Organization.ts";
import { PasskeyChallenge } from "../models/PasskeyChallenge.ts";

export const isConsumerRole = (role: string) => ["patient", "family_member", "guest"].includes(role);
export class WorkspaceError extends Error {
  public statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function listUserWorkspaces(userId: string) {
  const memberships = await OrgMember.find({ userId }).select("organizationId role").limit(101).lean();
  if (memberships.length > 100) throw new WorkspaceError(403, "Workspace membership limit exceeded; contact support");
  const organizations = await Organization.find({
    _id: { $in: memberships.map(member => member.organizationId) },
    isActive: { $ne: false }, status: { $ne: "inactive" },
  }).select("name").lean();
  const names = new Map(organizations.map(org => [String(org._id), org.name]));
  return memberships.filter(member => names.has(String(member.organizationId)) &&
    member.role !== "root" && !isConsumerRole(member.role)).map(member => ({
      organizationId: String(member.organizationId), name: names.get(String(member.organizationId))!, role: member.role,
    })).sort((a, b) => a.name.localeCompare(b.name) || a.organizationId.localeCompare(b.organizationId));
}

/** Selected organization is an assertion checked against current membership, never a header grant. */
export async function authorizeWorkspace(userId: string, organizationId: string) {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) throw new WorkspaceError(400, "Invalid organization ID");
  const membership = await OrgMember.findOne({ userId, organizationId }).select("role").lean();
  if (!membership || membership.role === "root" || isConsumerRole(membership.role)) {
    throw new WorkspaceError(403, "Organization workspace is unavailable");
  }
  const organization = await Organization.findOne({ _id: organizationId,
    isActive: { $ne: false }, status: { $ne: "inactive" } }).select("workspaceProfile staffMfaRequired").lean();
  if (!organization) throw new WorkspaceError(403, "Organization workspace is inactive or suspended");
  return { organizationId, role: membership.role, workspaceProfile: organization.workspaceProfile || "clinic", staffMfaRequired: organization.staffMfaRequired === true };
}

/** Opaque, single-use proof issued only after credentials and any configured MFA succeed. */
export async function createWorkspaceChallenge(userId: string, authVersion: number, mfaEnabled: boolean) {
  const token = crypto.randomBytes(32).toString("base64url");
  await PasskeyChallenge.create({ tokenHash: hash(token), challenge: "workspace-selection", kind: "workspace",
    userId, authVersion, mfaEnabled, expiresAt: new Date(Date.now() + 5 * 60_000) });
  return token;
}

export async function readWorkspaceChallenge(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new WorkspaceError(401, "Workspace selection expired; sign in again");
  const challenge = await PasskeyChallenge.findOne({ tokenHash: hash(token), kind: "workspace", expiresAt: { $gt: new Date() } }).lean();
  if (!challenge) throw new WorkspaceError(401, "Workspace selection expired or already used; sign in again");
  return challenge;
}

export async function consumeWorkspaceChallenge(id: string) {
  const result = await PasskeyChallenge.deleteOne({ _id: id, kind: "workspace", expiresAt: { $gt: new Date() } });
  if (!result.deletedCount) throw new WorkspaceError(401, "Workspace selection expired or already used; sign in again");
}
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
