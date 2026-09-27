# Backend production validation

## Render readiness timeout investigation — 2026-09-27

The newly supplied 12:33–12:50 UTC log confirms a separate failure after the
build command was corrected: MongoDB connected, the listener started and
bootstrap completed at 12:33:55. Readiness then repeatedly returned HTTP 503
with database `connected` and Redis `not_configured`; Render timed out at
12:50:55. The lengthy deployment is a health-check wait, not compilation.

Source inspection found startup validation accepted a localhost Redis URL,
while client initialization discarded it in production. Missing Redis is certain
from the log; a localhost placeholder is the source-level explanation consistent
with both the rejected client and successful configuration validation. Actual
Render environment values were not inspected.

Startup, clients and readiness now share Redis configuration resolution. A
required missing, malformed or loopback Redis setting fails validation before
MongoDB/bootstrapping. Hostname checks no longer mistake `localhost` inside
credentials for a loopback host. Logs include Redis requirement/error details,
without printing connection URLs. Development local Redis remains supported,
the explicit single-instance override remains available, and required Redis
network failures still fail readiness. No readiness gate was bypassed.

The existing service needs either its actual Redis service URL, or
`ALLOW_SINGLE_NODE_IN_PRODUCTION=true` for one API instance without Redis
(remove local Redis placeholders). [Deployment instructions](../DEPLOYMENT.md)
describe both choices. These are Render environment changes; editing the Git
repository does not apply them to an existing manually configured service.

Verification: TypeScript passed; **18 tests across three files passed** (Redis
configuration/readiness, production environment guards and rate-limit/health
integration). The API and five worker bundles built and were verified in
**1.15s**. All **five built-production startup checks passed**, including a
localhost Redis placeholder exiting before database/bootstrap, explicit
single-instance readiness/liveness HTTP 200, duplicate-port rejection and
graceful shutdown. A first concurrent startup run hit its local process deadline;
the isolated rerun passed without increasing the deadline. The install-hook
regression check also passed. No production credentials/data, Render dashboard
settings or deployed resources were changed; live Redis/network behavior remains
an external deployment check.

## Build/install delay investigation — 2026-09-27

The compiler was measured separately from dependency installation and startup:
the initial esbuild run took 401ms. Inspection found `mongodb-memory-server`
has an install hook that obtains a test MongoDB binary. Production installs
include dev dependencies for esbuild, so this unrelated test download could
delay deployment before compilation. Package configuration now disables that
install hook's download, while runtime downloads remain available to tests.
The actual installed hook is checked by `npm run check:build-install`; CI and
release workflows run this check. Docker explicitly includes build dependencies.

The updated build reports its phase and elapsed time and verifies six executable
bundles. The measured local build completed in **0.57s**. This is compilation
time, not a fresh package installation benchmark or a Render timing guarantee.
`npm run audit:release` still runs the serial integration suite in CI; production
build/start commands do not run that suite. No tests or readiness gates were
removed to reduce deployment time.

Verification passed: actual dependency hook skips binary acquisition with the
package configuration alone; runtime download support remains enabled; API and
all five worker bundles are nonempty; all four built-production startup checks
pass (configuration validation, healthy readiness/liveness, duplicate listener
rejection and graceful shutdown). Package dependency locks, build/start lifecycle,
Render command and both workflow regression-check entries were also verified.
No production database or credentials were changed and no deploy was triggered.

The later Render log establishes the Redis readiness timeout documented above.
The install-download optimization is separate from that confirmed failure and
does not certify the live deployment.

