import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { getServerPort } from "../utilities/serverPort.ts";

const lockPurpose = "ekavyu-backend-dev-watcher";

function parseLock(contents) {
  try {
    const lock = JSON.parse(contents);
    return Number.isInteger(lock.pid) ? lock : undefined;
  } catch {
    return undefined;
  }
}

function isLockOwnerRunning(owner) {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return owner.purpose === lockPurpose;
    throw error;
  }
}

async function runDevelopment() {
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  const port = getServerPort();
  const lockPath = path.join(process.cwd(), `.dev-server-${port}.lock`);
  let ownsLock = false;
  for (let attempt = 0; attempt < 3 && !ownsLock; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, purpose: lockPurpose }), { flag: "wx" });
      ownsLock = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const contents = fs.readFileSync(lockPath, "utf8");
      const owner = parseLock(contents);
      if (!owner) {
        console.log("Another development watcher is starting. Reuse its terminal.");
        return;
      }
      if (isLockOwnerRunning(owner)) {
        console.log(`A development watcher is already active (PID ${owner.pid}). Reuse its terminal, including during API restarts.`);
        return;
      }
      if (fs.readFileSync(lockPath, "utf8") === contents) fs.unlinkSync(lockPath);
    }
  }
  if (!ownsLock) throw new Error("Could not acquire the development watcher lock. Try again.");
  process.on("exit", () => {
    try {
      if (JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === process.pid) fs.unlinkSync(lockPath);
    } catch { /* Already removed or replaced. */ }
  });
  const origin = `http://127.0.0.1:${port}`;
  const probe = net.createServer();
  let available = false;
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ port, host: "0.0.0.0", exclusive: true }, resolve);
    });
    available = true;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  } finally {
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
  }

  if (!available) {
    let existing;
    try {
      const [live, ready] = await Promise.all([
        fetch(`${origin}/api/health/liveness`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(3000) }).then(r => r.json()),
        fetch(`${origin}/api/health/readiness`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(3000) }).then(r => r.json()),
      ]);
      if (live.status === "ok" && Number.isInteger(live.process?.pid) && ready.database && ready.redis && ready.bootstrap) {
        existing = { pid: live.process.pid, status: ready.status };
      }
    } catch { /* A different application or a listener still starting owns the port. */ }
    if (existing) {
      console.log(`Ekavyu API is already running at ${origin} (PID ${existing.pid}, ${existing.status}).`);
      console.log("Reuse this API. Stop its existing terminal before starting another development watcher.");
      return;
    }
    console.error(`Port ${port} is already in use. Stop its owning process or set a different PORT and update the frontend API URL.`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, ["--watch", "--watch-kill-signal=SIGTERM", "index.ts"], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

await runDevelopment();
