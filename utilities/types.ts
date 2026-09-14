import type { FastifyReply } from "fastify";

/* ────────────────────────────────────────────────
   Shared Types
   ──────────────────────────────────────────────── */

export interface JwtPayload {
  id: string;
  email: string;
  role: string;
  organization_id?: string;
  sessionId?: string;
  impersonatedBy?: {
    id: string;
    email: string;
    name: string;
    originalRole: string;
  };
}

/* ────────────────────────────────────────────────
   Cookie Helpers
   ──────────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ? process.env.COOKIE_DOMAIN.trim() : undefined;
const COOKIE_SAME_SITE =
  (process.env.COOKIE_SAME_SITE as "lax" | "strict" | "none") ||
  (IS_PROD && !COOKIE_DOMAIN ? "none" : "lax");

const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: COOKIE_SAME_SITE,
  path: "/",
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  maxAge: 15 * 60,                  // 15 minutes in seconds
};

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: COOKIE_SAME_SITE,
  path: "/",                        // Must be "/" so Next.js middleware can read it on page navigations
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  maxAge: 7 * 24 * 60 * 60,         // 7 days in seconds
};

const SESSION_INDICATOR_OPTIONS = {
  httpOnly: false,                  // Readable by client and Next.js middleware
  secure: IS_PROD,
  sameSite: COOKIE_SAME_SITE,
  path: "/",
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  maxAge: 7 * 24 * 60 * 60,
};

/**
 * Set access + refresh token cookies on the reply.
 */
export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string) {
  reply
    .setCookie("access_token", accessToken, ACCESS_COOKIE_OPTIONS)
    .setCookie("refresh_token", refreshToken, REFRESH_COOKIE_OPTIONS)
    .setCookie("ananta_session", "1", SESSION_INDICATOR_OPTIONS);
}

/**
 * Clear all auth cookies (used on logout).
 */
export function clearAuthCookies(reply: FastifyReply) {
  const clearOptions = {
    path: "/",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
  reply
    .clearCookie("access_token", clearOptions)
    .clearCookie("refresh_token", clearOptions)
    .clearCookie("ananta_session", clearOptions)
    .clearCookie("sse_access_token", clearOptions);
}

