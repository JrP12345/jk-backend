import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * CSRF Protection Guard.
 * Validates Origin and Referer headers on state-changing HTTP mutation methods (POST, PUT, PATCH, DELETE)
 * when authenticated via cookies, defending against Cross-Site Request Forgery.
 */
export async function csrfProtection(req: FastifyRequest, reply: FastifyReply) {
  // Safe read-only HTTP methods bypass CSRF checks
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return;
  }

  // Bypass for webhooks and health probes
  if (
    req.url.startsWith("/api/health") ||
    req.url.startsWith("/api/billing/webhook") ||
    req.url.startsWith("/api/webhooks")
  ) {
    return;
  }

  // If request does not use cookie authentication (e.g. Bearer token auth), standard token verification protects it
  const hasCookieAuth = !!(req.cookies?.access_token || req.cookies?.refresh_token);
  if (!hasCookieAuth) {
    return;
  }

  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : ["http://localhost:3000"];

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    if (!allowedOrigins.includes(origin)) {
      return reply.code(403).send({
        success: false,
        error: "Forbidden: Invalid or blocked CSRF origin",
      });
    }
    return;
  }

  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (!allowedOrigins.includes(refererOrigin)) {
        return reply.code(403).send({
          success: false,
          error: "Forbidden: Invalid or blocked CSRF referer",
        });
      }
      return;
    } catch {
      return reply.code(403).send({
        success: false,
        error: "Forbidden: Malformed CSRF referer header",
      });
    }
  }

  // In production builds, require either Origin or Referer on state mutations using cookies
  if (process.env.NODE_ENV === "production") {
    return reply.code(403).send({
      success: false,
      error: "Forbidden: Missing CSRF origin or referer header",
    });
  }
}
