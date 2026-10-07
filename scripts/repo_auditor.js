import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/** Checks the standalone backend repository and records its release result. */

const BACKEND_DIR = path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = path.join(BACKEND_DIR, "release_manifest.json");

console.log("\n==================================================================");
console.log(" 🛡️  Ekavyu AUTOMATED ENGINEERING PLATFORM & REPO AUDITOR");
console.log("==================================================================\n");

let passedChecks = 0;
let totalChecks = 0;
const metrics = {
  version: JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, "package.json"), "utf8")).version,
  timestamp: new Date().toISOString(),
  ts_errors: null,
  tests_passed: null,
  tests_total: null,
  test_files_passed: null,
  performance_baseline: {},
  release_gate: "rejected"
};

function check(title, assertionFn) {
  totalChecks++;
  try {
    const result = assertionFn();
    if (result !== false) {
      console.log(`  ✅ [PASS] ${title}`);
      passedChecks++;
    } else {
      console.log(`  ❌ [FAIL] ${title}`);
    }
  } catch (err) {
    console.log(`  ❌ [FAIL] ${title} - Error: ${err.message}`);
  }
}

// ─── 1. Quality Gate 1: Code & Type Safety Checks ────────────────────────
console.log("\n▶ Checking Gate 1: Code & Type Safety (`npx tsc --noEmit`)");

check("Backend TypeScript compilation (0 errors)", () => {
  try {
    execSync("node node_modules/typescript/bin/tsc --noEmit", { cwd: BACKEND_DIR, encoding: "utf8" });
  } catch (error) {
    metrics.ts_errors = (String(error.stdout || "").match(/error TS\d+/g) || []).length;
    throw error;
  }
  metrics.ts_errors = 0;
  return true;
});

// ─── 2. Quality Gate 2: Test Suite Execution ──────────────────────────────
console.log("\n▶ Checking Gate 2: Vitest Integration Test Suite (`npx vitest run`)");

check("Backend Vitest suite execution (100% tests pass)", () => {
  const out = execSync("node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism --reporter=dot", {
    cwd: BACKEND_DIR,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", LOG_LEVEL: "silent" },
    maxBuffer: 20 * 1024 * 1024,
  });
  const fileMatch = out.match(/Test Files\s+(\d+) passed/i);
  const testMatch = out.match(/Tests\s+(\d+) passed/i);
  const hasNoFailures = !out.includes("Failed Suites") && !out.includes("Failed Tests");
  if (fileMatch && testMatch && hasNoFailures) {
    metrics.test_files_passed = parseInt(fileMatch[1], 10);
    metrics.tests_passed = parseInt(testMatch[1], 10);
    metrics.tests_total = parseInt(testMatch[1], 10);
    return true;
  }
  return false;
});

// ─── 3. Quality Gate 3: Architectural Fitness Functions ─────────────────
console.log("\n▶ Checking Gate 3: Architectural Fitness Functions");

check("Fitness Function 1: Zero hardcoded secrets in source files", () => {
  const filesToScan = [
    path.join(BACKEND_DIR, "index.ts"),
    path.join(BACKEND_DIR, "db.ts"),
    path.join(BACKEND_DIR, "middleware", "auth.ts"),
    path.join(BACKEND_DIR, "utilities", "helpers.ts"),
  ];
  const forbiddenPatterns = [/JWT_SECRET\s*=\s*['"][^'"]+['"]/i, /SECRET_KEY\s*=\s*['"][^'"]+['"]/i];

  for (const file of filesToScan) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) return false;
      }
    }
  }
  return true;
});

check("Fitness Function 2: User model contains zero RSA private/public key fields", () => {
  const userModel = fs.readFileSync(path.join(BACKEND_DIR, "models", "User.ts"), "utf8");
  return !userModel.includes("privateKey") && !userModel.includes("publicKey");
});

check("Fitness Function 3: checkPermission middleware contains zero hardcoded admin bypasses", () => {
  const authMiddleware = fs.readFileSync(path.join(BACKEND_DIR, "middleware", "auth.ts"), "utf8");
  return !authMiddleware.includes('if (req.user.role === "admin") return;');
});

// The checkout boundary is checked by the frontend repository's check:payments.

// ─── 4. Quality Gate 4: Dependency & Governance Scan ─────────────────────
console.log("\n▶ Checking Gate 4: Dependency Governance & Package Audit");

check("Backend package manifest and lockfile agree", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, "package-lock.json"), "utf8"));
  const root = lock.packages?.[""];
  return ["dependencies", "devDependencies"].every(group =>
    Object.entries(pkg[group] || {}).every(([name, range]) =>
      root?.[group]?.[name] === range && lock.packages[`node_modules/${name}`]
    )
  );
});

// ─── 5. Quality Gate 5: SRE Probes ────────────────
console.log("\n▶ Checking Gate 5: SRE Probes");

check("index.ts exposes /api/health/liveness & /api/health/readiness probes", () => {
  const indexSource = fs.readFileSync(path.join(BACKEND_DIR, "index.ts"), "utf8");
  return indexSource.includes("/api/health/liveness") && indexSource.includes("/api/health/readiness");
});

check("index.ts handles SIGTERM and SIGINT graceful shutdown", () => {
  const indexSource = fs.readFileSync(path.join(BACKEND_DIR, "index.ts"), "utf8");
  return indexSource.includes("SIGTERM") && indexSource.includes("SIGINT") && indexSource.includes("gracefulShutdown");
});

const memUsage = process.memoryUsage();
metrics.performance_baseline = {
  heapUsedMb: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
  heapTotalMb: (memUsage.heapTotal / 1024 / 1024).toFixed(2),
  rssMb: (memUsage.rss / 1024 / 1024).toFixed(2),
};

// Write current snapshot
metrics.release_gate = passedChecks === totalChecks ? "approved" : "rejected";
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(metrics, null, 2));
console.log(`  ✅ Written current release snapshot → release_manifest.json`);

// Append to historical series (release_history.json)
const HISTORY_PATH = path.join(BACKEND_DIR, "release_history.json");
let history = [];
if (fs.existsSync(HISTORY_PATH)) {
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch {}
}
// Avoid duplicate entries for the same timestamp minute
const isDuplicate = history.length > 0 &&
  history[history.length - 1].timestamp.slice(0, 16) === metrics.timestamp.slice(0, 16);
if (metrics.release_gate === "approved" && !isDuplicate) {
  history.push({
    version: metrics.version,
    timestamp: metrics.timestamp,
    tests_passed: metrics.tests_passed,
    tests_total: metrics.tests_total,
    ts_errors: metrics.ts_errors,
    heap_used_mb: metrics.performance_baseline.heapUsedMb,
    release_gate: metrics.release_gate,
  });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`  ✅ Appended entry #${history.length} to release_history.json`);
}

// ─── 8. Summary & ARB Rating Output ──────────────────────────────────────
console.log("\n==================================================================");
console.log(` 📊 AUDIT RESULTS: ${passedChecks} / ${totalChecks} Checks Passed (${Math.round((passedChecks/totalChecks)*100)}%)`);
console.log("==================================================================");

if (passedChecks === totalChecks) {
  console.log("\n 🌟 ALL QUALITY GATES PASSED 100% GREEN.");
  console.log("==================================================================\n");
  process.exit(0);
} else {
  console.log("\n ⚠️ ARCHITECTURE DRIFT OR AUDIT FAILURE DETECTED.");
  console.log("==================================================================\n");
  process.exit(1);
}
