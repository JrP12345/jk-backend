# Ekavyu deployment

The final source/configuration gate and cross-repository launch actions are in
the frontend [Phase 1 final report](../frontend/docs/phase1-final-production-gate.md).
The frontend dependency-audit blocker is now closed; full frontend/backend npm
audits report zero vulnerabilities and the source/configuration code gate is
PASS. No new tests or build were run in that final pass or dependency closure.
Complete the report's hosting, provider, worker and recovery requirements before
launch; a repository gate does not certify the deployed environment.

Use Node.js 24. MongoDB must support transactions through an authenticated replica
set or managed equivalent. Production replicas require authenticated Redis and
persistent signing/encryption keys. Configure the backend's environment verifier;
do not use local development fallbacks as production credentials.
Production also requires `PRESCRIPTION_SIGNING_KEY` (at least 32 characters), or
the actual strong legacy `JWT_SECRET` used to seal existing prescriptions.
Preserve historical key compatibility deliberately; never use the old public
sealing constant or silently re-sign historical records. Compose requires the
explicit prescription-key variable for API and all workers.

## Build

Run npm ci then npm run build in backend/. Installation does not build source.
esbuild produces dist/index.js and dist/workers/*.js. The backend Docker image
contains production dependencies and those executable bundles.

Dependency installation no longer downloads the test-only MongoDB binary:
`package.json` sets `config.mongodbMemoryServer.disablePostinstall=true`.
Integration/startup tests can still obtain their binary when they explicitly run;
the installed test dependency is not disabled. Do not use `--ignore-scripts`,
which would also bypass esbuild's installation setup.

The build prints its elapsed compilation time and verifies the API/worker
executables. An install delay, compiler error, integration-test failure and
production readiness failure are separate stages. `npm run audit:release` runs
the full serial integration suite and belongs in CI/release verification, not
Render's build or start command. The recorded full suite took about 20 minutes;
`npm run build` does not run that suite or connect to the production database.

### Render web service

Set the service's **root directory** to `backend` when deploying the workspace
repository, or leave it empty when deploying the standalone backend repository.
Use **build command** `npm ci --include=dev && npm run build`, **start command**
`npm start`, Node.js **24**, and **health check path** `/api/health/readiness`.
Set `NODE_ENV=production` in Render's environment and let Render supply `PORT`.
The API binds to `0.0.0.0` and honors that port. `npm start` runs the built API;
it does not compile source, run nodemon or start a second listener on restart.
The Docker liveness check also uses the actual `PORT` instead of assuming 5000.

#### Missing prescription signing key on Render

If the build succeeds but `npm start` exits with `PRESCRIPTION_SIGNING_KEY
(or legacy JWT_SECRET) must be a persistent secret of at least 32 characters`,
open the existing service's **Environment** page. Configure
`PRESCRIPTION_SIGNING_KEY` with the persistent secret used for prescription seals.
The same key must be available to every API instance and worker that uses it.
An existing strong `JWT_SECRET` is accepted for legacy compatibility; the RS256
JWT private/public key pair does not replace this prescription signing secret.

If prescriptions were already sealed, recover their actual previous signing key
from the secret store or deployment environment. Do not replace it with a newly
generated value or the former public fallback constant. Historical seals need an
explicit migration/retirement plan when their original key is unavailable.

For a new installation with no existing sealed prescriptions, generate a secret
once in a private local terminal:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Store the generated value in Render and the secret manager; do not commit it or
generate a different value on every startup. Choose **Save and deploy** to use
the already successful build with the corrected environment. Confirm that startup
passes configuration validation and `/api/health/readiness` returns HTTP 200.
The `No open ports detected` message accompanies this early process exit; changing
`PORT` cannot repair a missing signing key. Retain the readiness health check.

See [Render environment variable management](https://render.com/docs/configure-environment-variables).
Editing `.env.example` or `render.yaml` alone does not update an existing manually
configured Render service's environment.

#### Missing `dist/index.js` on Render

The September 27 deployment at commit `97ab1e8` ran build command `npm install`
and then start command `npm start`. That installed dependencies without running
the compiler, so startup failed with `MODULE_NOT_FOUND` for `dist/index.js`.
Restarting or redeploying with the same build command repeats this failure.

In the existing service's Render dashboard, open **Settings > Build & Deploy**
and set **Build Command** to `npm ci --include=dev && npm run build`. Keep
**Start Command** as `npm start`. For `JrP12345/jk-backend`, leave **Root Directory**
empty because `package.json` is at that repository's root. Save and redeploy
using **Clear build cache & deploy**. Build logs must show `npm run build` and
the generated `dist/index.js` before startup. `--include=dev` includes esbuild
even with `NODE_ENV=production`.

`render.yaml` records these settings for the standalone backend repository.
It takes effect when adopted through a Render Blueprint; adding it to Git alone
does not update an existing manually configured service. Before adopting it,
match its service `name` to the existing Render service name and keep existing
production environment variables. A workspace-repository Blueprint needs
`rootDir: backend` and the appropriate repository URL instead. Dist stays ignored
in Git and is built during deployment; no runtime compilation hook is required.

The supplied September 26 logs show an older deployment with a `prestart` build
and repeated readiness 503s. Deploy the current source and build command rather
than reusing that older artifact. A health check must remain unhealthy while
MongoDB, required Redis, configuration or bootstrap is unavailable. Do not switch
to the liveness endpoint to conceal a readiness failure. See
[Render health checks](https://render.com/docs/health-checks).

Provide the persistent JWT key pair, encryption key, replica-set MongoDB URI,
Redis connection, frontend CORS origins and payment webhook secret required by
the configuration verifier. Configuration is checked before database startup.
Readiness now logs the failed dependency/configuration when its state changes;
inspect this entry or the readiness JSON if Render reports another 503. The old
logs contain only response status codes and cannot identify which dependency
failed. `ALLOW_SINGLE_NODE_IN_PRODUCTION=true` remains an explicit single-node
override, not an automatic fallback or a solution for multi-replica deployments.

After building, `npm run check:startup` checks the actual production bundle with
an isolated MongoDB replica set and temporary in-memory test credentials. It
checks configuration failure, production Redis placeholders, readiness/liveness, duplicate port ownership and
graceful shutdown/port release. Its Redis single-node override applies only to
that isolated test; it does not validate the deployed Redis service.

#### Fifteen-minute deploy timeout with Redis `not_configured`

The supplied 12:33 UTC logs show successful MongoDB connection and bootstrap,
followed by readiness HTTP 503 with Redis `not_configured`. This deployment is
waiting for health checks, not compiling. Render cancels a new deployment if
its instances do not pass health checks within 15 minutes.

In **Anant-Backend > Environment**, choose the setting for your topology:

- For one API instance without Redis, set `ALLOW_SINGLE_NODE_IN_PRODUCTION=true`
  and remove development `REDIS_URL` / `REDIS_HOST` placeholders. In-memory
  rate limiting and event delivery stay confined to that API process. Do not
  scale to multiple API replicas with this override.
- For a Redis-backed deployment, set `REDIS_URL` to the actual service connection
  URL (`redis://` or `rediss://`) and remove/disable the single-node override.
  Localhost points at the API container, not a remote Redis service.

Keep `NODE_ENV=production`, save the environment changes and redeploy. Readiness
must report HTTP 200 after bootstrap with Redis `ready` or the deliberate
`single_node_override`. The health-check path stays `/api/health/readiness`.
The legacy Render service name is retained as an existing deployment identifier.

Startup validation and client initialization now resolve the same Redis settings.
Required missing/invalid/local Redis configuration exits before MongoDB connects,
with the corrective environment setting in its error message. Previously a local
URL satisfied validation but the client rejected it, leaving readiness at 503.
Actual connection failures still fail readiness; validation does not certify
network access or authenticate Redis.

### Local development and port conflicts

Use `npm run dev` from `backend/`. It loads the local `.env`, starts one Node.js
watcher and retains a process lock through API restarts. If the API or this
watcher is already running, the command reports its PID and reuses it instead
of launching a competing listener. It removes a dead watcher's stale lock on
the next launch. Stop the original terminal before starting another watcher;
do not run nodemon and `npm run dev` for the same API simultaneously.

An unrelated listener still produces a clear port-conflict error. Change `PORT`
only if that is intentional, and update the frontend API URL to match. The API
claims its port before bootstrap writes/jobs, serves readiness during bootstrap,
and gates application requests until bootstrap completes. Shutdown fails readiness
immediately, closes realtime transports, drains requests and releases resources
within a bounded deadline.

Run npm ci then npm run build in frontend/. The Docker image serves the traced
standalone server as a non-root user. NEXT_PUBLIC_API_URL must be correct at image
build time; changing it in the container environment does not rebuild browser code.
Next rewrites and headers are captured in the standalone output at build time.

## Production processes

Use `deploy/docker-compose.production.yml` with BACKEND_IMAGE, FRONTEND_IMAGE
and required production environment values; run Compose from `deploy/`. It does not provision MongoDB or Redis.

| Process | Built command |
| --- | --- |
| API | node dist/index.js |
| Domain events | node dist/workers/domainEventWorker.js |
| Notifications | node dist/workers/notificationDeliveryWorker.js |
| Outbound communications/webhooks | node dist/workers/outboundMessageWorker.js |
| Disruption timeouts | node dist/workers/disruptionTimeoutWorker.js |
| No-show sweep | node dist/workers/noShowSweepWorker.js |

The matching npm worker:* commands load a local .env only if present. Build first.
Production normally uses separate workers; RUN_INLINE_JOBS=true is an explicit
alternative and must not accidentally duplicate scheduled processing.
The outbound worker also owns the existing lease-protected subscription billing
reconciliation (five-minute schedule) and branding cleanup (ten-minute schedule).
Keep RUN_INLINE_JOBS=false on the API when using these standalone workers.

API probes: /api/health/liveness and /api/health/readiness. Each executable worker has its own /health and /ready server on ports 5001-5005
(notification, outbound, disruption, domain-event, no-show respectively).
Compose API probes must not be reused as proof of worker health. Monitor worker
processes, queue age, terminal failures and provider callbacks independently.

## Rollout

From a controlled source checkout, review and back up data before running
migrate:active-consultation-lock, migrate:outbox-indexes, migrate:domain-event-indexes
or migrate:whatsapp. Inspect each script's dry-run/apply behavior. Do not guess how
to repair conflicting data or run a migration merely because the code builds.

Use audit:scan and the explicit remediation options in scripts/audit-remediation.ts
for historical audit review. Immutable historical audit entries need a deliberate
chain-preserving transition, not ordinary cleanup edits.

Provision TLS, secrets management, backups/PITR, external health alerts and restore
drills. Validate the built image, authenticated database topology, transactions,
worker delivery and multi-replica behavior in staging before release. See
docs/production-readiness-tracker.md; local passing checks do not close external
production gates.
