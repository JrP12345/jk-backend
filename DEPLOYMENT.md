# Ekavyu deployment

Use Node.js 24. MongoDB must support transactions through an authenticated replica
set or managed equivalent. Production replicas require authenticated Redis and
persistent signing/encryption keys. Configure the backend's environment verifier;
do not use local development fallbacks as production credentials.

## Build

Run npm ci then npm run build in backend/. Installation does not build source.
esbuild produces dist/index.js and dist/workers/*.js. The backend Docker image
contains production dependencies and those executable bundles.

### Render web service

Set the service's **root directory** to `backend` when deploying the workspace
repository, or leave it empty when deploying the standalone backend repository.
Use **build command** `npm ci --include=dev && npm run build`, **start command**
`npm start`, Node.js **24**, and **health check path** `/api/health/readiness`.
Set `NODE_ENV=production` in Render's environment and let Render supply `PORT`.
The API binds to `0.0.0.0` and honors that port. `npm start` runs the built API;
it does not compile source, run nodemon or start a second listener on restart.
The Docker liveness check also uses the actual `PORT` instead of assuming 5000.

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
checks configuration failure, readiness/liveness, duplicate port ownership and
graceful shutdown/port release. Its Redis single-node override applies only to
that isolated test; it does not validate the deployed Redis service.

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

Use docker-compose.production.yml with BACKEND_IMAGE, FRONTEND_IMAGE and required
production environment values. It does not provision MongoDB or Redis.

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
../docs/production-readiness-tracker.md; local passing checks do not close external
production gates.
