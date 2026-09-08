import crypto from "node:crypto";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Deterministically sorts all object keys recursively for canonical JSON serialization
 */
export function canonicalize(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

export interface AuditHashInput {
  sequence: number;
  prevHash: string;
  organizationId?: any;
  userId?: any;
  action: string;
  category?: string;
  targetId?: any;
  targetModel?: string | null;
  details?: any;
  createdAt: Date | string;
}

/**
 * Computes a deterministic SHA-256 hash over an audit record's immutable payload.
 * Any subsequent alteration to action, category, target, details, or timestamp will invalidate this hash.
 */
export function computeAuditHash(data: AuditHashInput): string {
  const canonicalDetails =
    data.details !== undefined && data.details !== null
      ? JSON.stringify(canonicalize(data.details))
      : "";

  let createdAtIso: string;
  if (data.createdAt instanceof Date) {
    createdAtIso = data.createdAt.toISOString();
  } else if (typeof data.createdAt === "string") {
    createdAtIso = new Date(data.createdAt).toISOString();
  } else {
    createdAtIso = new Date().toISOString();
  }

  const payload = [
    String(data.sequence),
    data.prevHash || GENESIS_HASH,
    data.organizationId ? String(data.organizationId) : "GLOBAL",
    data.userId ? String(data.userId) : "SYSTEM",
    data.action,
    data.category || "CLINICAL_WRITE",
    data.targetId ? String(data.targetId) : "NONE",
    data.targetModel || "NONE",
    canonicalDetails,
    createdAtIso,
  ].join("|");

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}
