import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Public appointment tracking is capability-based.  Appointment identifiers are
 * database references, never credentials; only this random value authorizes a
 * public tracker request.  The database stores the SHA-256 digest only.
 */
export function createTrackerCapability(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashTrackerCapability(token) };
}

export function hashTrackerCapability(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getTrackerCapability(req: FastifyRequest): string | undefined {
  const header = req.headers["x-tracker-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const query = (req.query as { trackerToken?: unknown } | undefined)?.trackerToken;
  const body = (req.body as { trackerToken?: unknown } | undefined)?.trackerToken;
  const candidate = fromHeader || (typeof query === "string" ? query : undefined) || (typeof body === "string" ? body : undefined);
  return candidate && candidate.length <= 256 ? candidate : undefined;
}

export function isTrackerCapabilityEnforced(): boolean {
  // Production must never fall back to ObjectId-as-secret.  A non-production
  // rollout can explicitly opt in while old development fixtures are migrated.
  return process.env.NODE_ENV === "production" || process.env.ENFORCE_TRACKER_CAPABILITIES === "true";
}
