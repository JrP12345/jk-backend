import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { RefreshToken } from "../models/RefreshToken.ts";
import type { JwtPayload } from "./types.ts";
import { SERVICE_PRIVATE_KEY, SERVICE_PUBLIC_KEY, KEY_ID } from "./keys.ts";

// ─── Access Token (RS256 — signed with service private key) ──────

/**
 * Sign an access token using the service RSA private key.
 * Short-lived: 15 minutes.
 */
export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, SERVICE_PRIVATE_KEY, {
    algorithm: "RS256",
    expiresIn: "15m",
    keyid: KEY_ID
  });
}

/**
 * Verify an access token in-memory using the service RSA public key.
 * Requires zero database queries.
 */
export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, SERVICE_PUBLIC_KEY, { algorithms: ["RS256"] }) as JwtPayload;
}

export function generateTwoFactorChallenge(userId: string): string {
  return jwt.sign({ userId, purpose: "login_2fa" }, SERVICE_PRIVATE_KEY, {
    algorithm: "RS256",
    expiresIn: "10m",
    keyid: KEY_ID,
  });
}

export function verifyTwoFactorChallenge(token: string): { userId: string; purpose: "login_2fa" } {
  const payload = jwt.verify(token, SERVICE_PUBLIC_KEY, { algorithms: ["RS256"] }) as { userId?: string; purpose?: string };
  if (!payload.userId || payload.purpose !== "login_2fa") throw new Error("Invalid two-factor challenge");
  return { userId: payload.userId, purpose: "login_2fa" };
}


// ─── Refresh Token (opaque random + SHA-256 hash in DB) ─────────

/**
 * Create an opaque refresh token, store its SHA-256 hash in the DB.
 * Enforces a maximum of 5 concurrent active sessions per user by revoking oldest sessions.
 * Long-lived: 7 days.
 */
export async function createRefreshToken(
  userId: string,
  meta?: { ipAddress?: string; userAgent?: string; deviceName?: string; organizationId?: string; isGuest?: boolean }
): Promise<string> {
  const rawToken = crypto.randomBytes(48).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Evict oldest session if active sessions count >= 5
  const activeSessions = await RefreshToken.find({ userId, revoked: false, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: 1 })
    .lean();

  if (activeSessions.length >= 5) {
    const oldestToEvictCount = activeSessions.length - 4; // leave room for 1 new session
    const idsToRevoke = activeSessions.slice(0, oldestToEvictCount).map((s) => s._id);
    await RefreshToken.updateMany({ _id: { $in: idsToRevoke } }, { revoked: true });
  }

  await RefreshToken.create({
    userId,
    organizationId: meta?.organizationId || undefined,
    tokenHash,
    expiresAt,
    ipAddress: meta?.ipAddress || "",
    userAgent: meta?.userAgent || "",
    deviceName: meta?.deviceName || "Browser Session",
    isGuest: meta?.isGuest ?? false,
    lastActiveAt: new Date(),
  });

  return rawToken;
}

/**
 * Validate a refresh token: hash it, look it up, check expiry & revocation.
 * Returns the user_id on success, null on failure.
 */
export async function validateRefreshToken(rawToken: string): Promise<string | null> {
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const record = await RefreshToken.findOne({ tokenHash });

  if (!record) return null;

  if (record.revoked || record.expiresAt < new Date()) return null;

  return record.userId.toString();
}

/**
 * Revoke all refresh tokens for a user (e.g. on logout or password change).
 */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await RefreshToken.updateMany({ userId }, { revoked: true });
}


// ─── Regex Sanitizer ─────────────────────────────────────────────

/**
 * Escapes characters that have special meaning in regular expressions
 * to prevent Regex Denial of Service (ReDoS) or query injection.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

// ─── Standard API Response Shapes ───────────────────────────────

export function successResponse(data: unknown, message = "Success") {
  return { success: true, message, data };
}

export function errorResponse(message: string, details?: unknown) {
  return { success: false, message, ...(details ? { details } : {}) };
}

// ─── Pagination Helpers ──────────────────────────────────────────

export function getPaginationParams(query: { page?: string | number; limit?: string | number }) {
  const page = Math.max(1, parseInt(String(query.page || 1), 10));
  const limit = Math.max(1, Math.min(100, parseInt(String(query.limit || 50), 10)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function setPaginationHeaders(
  reply: any,
  { totalCount, totalPages, currentPage, pageSize }: { totalCount: number; totalPages: number; currentPage: number; pageSize: number }
) {
  reply.header("X-Total-Count", totalCount.toString());
  reply.header("X-Total-Pages", totalPages.toString());
  reply.header("X-Current-Page", currentPage.toString());
  reply.header("X-Page-Size", pageSize.toString());
  reply.header("Access-Control-Expose-Headers", "X-Total-Count, X-Total-Pages, X-Current-Page, X-Page-Size");
}

export function normalizePhone(phone: string): string {
  if (!phone) return "";
  let clean = phone.replace(/\D/g, "");
  if (clean.length === 12 && clean.startsWith("91")) {
    clean = clean.substring(2);
  } else if (clean.length === 11 && clean.startsWith("0")) {
    clean = clean.substring(1);
  }
  return clean;
}
