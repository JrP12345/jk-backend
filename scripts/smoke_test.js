/**
 * Ekavyu Smoke Test Suite
 *
 * Runs a set of lightweight HTTP checks against a live deployment
 * to verify the system is healthy after a deploy.
 *
 * Usage:
 *   STAGING_URL=https://api.yourdomain.com node scripts/smoke_test.js
 *
 * Exit codes:
 *   0 — all smoke tests passed
 *   1 — one or more smoke tests failed
 */

const BASE_URL = (process.env.STAGING_URL || "http://localhost:5000").replace(/\/$/, "");
const FRONTEND_URL = (process.env.STAGING_FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
const TIMEOUT_MS = 10_000;

let passed = 0;
let failed = 0;

async function probe(label, url, { expectedStatus = 200, bodyCheck } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.status !== expectedStatus) {
      console.error(`  ❌ [FAIL] ${label} — expected HTTP ${expectedStatus}, got ${res.status} (${url})`);
      failed++;
      return null;
    }

    const text = await res.text();
    if (bodyCheck && !bodyCheck(text)) {
      console.error(`  ❌ [FAIL] ${label} — body check failed (${url})`);
      failed++;
      return null;
    }

    console.log(`  ✅ [PASS] ${label} — HTTP ${res.status}`);
    passed++;
    return text;
  } catch (err) {
    clearTimeout(timeout);
    const reason = err.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error(`  ❌ [FAIL] ${label} — ${reason} (${url})`);
    failed++;
    return null;
  }
}

console.log("\n==================================================================");
console.log(` 🚀  Ekavyu SMOKE TESTS  →  ${BASE_URL}`);
console.log("==================================================================\n");

// ─── Backend Smoke Tests ────────────────────────────────────────────────────
console.log("▶ Backend Health Probes");

await probe(
  "/api/health — general ping",
  `${BASE_URL}/api/health`,
  { bodyCheck: (b) => JSON.parse(b).status === "ok" }
);

await probe(
  "/api/health/liveness — event loop responsive",
  `${BASE_URL}/api/health/liveness`,
  { bodyCheck: (b) => JSON.parse(b).status === "ok" }
);

await probe(
  "/api/health/readiness — DB & Redis connected",
  `${BASE_URL}/api/health/readiness`,
  { bodyCheck: (b) => JSON.parse(b).status === "ready" }
);

await probe(
  "/.well-known/jwks.json — JWKS public key served",
  `${BASE_URL}/.well-known/jwks.json`,
  { bodyCheck: (b) => { const j = JSON.parse(b); return Array.isArray(j.keys) && j.keys.length > 0; } }
);

// ─── Frontend Smoke Test ────────────────────────────────────────────────────
console.log("\n▶ Frontend Availability");

await probe(
  "Frontend root — Next.js serving HTML",
  `${FRONTEND_URL}/`,
  { bodyCheck: (b) => b.includes("<!DOCTYPE html") || b.includes("<html") }
);

// ─── Summary ───────────────────────────────────────────────────────────────
const total = passed + failed;
console.log("\n==================================================================");
console.log(` 📊 SMOKE TEST RESULTS: ${passed} / ${total} Passed`);
console.log("==================================================================\n");

if (failed > 0) {
  console.error(` ⚠️  ${failed} smoke test(s) failed — deployment may be unhealthy.`);
  process.exit(1);
}

console.log(" ✅ All smoke tests passed — deployment is healthy.");
process.exit(0);
