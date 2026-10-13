import { execFileSync } from "node:child_process";
import path from "node:path";

export const lockPurpose = "ekavyu-backend-dev-watcher";

// A PID can be reused after a watcher exits. Include the OS process start time
// so an unrelated process (including another Node process) cannot own its lock.
export function getProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const output = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; $started = ''; if ($null -ne $p.StartTime) { $started = $p.StartTime.ToUniversalTime().Ticks.ToString() }; $p.ProcessName + '|' + $started`],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim()
      : execFileSync("ps", ["-p", String(pid), "-o", "comm=", "-o", "lstart="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: { ...process.env, LC_ALL: "C" } }).trim().replace(/\s+/, "|");
    const separator = output.indexOf("|");
    if (separator < 0) return undefined;
    const name = path.parse(output.slice(0, separator)).name.toLowerCase();
    return { name, startedAt: output.slice(separator + 1).trim() };
  } catch {
    return undefined;
  }
}

export function isLockOwnerRunning(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  const identity = getProcessIdentity(owner.pid);
  // If OS inspection is unavailable, retain the lock rather than risk starting
  // a competing watcher during an API restart.
  if (!identity) return true;
  if (identity.name !== path.parse(process.execPath).name.toLowerCase()) return false;
  return !owner.processIdentity || (identity.name === owner.processIdentity.name
    && identity.startedAt === owner.processIdentity.startedAt);
}
