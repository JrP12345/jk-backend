import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Appointment } from '../models/Appointment.ts';
import { decryptField } from './cryptoEnvelope.ts';

/**
 * Public appointment tracking is capability-based.  Appointment identifiers are
 * database references, never credentials; only this random value authorizes a
 * public tracker request. Validation uses a SHA-256 digest. The original token
 * is separately encrypted and excluded from ordinary reads, allowing authorized
 * reissue without invalidating existing patient links or extending their expiry.
 */
export function createTrackerCapability(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashTrackerCapability(token) };
}

export async function issueAppointmentTrackerLink(
  appointment: {
    _id: unknown;
    trackerTokenHash?: string | null;
    trackerTokenExpiresAt?: Date | null;
    save?: () => Promise<unknown>;
  },
  options: { ttlDays?: number; pathPrefix?: string; rotate?: boolean } = {},
): Promise<{ token: string; url: string }> {
  const ttlDays = options.ttlDays ?? 30;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 90) throw new Error('Invalid tracker lifetime');
  const pathPrefix = options.pathPrefix || '/track';
  if (Appointment.db.readyState === 1) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await Appointment.findById(appointment._id).select('+trackerTokenHash +trackerTokenCiphertext trackerTokenExpiresAt');
      if (!current) break;
      if (!options.rotate && current.trackerTokenCiphertext && current.trackerTokenExpiresAt && current.trackerTokenExpiresAt > new Date()) {
        const token = decryptField(current.trackerTokenCiphertext);
        if (hashTrackerCapability(token) !== current.trackerTokenHash) throw new Error('Tracker capability requires review');
        appointment.trackerTokenHash = current.trackerTokenHash;
        appointment.trackerTokenExpiresAt = current.trackerTokenExpiresAt;
        return { token, url: `${pathPrefix}/${appointment._id}#t=${encodeURIComponent(token)}` };
      }
      const next = createTrackerCapability(), expiresAt = new Date(Date.now() + ttlDays * 86400000);
      const changed = await Appointment.findOneAndUpdate({ _id: current._id, trackerTokenHash: current.trackerTokenHash || null, trackerTokenCiphertext: current.trackerTokenCiphertext || null },
        { $set: { trackerTokenHash: next.hash, trackerTokenCiphertext: next.token, trackerTokenExpiresAt: expiresAt } }, { returnDocument: 'after' });
      if (!changed) continue;
      appointment.trackerTokenHash = next.hash;
      appointment.trackerTokenExpiresAt = expiresAt;
      return { token: next.token, url: `${pathPrefix}/${appointment._id}#t=${encodeURIComponent(next.token)}` };
    }
    throw new Error('Tracker source changed or is unavailable; reload before issuing a link');
  }
  const capability = createTrackerCapability();

  appointment.trackerTokenHash = capability.hash;
  appointment.trackerTokenExpiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  if (typeof appointment.save === "function") {
    await appointment.save();
  }

  // Use URL fragment #t= to prevent leaking capability token in Referer headers and web logs (Finding: Step 2.8)
  const url = `${pathPrefix}/${appointment._id}#t=${encodeURIComponent(capability.token)}`;
  return { token: capability.token, url };
}

export function appendTrackerCapability(url: string, token: string): string {
  // If the target is an API endpoint, pass as query/header; for UI, prefer fragment
  const isApi = url.includes("/api/");
  if (isApi) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}trackerToken=${encodeURIComponent(token)}`;
  }
  return `${url}#t=${encodeURIComponent(token)}`;
}

export function hashTrackerCapability(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getTrackerCapability(req: FastifyRequest): string | undefined {
  const header = req.headers["x-tracker-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const q = req.query as { trackerToken?: unknown } | undefined;
  const query = q?.trackerToken;
  const body = (req.body as { trackerToken?: unknown } | undefined)?.trackerToken;
  const candidate = fromHeader || (typeof query === "string" ? query : undefined) || (typeof body === "string" ? body : undefined);
  return candidate && candidate.length <= 256 ? candidate : undefined;
}

/** Every private tracker request requires an unexpired capability. */
export function hasValidTrackerCapability(
  req: FastifyRequest,
  appointment: { trackerTokenHash?: string | null; trackerTokenExpiresAt?: Date | null },
): boolean {
  const token = getTrackerCapability(req);
  if (!token || !appointment.trackerTokenHash || !appointment.trackerTokenExpiresAt
    || appointment.trackerTokenExpiresAt.getTime() <= Date.now()) return false;
  const suppliedHash = hashTrackerCapability(token);
  return suppliedHash.length === appointment.trackerTokenHash.length
    && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(appointment.trackerTokenHash));
}

/** A separate, short-lived capability for the state-changing check-in action. */
export function getCheckInCapability(req: FastifyRequest): string | undefined {
  const header = req.headers["x-check-in-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const body = (req.body as { checkInToken?: unknown } | undefined)?.checkInToken;
  const candidate = fromHeader || (typeof body === "string" ? body : undefined);
  return candidate && candidate.length <= 256 ? candidate : undefined;
}
