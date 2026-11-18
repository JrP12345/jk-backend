import { expect, it, vi } from "vitest";
import { supplierProviderReadiness } from "../utilities/pharmacySupplierReadiness.ts";
import { checkSupplierProviders } from "../scripts/check-pharmacy-supplier-providers.ts";
const env = { CLOUDFLARE_ACCOUNT_ID: "synthetic-account", R2_ACCESS_KEY_ID: "synthetic-access", R2_SECRET_ACCESS_KEY: "synthetic-secret", SMTP_HOST: "smtp.example.test", SMTP_USER: "synthetic-user", SMTP_PASS: "synthetic-password", APP_URL: "https://pharmacy.example.test", SMTP_PORT: "587" };
it.each([undefined, "", "http://localhost:3000", "https://127.0.0.1", "https://10.0.0.2", "https://shop.local", "https://[::1]", "https://user:password@public.example.test", "https://public.example.test/path", "https://public.example.test?token=private", "http://public.example.test"])("prevents emailed capabilities pointing to an unusable or unsafe origin: %s", value => {
  expect(supplierProviderReadiness({ ...env, APP_URL: value })).toMatchObject({ emailAvailable: false, storageAvailable: true, appOrigin: null, emailMissing: ["APP_URL_PUBLIC_HTTPS_ORIGIN"] });
});
it("normalizes a public origin and validates configuration without contacting services", async () => {
  expect(supplierProviderReadiness(env)).toMatchObject({ emailAvailable: true, appOrigin: env.APP_URL, storageAvailable: true });
  const probes = { storage: vi.fn(), smtp: vi.fn() }; const report = await checkSupplierProviders(false, env, probes); expect(report.ready).toBe(true); expect(probes.smtp).not.toHaveBeenCalled(); expect(probes.storage).not.toHaveBeenCalled();
});
it("runs only read-only probes, keeps SMTP independent of deployment and never exposes credentials/errors", async () => {
  const probes = { storage: vi.fn().mockRejectedValue(Error(env.R2_SECRET_ACCESS_KEY)), smtp: vi.fn().mockResolvedValue(undefined) };
  const report = await checkSupplierProviders(true, { ...env, APP_URL: undefined }, probes); expect(report.checks).toMatchObject({ storage: { state: "failed" }, smtp: { state: "passed" } }); expect(report.ready).toBe(false); expect(probes.smtp).toHaveBeenCalledOnce();
  expect(JSON.stringify(report)).not.toContain(env.R2_SECRET_ACCESS_KEY); expect(JSON.stringify(report)).not.toContain(env.SMTP_PASS);
});
it("does not try providers with missing credentials or an invalid port", async () => {
  const probes = { storage: vi.fn(), smtp: vi.fn() }; const report = await checkSupplierProviders(true, { APP_URL: env.APP_URL, SMTP_PORT: "65536" }, probes); expect(report.ready).toBe(false); expect(report.missing.supplierEmail).toContain("SMTP_PORT"); expect(probes.smtp).not.toHaveBeenCalled(); expect(probes.storage).not.toHaveBeenCalled();
});
