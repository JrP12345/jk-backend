import crypto from "node:crypto";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import jwt from "jsonwebtoken";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  email_verified?: boolean;
  hd?: string;
}

let certificates: Record<string, string> = {};
let certificatesExpireAt = 0;
let certificateRequest: Promise<void> | null = null;
let lastCertificateRefresh = 0;
async function refreshCertificates() {
  if (!certificateRequest) certificateRequest = (async () => {
    lastCertificateRefresh = Date.now();
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error("Google signing keys are unavailable");
    const text = await response.text();
    if (text.length > 128 * 1024) throw new Error("Invalid Google signing keys");
    const keys = JSON.parse(text).keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 32) throw new Error("Invalid Google signing keys");
    certificates = Object.fromEntries(keys.map(key => {
      if (key.kty !== "RSA" || key.alg !== "RS256" || typeof key.kid !== "string" || key.kid.length > 128 ||
        typeof key.n !== "string" || key.n.length > 2048 || typeof key.e !== "string") throw new Error("Invalid Google signing keys");
      return [key.kid, crypto.createPublicKey({ key, format: "jwk" }).export({ type: "spki", format: "pem" }).toString()];
    }));
    const seconds = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] || 300);
    certificatesExpireAt = Date.now() + Math.min(seconds, 3600) * 1000;
  })().finally(() => { certificateRequest = null; });
  await certificateRequest;
}

/**
 * Validates a Google ID token by querying Google's OAuth2 tokeninfo endpoint
 * or verifying against Google's public certificates.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  if (!idToken || typeof idToken !== "string" || idToken.length > 16384) return null;

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
    const configuredClientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!configuredClientId) return null;
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string") return null;
    if (Date.now() >= certificatesExpireAt) await refreshCertificates();
    if (!Object.hasOwn(certificates, decoded.header.kid) && Date.now() - lastCertificateRefresh > 60_000) await refreshCertificates();
    const key = Object.hasOwn(certificates, decoded.header.kid) ? certificates[decoded.header.kid] : undefined;
    if (!key) return null;
    const data = jwt.verify(idToken, key, { algorithms: ["RS256"], audience: configuredClientId,
      issuer: ["accounts.google.com", "https://accounts.google.com"] }) as jwt.JwtPayload;
    if (typeof data.email !== "string" || !data.sub || !data.exp || data.email_verified !== true) return null;

    return {
      sub: data.sub,
      email: data.email.toLowerCase().trim(),
      name: data.name || data.email.split("@")[0],
      picture: data.picture,
      email_verified: data.email_verified === "true" || data.email_verified === true,
      hd: typeof data.hd === "string" ? data.hd : undefined,
    };
  } catch (err: any) {
    console.warn("[GoogleAuthService] Google identity verification failed");
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
    signal: AbortSignal.timeout(5000), redirect: "error",
  });

  if (!tokenResponse.ok) {
    console.warn("[GoogleAuthService] Code exchange rejected", { status: tokenResponse.status });
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
export async function authenticateWithGoogleProfile(profile: GoogleProfile) {
  if (!profile.email_verified || !profile.sub) throw new Error("A verified Google identity is required");
  const cleanEmail = profile.email.toLowerCase().trim();

  let user = await User.findOne({ googleSubject: profile.sub });
  if (!user) {
    user = await User.findOne({ email: cleanEmail });
    if (user && (user.googleSubject || (!cleanEmail.endsWith("@gmail.com") && !profile.hd && process.env.NODE_ENV !== "test"))) {
      throw new Error("Sign in with the existing account method; Google identity is not linked");
    }
    if (user) {
      if (!user.isActive) throw new Error('Account is deactivated');
      user.googleSubject = profile.sub;
      user.isEmailVerified = true;
      await user.save();
    }
  }
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = await User.create({
      name: profile.name || cleanEmail.split("@")[0],
      email: cleanEmail,
      googleSubject: profile.sub,
      role: "patient",
      authMethod: "both",
      isEmailVerified: true,
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

  return {
    userRecord: user,
    patient: patient ? {
      id: patient._id.toString(),
      name: patient.name,
      email: patient.email,
      mrn: (patient as any).mrn,
    } : null,
    isNewUser,
  };
}
