import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { RefreshToken } from "../models/RefreshToken.ts";
import type { JwtPayload } from "./types.ts";

// ─── RSA Key-Pair Generation ────────────────────────────────────

/**
 * Generate a fresh RSA-2048 key pair (PEM-encoded).
 * Called once per user at registration time.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding:  { type: "spki",  format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}


// ─── Access Token (RS256 — signed with user's private key) ──────

/**
 * Sign an access token using the user's RSA private key.
 * Short-lived: 15 minutes.
 */
export function generateAccessToken(payload: JwtPayload, privateKey: string): string {
  return jwt.sign(payload, privateKey, { algorithm: "RS256", expiresIn: "15m" });
}

/**
 * Verify an access token using the user's RSA public key.
 */
export function verifyAccessToken(token: string, publicKey: string): JwtPayload {
  return jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as JwtPayload;
}


// ─── Refresh Token (opaque random + SHA-256 hash in DB) ─────────

/**
 * Create an opaque refresh token, store its SHA-256 hash in the DB.
 * Long-lived: 7 days.
 * Returns the raw token to send to the client.
 */
export async function createRefreshToken(userId: string): Promise<string> {
  const rawToken = crypto.randomBytes(48).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId,
    tokenHash,
    expiresAt,
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

