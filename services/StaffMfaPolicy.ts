/** Authenticator enrollment is optional. A recovered account must replace its
 * lost authenticator before resuming operations; root has its own policy.
 */
export function staffMfaEnrollmentRequired(role: string, enabled: boolean, recoveryRequired = false) {
  return !["root", "patient", "family_member", "guest"].includes(role) && !enabled && recoveryRequired;
}

export const MFA_ENROLLMENT_ROUTES = new Set([
  "/api/auth/me", "/api/auth/logout", "/api/auth/stop-impersonation",
  "/api/onboarding/totp/setup", "/api/onboarding/totp/verify",
]);
