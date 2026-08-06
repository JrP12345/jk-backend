import type { FastifyReply } from "fastify";

/* ────────────────────────────────────────────────
   Shared Types
   ──────────────────────────────────────────────── */

export interface JwtPayload {
  id: string;
  email: string;
  role: string;
  organization_id?: string;
}

/* ────────────────────────────────────────────────
   Cookie Helpers
   ──────────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";

const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 15 * 60,                  // 15 minutes in seconds
};

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: "lax" as const,
  path: "/",                        // Must be "/" so Next.js middleware can read it on page navigations
  maxAge: 7 * 24 * 60 * 60,         // 7 days in seconds
};

/**
 * Set access + refresh token cookies on the reply.
 */
export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string) {
  reply
    .setCookie("access_token", accessToken, ACCESS_COOKIE_OPTIONS)
    .setCookie("refresh_token", refreshToken, REFRESH_COOKIE_OPTIONS);
}

/**
 * Clear all auth cookies (used on logout).
 */
export function clearAuthCookies(reply: FastifyReply) {
  reply
    .clearCookie("access_token", { path: "/" })
    .clearCookie("refresh_token", { path: "/" })
    .clearCookie("sse_access_token", { path: "/" });
}
