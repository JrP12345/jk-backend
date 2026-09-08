import crypto from "node:crypto";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { generateAccessToken, createRefreshToken } from "../utilities/helpers.ts";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  email_verified?: boolean;
}

/**
 * Validates a Google ID token by querying Google's OAuth2 tokeninfo endpoint
 * or verifying against Google's public certificates.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  if (!idToken || typeof idToken !== "string") return null;

  // In test environment or offline dev, support mock tokens for automated tests
  if (process.env.NODE_ENV === "test" && idToken.startsWith("mock_google_token_")) {
    const email = idToken.replace("mock_google_token_", "") || "google.test@example.com";
    return {
      sub: `g_${crypto.createHash("md5").update(email).digest("hex")}`,
      email: email.toLowerCase().trim(),
      name: email.split("@")[0].replace(".", " "),
      email_verified: true,
    };
  }

  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!response.ok) {
      console.warn(`[GoogleAuthService] Token verification failed: ${response.statusText}`);
      return null;
    }

    const data = await response.json() as any;

    if (!data.email || !data.sub) {
      return null;
    }

    // Optional: verify audience if GOOGLE_CLIENT_ID is configured
    const configuredClientId = process.env.GOOGLE_CLIENT_ID;
    if (configuredClientId && data.aud !== configuredClientId && data.azp !== configuredClientId) {
      console.warn(`[GoogleAuthService] Audience mismatch: expected ${configuredClientId}, got ${data.aud}`);
      return null;
    }

    return {
      sub: data.sub,
      email: data.email.toLowerCase().trim(),
      name: data.name || data.email.split("@")[0],
      picture: data.picture,
      email_verified: data.email_verified === "true" || data.email_verified === true,
    };
  } catch (err: any) {
    console.error("[GoogleAuthService] Error verifying Google token:", err.message);
    return null;
  }
}

/**
 * Exchange Google OAuth2 Authorization Code for tokens and profile
 */
export async function exchangeGoogleAuthCode(code: string, redirectUri: string): Promise<GoogleProfile | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) not configured");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error("[GoogleAuthService] Failed code exchange:", errorBody);
    return null;
  }

  const tokens = await tokenResponse.json() as any;
  if (tokens.id_token) {
    return verifyGoogleIdToken(tokens.id_token);
  }

  return null;
}

/**
 * Authenticate or register a user using verified Google profile
 */
export async function authenticateWithGoogleProfile(
  profile: GoogleProfile,
  meta?: { ipAddress?: string; userAgent?: string; deviceName?: string }
) {
  const cleanEmail = profile.email.toLowerCase().trim();

  let user = await User.findOne({ email: cleanEmail });
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = await User.create({
      name: profile.name || cleanEmail.split("@")[0],
      email: cleanEmail,
      role: "patient",
      authMethod: "both",
      isEmailVerified: profile.email_verified ?? true,
      isActive: true,
    });
  }

  if (!user.isActive) {
    throw new Error("Account has been deactivated. Please contact support.");
  }

  // Find or create associated patient record
  let patient = await Patient.findOne({ userId: user._id });
  if (!patient && user.role === "patient") {
    patient = await Patient.create({
      userId: user._id,
      name: user.name,
      email: user.email,
      accountType: "self",
      createdBy: user._id,
    });

    await FamilyRelationship.findOneAndUpdate(
      { userId: user._id, patientId: patient._id },
      { relationship: "self", status: "active" },
      { upsert: true }
    );
  }

  // Look up organization membership if staff/admin
  let organizationId: string | undefined = undefined;
  if (user.role !== "patient" && user.role !== "root") {
    const membership = await OrgMember.findOne({ userId: user._id, status: { $ne: "inactive" } })
      .sort({ createdAt: 1 })
      .lean();
    if (membership) {
      organizationId = membership.organizationId.toString();
    }
  }

  const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
  const permissions = roleConfig ? roleConfig.permissions : [];

  const tokenPayload = {
    id: user._id.toString(),
    email: user.email || "",
    role: user.role,
    organization_id: organizationId,
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = await createRefreshToken(user._id.toString(), {
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    deviceName: meta?.deviceName,
    organizationId,
  });

  return {
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      permissions,
      organization_id: organizationId,
    },
    patient: patient ? {
      id: patient._id.toString(),
      name: patient.name,
      email: patient.email,
      mrn: (patient as any).mrn,
    } : null,
    accessToken,
    refreshToken,
    isNewUser,
  };
}
