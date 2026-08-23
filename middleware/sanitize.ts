import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Recursively sanitizes objects to prevent NoSQL query operator injection ($where, $gt, $regex, etc.)
 * in req.body, req.query, and req.params.
 */
function sanitizeInput(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeInput);
  }

  const clean: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    // Strip leading dollar signs or dots from user keys to prevent MongoDB operator injection
    if (key.startsWith("$") || key.includes(".")) {
      continue;
    }
    clean[key] = sanitizeInput(obj[key]);
  }
  return clean;
}

export async function sanitizeMiddleware(req: FastifyRequest, _reply: FastifyReply) {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeInput(req.body);
  }
  if (req.query && typeof req.query === "object") {
    req.query = sanitizeInput(req.query);
  }
  if (req.params && typeof req.params === "object") {
    req.params = sanitizeInput(req.params);
  }
}
