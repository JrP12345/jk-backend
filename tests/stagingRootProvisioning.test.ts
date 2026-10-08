import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { stagingRootConfig } from "../deploy/provision-staging-root.mjs";

const valid = () => ({
  NODE_ENV: "production", APP_URL: "https://dev.ekavyu.com",
  MONGODB_URI: "mongodb+srv://fixture:fixture@cluster.example.test/ekavyu_dev",
  ROOT_ADMIN_EMAIL: " ROOT@STAGING.EXAMPLE.TEST ", ROOT_ADMIN_PASSWORD: "test-only-private-password",
  STAGING_PROVISION_CONFIRM: "ekavyu_dev",
});
describe("manual staging root provisioning guards", () => {
  it("accepts only the explicit staging configuration", () => {
    expect(stagingRootConfig(valid(), true).email).toBe("root@staging.example.test");
  });
  it.each([
    ["NODE_ENV", "development"], ["APP_URL", "https://ekavyu.com"],
    ["APP_URL", "https://dev.ekavyu.com.evil.test"], ["STAGING_PROVISION_CONFIRM", ""],
    ["MONGODB_URI", "mongodb+srv://u:p@cluster.example.test/ekavyu_production"],
    ["MONGODB_URI", "mongodb://localhost/ekavyu_dev"],
    ["ROOT_ADMIN_PASSWORD", "short"], ["ROOT_ADMIN_EMAIL", "invalid"],
  ])("rejects unsafe %s", (key, value) => {
    expect(() => stagingRootConfig({ ...valid(), [key]: value }, true)).toThrow();
  });
  it("preview neither connects nor prints credentials", () => {
    const r = spawnSync(process.execPath, ["deploy/provision-staging-root.mjs"], { env: { ...process.env, ...valid(), STAGING_PROVISION_CONFIRM: "" }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No database connection/write");
    expect(r.stdout + r.stderr).not.toContain(valid().ROOT_ADMIN_PASSWORD);
    expect(r.stdout + r.stderr).not.toContain("fixture:fixture");
  });
  it("creates one hashed root in the ephemeral replica set and refuses reapplication", async () => {
    const uri = process.env.MONGODB_URI!.replace(/\/[^/?]*(?=\?|$)/, "/ekavyu_dev");
    const env = { ...process.env, ...valid(), MONGODB_URI: uri };
    const run = () => spawnSync(process.execPath, ["deploy/provision-staging-root.mjs", "--apply"], { env, encoding: "utf8", timeout: 20000 });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const db = mongoose.connection.useDb("ekavyu_dev");
    const user = await db.collection("users").findOne({ role: "root" });
    expect(user?.twoFactorEnabled).toBe(false);
    expect(await bcrypt.compare(valid().ROOT_ADMIN_PASSWORD, user!.password)).toBe(true);
    const second = run();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("Refusing a nonempty database");
    expect(await db.collection("users").countDocuments()).toBe(1);
  });
});
