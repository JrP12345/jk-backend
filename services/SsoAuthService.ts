import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { generateAccessToken, createRefreshToken } from "../utilities/helpers.ts";

export interface SsoIdentityPayload {
  email: string;
  name: string;
  provider: "azure_ad" | "okta" | "google_workspace" | "saml2";
  externalId: string;
}

export async function processSsoLogin(identity: SsoIdentityPayload) {
  const cleanEmail = identity.email.toLowerCase().trim();

  let user = await User.findOne({ email: cleanEmail });

  if (!user || !user.isActive) throw new Error("SSO identity is not provisioned for this platform");
  const membership = await OrgMember.findOne({ userId: user._id, status: { $ne: "inactive" } }).sort({ createdAt: 1 }).lean();
  if (!membership) throw new Error("SSO identity has no active organization membership");

  const tokenPayload = {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    organization_id: membership.organizationId.toString(),
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = await createRefreshToken(user._id.toString());

  return {
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      organization_id: membership.organizationId.toString(),
    },
    accessToken,
    refreshToken,
  };
}
