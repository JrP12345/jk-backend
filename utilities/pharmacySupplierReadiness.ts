type Environment = Record<string, string | undefined>;
const present = (value?: string) => Boolean(value?.trim() && !/^(your[_-]|replace[_-]|changeme)/i.test(value));
/** Configuration readiness only. It never contacts a provider or proves delivery. */
export function supplierProviderReadiness(env: Environment = process.env) {
  const storageMissing = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter(name => !present(env[name]));
  const emailMissing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter(name => !present(env[name]));
  let appOrigin: string | null = null;
  try {
    const url = new URL(env.APP_URL || "");
    // A supplier email must not silently point to this developer's PC or a private LAN.
    const privateHost = /^(localhost(?:\.|$)|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|.*\.(?:localhost|local|internal)$)/i.test(url.hostname);
    if (url.protocol !== "https:" || privateHost || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("public origin required");
    appOrigin = url.origin;
  } catch { emailMissing.push("APP_URL_PUBLIC_HTTPS_ORIGIN"); }
  const port = Number(env.SMTP_PORT || "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) emailMissing.push("SMTP_PORT");
  return { storageAvailable: storageMissing.length === 0, emailAvailable: emailMissing.length === 0, storageMissing, emailMissing, appOrigin };
}
