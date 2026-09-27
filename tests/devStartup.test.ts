import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let server: http.Server;
let port: number;
let lockPath: string;
beforeEach(async () => {
  server = http.createServer((request, reply) => {
    reply.setHeader("Content-Type", "application/json");
    reply.end(JSON.stringify(request.url?.endsWith("liveness")
      ? { status: "ok", process: { pid: process.pid } }
      : { status: "ready", database: { ready: true }, redis: { ready: true }, bootstrap: { complete: true } }));
  });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  port = (server.address() as import("node:net").AddressInfo).port;
  lockPath = path.join(process.cwd(), `.dev-server-${port}.lock`);
});
afterEach(async () => {
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function runDev(): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["scripts/dev.mjs"], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "development", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve({ code, output }));
    });
  } finally { clearTimeout(timer); }
}

describe("Local development duplicate startup", () => {
  it("reuses an existing API and exits naturally without a competing watcher", async () => {
    const result = await runDev();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Ekavyu API is already running");
    expect(result.output).not.toContain("Assertion failed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("recognizes a live watcher even during its API restart window", async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    const result = await runDev();
    expect(result.code).toBe(0);
    expect(result.output).toContain("A development watcher is already active");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });
});
