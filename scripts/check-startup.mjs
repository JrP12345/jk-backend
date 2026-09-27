import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function launch(env, signalBridge = false) {
  const args = signalBridge
    ? ["--input-type=module", "-e", "process.on('message', message => { if (message === 'shutdown') process.emit('SIGTERM'); }); await import('./dist/index.js');"]
    : ["dist/index.js"];
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => output };
}

async function waitForExit(process, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([
      process.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Startup check process did not exit within its deadline.")), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

const missing = launch(baseEnv);
try {
  assert.equal((await waitForExit(missing, 15000)).code, 1);
  assert.match(missing.output(), /Fatal Configuration Error/);
  assert.doesNotMatch(missing.output(), /MongoDB connection error/);
} finally { if (missing.child.exitCode === null) missing.child.kill(); }
console.log("PASS: built API validates production configuration before connecting to MongoDB.");

const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const reservation = net.createServer();
const processes = [];
try {
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const keys = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // These keys, webhook secret and MongoDB replica exist only for this check.
  // The explicit single-node override avoids touching a real Redis instance.
  const env = {
    ...baseEnv, PORT: String(port), MONGODB_URI: replica.getUri(),
    CORS_ALLOWED_ORIGINS: "https://startup-check.example.test",
    JWT_PRIVATE_KEY_BASE64: Buffer.from(keys.privateKey).toString("base64"),
    JWT_PUBLIC_KEY_BASE64: Buffer.from(keys.publicKey).toString("base64"),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    UPI_WEBHOOK_SECRET: crypto.randomBytes(32).toString("hex"),
    ALLOW_SINGLE_NODE_IN_PRODUCTION: "true", RUN_INLINE_JOBS: "false",
    LOG_LEVEL: "info", SHUTDOWN_DRAIN_MS: "1",
  };
  const api = launch(env, true);
  processes.push(api);
  const origin = `http://127.0.0.1:${port}`;
  let ready;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (api.child.exitCode !== null) throw new Error(`Built API exited before readiness: ${api.output()}`);
    try {
      const response = await fetch(`${origin}/api/health/readiness`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (response.status === 200) { ready = body; break; }
    } catch { /* Listener or bootstrap not yet available. */ }
    await pause(250);
  }
  assert.equal(ready?.status, "ready", api.output());
  assert.equal(ready.database.ready, true);
  assert.equal(ready.bootstrap.complete, true);
  assert.equal(ready.configuration.valid, true);
  assert.equal(ready.redis.status, "single_node_override");
  assert.equal((await fetch(`${origin}/api/health/liveness`)).status, 200);
  console.log("PASS: built API starts with production settings and an isolated MongoDB replica set; readiness and liveness return 200.");

  const duplicate = launch(env);
  processes.push(duplicate);
  assert.equal((await waitForExit(duplicate)).code, 1);
  assert.match(duplicate.output(), /API port is already in use/);
  assert.doesNotMatch(duplicate.output(), /Default system roles verified/);
  console.log("PASS: a duplicate built API exits cleanly before bootstrap writes or jobs.");

  // Emit the signal in-process so Windows also exercises the graceful handler.
  api.child.send("shutdown");
  assert.equal((await waitForExit(api)).code, 0);
  assert.match(api.output(), /Server closed successfully/);
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(port, "0.0.0.0", resolve);
  });
  await new Promise(resolve => reservation.close(resolve));
  console.log("PASS: SIGTERM shuts down the built API and releases its port for restart.");
} finally {
  if (reservation.listening) await new Promise(resolve => reservation.close(resolve));
  for (const process of processes) {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill();
  }
  await replica.stop();
}
