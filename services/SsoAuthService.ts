import { User } from "../models/User.ts";
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

  if (!user) {
    user = await User.create({
      email: cleanEmail,
      name: identity.name || cleanEmail.split("@")[0],
      password: `SSO_${Date.now()}_${Math.random()}`,
      role: "doctor", // Default enterprise role for SSO onboarded staff
      isEmailVerified: true,
      isActive: true,
    });
  }

  const tokenPayload = {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = await createRefreshToken(user._id.toString());

  return {
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
    },
    accessToken,
    refreshToken,
  };
}
