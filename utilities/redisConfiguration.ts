/** Resolve the same Redis settings for startup validation, clients and probes. */
export function getRedisConfiguration(): {
  url?: string;
  host?: string;
  required: boolean;
  error?: string;
} {
  const isProduction = process.env.NODE_ENV === "production";
  const required = isProduction && process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION !== "true";
  const url = process.env.REDIS_URL?.trim() || undefined;
  const host = process.env.REDIS_HOST?.trim() || undefined;
  const settings = { url, host, required };
  let hostname = host;

  if (url) {
    try {
      const parsed = new URL(url);
      if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
        return { ...settings, error: "REDIS_URL must be a redis:// or rediss:// connection URL" };
      }
      hostname = parsed.hostname;
    } catch {
      // Never include the connection URL: it can contain credentials.
      return { ...settings, error: "REDIS_URL must be a valid redis:// or rediss:// connection URL" };
    }
  }

  if (!hostname) {
    return { ...settings, error: "REDIS_URL or REDIS_HOST is not configured" };
  }

  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const isLoopback = normalized === "localhost" || normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) || normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" || normalized === "0.0.0.0" || normalized === "::";
  if (isProduction && isLoopback) {
    return { ...settings, error: "Production Redis must use a remote hostname; localhost/loopback settings are development-only" };
  }

  return settings;
}
