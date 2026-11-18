import { pathToFileURL } from "node:url";
import { supplierProviderReadiness } from "../utilities/pharmacySupplierReadiness.ts";
type Check = { state: "passed" | "failed" | "not_run"; reason?: string };
type Probes = { storage: () => Promise<void>; smtp: () => Promise<void> };

export async function checkSupplierProviders(live = false, env: Record<string, string | undefined> = process.env, probes?: Probes) {
  const config = supplierProviderReadiness(env);
  const checks: { storage: Check; smtp: Check } = { storage: { state: "not_run" }, smtp: { state: "not_run" } };
  if (live) {
    const storageConfigured = !config.storageMissing.length;
    // SMTP authentication can be checked independently of a missing public deployment URL.
    const smtpConfigured = !config.emailMissing.some(name => name !== "APP_URL_PUBLIC_HTTPS_ORIGIN");
    if (!storageConfigured) checks.storage = { state: "not_run", reason: "Storage credentials missing" };
    else try {
      if (probes) await probes.storage();
      else {
        const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
        const client = new S3Client({ region: "auto", endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! }, maxAttempts: 1 });
        try { await client.send(new HeadBucketCommand({ Bucket: env.R2_BUCKET_NAME || "ekavyu-private-vault" }), { abortSignal: AbortSignal.timeout(10000) }); } finally { client.destroy(); }
      }
      checks.storage = { state: "passed" };
    } catch { checks.storage = { state: "failed", reason: "Storage connection or bucket access failed; check credentials/network privately" }; }
    if (!smtpConfigured) checks.smtp = { state: "not_run", reason: "SMTP configuration missing or invalid" };
    else try {
      if (probes) await probes.smtp();
      else {
        const { default: nodemailer } = await import("nodemailer");
        const port = Number(env.SMTP_PORT || "587"), secure = env.SMTP_SECURE === "true" || port === 465;
        const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000, tls: { rejectUnauthorized: true }, requireTLS: !secure });
        try { await transport.verify(); } finally { transport.close(); }
      }
      checks.smtp = { state: "passed" };
    } catch { checks.smtp = { state: "failed", reason: "SMTP authentication/TLS or connection failed; check credentials/network privately" }; }
  }
  return { configured: { storage: config.storageAvailable, supplierEmail: config.emailAvailable }, missing: { storage: config.storageMissing, supplierEmail: config.emailMissing }, checks,
    ready: config.storageAvailable && config.emailAvailable && (!live || checks.storage.state === "passed" && checks.smtp.state === "passed"),
    constraints: ["Read-only provider checks: no email, object upload, object listing or database connection", "Bucket HEAD proves connection/access only, not bucket privacy or write permission", "SMTP verification proves login/TLS only, not inbox delivery or worker availability", "Physical printing and supplier/provider approvals are not simulated by this check"] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--live") || args.length > 1) { console.error("Usage: check-pharmacy-supplier-providers.ts [--live]. --live checks configured storage and SMTP without writes or emails."); process.exitCode = 2; }
  else { const report = await checkSupplierProviders(args.includes("--live")); console.log(JSON.stringify(report, null, 2)); if (!report.ready) process.exitCode = 1; }
}
