import type { FastifyRequest, FastifyReply } from "fastify";

const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" || !process.env.NODE_ENV;

/**
 * Check if candidate origin/referer is allowed:
 * 1. Explicitly listed in CORS_ALLOWED_ORIGINS (or defaults: http://localhost:3000, http://localhost:3001)
 * 2. Matches Host or X-Forwarded-Host header (same-origin Next.js rewrite proxy or reverse proxy)
 * 3. In development/test mode: matches localhost, 127.0.0.1, or private LAN/hotspot IPs (10.x, 192.168.x, 172.16-31.x)
 */
function isOriginAllowed(candidateOrigin: string, req: FastifyRequest): boolean {
  if (!candidateOrigin) return false;

  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)
    : ["http://localhost:3000", "http://localhost:3001"];

  const cleanCandidate = candidateOrigin.trim().replace(/\/+$/, "");

  // 1. Explicitly configured allowed origins
  if (allowedOrigins.includes(cleanCandidate)) {
    return true;
  }

  // 2. Same-origin match against Host or X-Forwarded-Host (Next.js rewrite proxy or reverse proxy)
  const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
  const host = forwardedHost || (req.headers.host as string | undefined);
  if (host) {
    const cleanHost = host.trim().toLowerCase();
    const candidateLower = cleanCandidate.toLowerCase();
    if (
      candidateLower === `http://${cleanHost}` ||
      candidateLower === `https://${cleanHost}`
    ) {
      return true;
    }
  }

  // 3. Development / Test mode: Allow localhost, 127.0.0.1, and private LAN/hotspot IPs (10.x, 192.168.x, 172.16-31.x)
  // Matches Fastify CORS configuration in index.ts
  if (isDev) {
    if (
      /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(
        cleanCandidate
      )
    ) {
      return true;
    }
  }

  return false;
}

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

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    if (!isOriginAllowed(origin, req)) {
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
      if (!isOriginAllowed(refererOrigin, req)) {
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
