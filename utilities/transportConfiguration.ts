import { isIP } from "node:net";

/** Validate without echoing values: configuration may contain credentials. */
export function productionTransportErrors(env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];
  const origins = (env.CORS_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  const isHttpsOrigin = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !url.hostname.includes("*") && !["localhost", "127.0.0.1"].includes(url.hostname);
    } catch { return false; }
  };
  if (!origins.length || origins.some(value => !isHttpsOrigin(value))) errors.push("CORS_ALLOWED_ORIGINS must contain explicit HTTPS origins without credentials, paths or wildcards");
  for (const key of ["APP_URL", "FRONTEND_URL", "WEBAUTHN_ORIGIN"]) {
    if (env[key] && !isHttpsOrigin(env[key]!)) errors.push(`${key} must be an explicit HTTPS origin`);
  }
  if (env.COOKIE_SAME_SITE && !["lax", "strict", "none"].includes(env.COOKIE_SAME_SITE)) errors.push("COOKIE_SAME_SITE must be lax, strict or none");
  if (env.COOKIE_DOMAIN && !/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(env.COOKIE_DOMAIN)) errors.push("COOKIE_DOMAIN must be a hostname without a scheme, port or path");
  if (env.TRUSTED_PROXY_HOPS && (!/^\d+$/.test(env.TRUSTED_PROXY_HOPS) || Number(env.TRUSTED_PROXY_HOPS) < 1 || Number(env.TRUSTED_PROXY_HOPS) > 5)) errors.push("TRUSTED_PROXY_HOPS must be an integer from 1 to 5");
  if (env.TRUSTED_PROXY_HOPS && env.TRUSTED_PROXY_CIDRS) errors.push("Configure one trusted proxy strategy, not both hops and CIDRs");
  if (env.TRUSTED_PROXY_CIDRS && !env.TRUSTED_PROXY_CIDRS.split(",").every(value => {
    const [address, prefix, extra] = value.trim().split("/");
    const family = isIP(address);
    return !!family && !extra && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128)));
  })) errors.push("TRUSTED_PROXY_CIDRS must contain explicit IPs or non-universal CIDRs");
  if (env.REQUIRE_TRUSTED_PROXY === "true" && !env.ORIGIN_VERIFY_TOKEN) errors.push("ORIGIN_VERIFY_TOKEN is required when REQUIRE_TRUSTED_PROXY is enabled");
  if (env.ORIGIN_VERIFY_TOKEN && env.ORIGIN_VERIFY_TOKEN.length < 32) errors.push("ORIGIN_VERIFY_TOKEN must contain at least 32 characters");
  if (env.STAFF_MFA_ENFORCE_AFTER && !Number.isFinite(Date.parse(env.STAFF_MFA_ENFORCE_AFTER))) errors.push("STAFF_MFA_ENFORCE_AFTER must be a valid ISO date");
  return errors;
}
