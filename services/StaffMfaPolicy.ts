/** Production staff enroll before operational access. A dated rollout allows
 * existing users to enroll before the operator-selected enforcement instant.
 * Consumers retain their existing authentication policy; root remains stricter.
 */
export function staffMfaEnrollmentRequired(role: string, enabled: boolean, env: NodeJS.ProcessEnv = process.env, now = Date.now(), forced = false) {
  if (["root", "patient", "family_member", "guest"].includes(role) || enabled) return false;
  if (forced) return true;
  if (env.NODE_ENV !== "production" && env.STAFF_MFA_REQUIRED !== "true") return false;
  const deadline = env.STAFF_MFA_ENFORCE_AFTER ? Date.parse(env.STAFF_MFA_ENFORCE_AFTER) : 0;
  return !Number.isFinite(deadline) || now >= deadline;
}

export const MFA_ENROLLMENT_ROUTES = new Set([
  "/api/auth/me", "/api/auth/logout", "/api/auth/stop-impersonation",
  "/api/onboarding/totp/setup", "/api/onboarding/totp/verify",
]);