Historical backend validation results are retained below. Frontend checks are
documented in the [frontend repository](https://github.com/JrP12345/jk-frontend/blob/main/docs/production-readiness-tracker.md).

## Render missing build artifact — 2026-09-27

The supplied 12:24 UTC logs at commit `97ab1e8` show build command `npm install`
followed by `npm start` (`node dist/index.js`). Dependency installation succeeded,
but compilation never ran, causing `MODULE_NOT_FOUND` before API bootstrap.
This log identifies a deployment-command failure separately from the earlier
readiness-503 investigation.

The existing Render service must use **Build Command**
`npm ci --include=dev && npm run build`, **Start Command** `npm start`, and an
empty **Root Directory** for the standalone `JrP12345/jk-backend` repository.
After saving, use **Clear build cache & deploy**. The workspace repository instead
needs root directory `backend`. [Backend deployment](../DEPLOYMENT.md)
documents recovery; `backend/render.yaml` records the standalone Blueprint
settings. Adoption requires matching the existing service name. Adding this file
alone does not change a manually configured dashboard service.

Local verification: `npm run build` produced the API and five worker bundles;
`npm run check:startup` passed all four built-production checks (configuration,
readiness/liveness, duplicate-port rejection and graceful shutdown). The YAML
parsed and its build/start/root/port settings and all six artifacts were checked.
No runtime application code, credentials or database data changed. The Render
dashboard was not modified and no deployment was triggered from this session.

## Earlier backend and release validation

Local backend validation on 2026-09-27: **606 tests passed across 120 files**:
604 tests across 119 files in the full suite, plus two development-startup tests
run separately. There were no failures or skips in those final runs. TypeScript
checking, API and five worker builds, and the built production API startup,
readiness, port-conflict and shutdown checks passed.

Local validation does not approve a production release.

## Backend startup validation

Startup fixes on 2026-09-27 address the local duplicate listener and improve
production readiness diagnostics. `npm run dev` now reports an existing API
instead of starting another listener, holds a watcher lock across restarts and
exits naturally after its checks on Windows. Production validates configuration
before database startup, claims the port before bootstrap writes/jobs, exposes
health probes during bootstrap and gates application requests until it completes.
Shutdown fails readiness immediately, releases realtime transports and has a
30-second deadline. The Docker liveness probe honors the configured `PORT`.

- Backend TypeScript checking and the API plus five worker builds passed.
- Full regression suite: **604/604 tests passed across 119 files**, including
  all four API startup regressions. The run took 20m32s; isolated imports,
  per-file database setup and workflow execution account for that time. The two
  later-added development regressions passed separately (2/2, one file), bringing
  the checked total to 606 tests across 120 files. No full-suite rerun was needed
  after the development-only fix; application/runtime code remained unchanged.
- `npm run check:startup` passed all four checks against the built production
  API: missing configuration fails before database connection; isolated replica-set
  startup returns healthy readiness/liveness; a duplicate listener exits before
  bootstrap writes/jobs; SIGTERM closes resources and releases the port.
- Both development startup regression tests passed, covering API reuse and an
  existing watcher during its restart window. The local running API returned
  readiness 200, and a second `npm run dev` exited successfully without spawning
  another API. No existing user server or frontend process was terminated.

The pasted Render logs show repeated readiness 503s and an older `prestart` build,
but do not contain readiness JSON or the failed dependency. The deployed endpoint
could not be reached during verification. This work does not certify or deploy
the live Render instance. Apply the current build/start commands and production
environment in [backend deployment](../DEPLOYMENT.md); inspect the new
readiness state log if a production dependency remains unhealthy.

## Operational release requirements

Before rollout, validate these current operational requirements:

- Supply persistent signing and data-encryption keys, TLS, authenticated MongoDB
  with transaction support, and authenticated Redis. Check the production environment
  verifier and test transaction behavior on the deployed topology.
- Review and apply the tenant-scoping, active-consultation-lock, outbox-index,
  domain-event-index and WhatsApp-storage migrations when the database requires them.
  Inspect conflicting records before any repair. Keep database backups recoverable.
- Build and deploy the API, frontend and five standalone workers. Verify API
  readiness and each worker's own readiness probe, queue age, retries, dead letters,
  provider callbacks and multi-replica behavior. Inline jobs must not duplicate them.
- Verify tenant/clinic/doctor scope and public tracker/check-in capabilities against
  the deployed API. OTP-free public booking grants appointment creation only.
- Verify payment server-side pricing, callback signatures, capture/replay behavior,
  invoice settlement and receipt outboxes on the real gateway.
- Verify PHI/secret redaction and audit-chain integrity. Historical audit remediation
  requires the chain-preserving operator procedure; it is not file cleanup.
- Verify AI provider credentials, configured model execution, tenant controls and
  clinician tool approvals. ABHA enrollment/lookup remains a sandbox operation and
  fails closed in production. Do not claim live ABDM approval from local FHIR tests.
- Run concurrency, failure, restore and browser CSP/XSS checks. Scripts use request
  nonces; dynamic style attributes still need the scoped style policy allowance.
- Test backup recovery on an isolated database and configure external monitoring,
  provider health alerts, storage retention and backup/PITR policies.

See [deployment](../DEPLOYMENT.md),
[backup/recovery](../DISASTER_RECOVERY.md),
[WhatsApp operations](whatsapp-setup.md) and
[partial-failure reconciliation](partial-failure-reconciliation.md).

## Separate repository organization — 2026-09-27

The frontend and backend own their scripts, documentation and GitHub workflows.
The backend release auditor no longer requires a sibling frontend checkout;
checkout payment-boundary checks run in frontend CI. Logo regeneration uses
`npm run brand:assets` from the frontend repository. Optional combined Docker
configuration is in `backend/deploy`. The unused combined staging workflow and
obsolete root files were removed. The outer `.git` has no normal commits or
remote, but contains saved agent change-history refs and was retained after the
final check. Application source and both app Git histories are unchanged.

Organization checks passed: backend TypeScript and API/worker builds, standalone
auditor fixture success/failure behavior, frontend payment-boundary and logo
commands, frontend script lint, three parsed workflow files and twenty local
documentation links. Auditor fixture compiler/test outputs were stubbed; no new
full-suite run or deployment is claimed by this filesystem cleanup.
