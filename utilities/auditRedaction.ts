const REDACTED = "[REDACTED]";
const MAX_DEPTH = 12;

// Audit records must identify an action and its target, not become a second
// clinical record or a secret store. These keys cover credential material,
// direct identifiers, free-text PHI, clinical content, and capability URLs.
const sensitiveKey = /(^|_)(password|secret|authorization|cookie|email|phone|mobile|address|name|dob|birth|gender|photo|image|signature|token(hash|expiresat|usedat)?|tracker|checkin|meetingurl|url|notes?|symptoms?|diagnosis|prescriptions?|allergies|conditions?|vitals?|medical|clinical|medication|investigation|report|attachment|message|content|description|reason|rawresponse)(_|$)/i;

function isIdentifier(value: any) {
  return value?._bsontype === "ObjectId" || value?.constructor?.name === "ObjectId";
}

/** Return a bounded, PHI- and secret-free representation suitable for AuditLog.details. */
export function redactAuditDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (isIdentifier(value)) return String(value);
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (Array.isArray(value)) {
    return value.map((item) => redactAuditDetails(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2");
      result[key] = sensitiveKey.test(normalizedKey) ? REDACTED : redactAuditDetails(child, depth + 1);
    }
    return result;
  }

  return String(value);
}

export { REDACTED as AUDIT_REDACTED_VALUE };
