# ANANTA Healthcare — Production Deployment & Hardening Guide

## 1. Architecture Overview

- **Frontend:** Next.js 16 (React 19, Tailwind CSS, Zustand, TanStack Query)
- **Backend:** Fastify 5 + Mongoose 9 (Node.js 20+ with native TypeScript `--experimental-strip-types`)
- **Database:** MongoDB 7.0+ (Replica Set required for multi-document ACID transactions)
- **Cache & Pub/Sub:** Redis 7.0+ (Rate limiting cluster, SSE real-time notifications synchronization)
- **Authentication:** Asymmetric RS256 JWT (15-minute access token + 7-day rotated refresh token stored in HttpOnly SameSite cookies)
- **Field-Level Encryption:** AES-256-GCM for all at-rest credentials (2FA TOTP secrets, organization SMTP passwords)

---

## 2. Environment Variables Checklist

### Backend (`backend/.env`)

| Variable | Required | Description | Example / Recommendation |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes | Runtime mode (`production` / `development` / `test`) | `production` |
| `PORT` | Yes | HTTP listening port | `5000` |
| `MONGODB_URI` | Yes | MongoDB Replica Set connection string | `mongodb+srv://user:pass@cluster.mongodb.net/ananta_health?retryWrites=true&w=majority` |
| `MONGODB_MAX_POOL_SIZE` | No | Maximum MongoDB connection pool size (defaults to 25) | `50` |
| `ENCRYPTION_KEY` | Yes | 64-character hexadecimal key (32 bytes) for AES-256-GCM | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CORS_ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed frontend domain origins | `https://app.ananta.health,https://admin.ananta.health` |
| `COOKIE_DOMAIN` | Recommended | Root domain for cross-subdomain cookies (with leading dot) | `.ananta.health` |
| `COOKIE_SAME_SITE` | Optional | Cookie SameSite policy (`lax`, `none`, `strict`) | `lax` (or `none` if frontend & backend are completely separate domains) |
| `REDIS_URL` | **Required in Prod** | Redis URI for cross-pod WebSocket fan-out & panic alert replay | `redis://default:password@redis.internal:6379` |
| `ALLOW_SINGLE_NODE_IN_PRODUCTION` | Optional | Override flag to run production without Redis (disables cross-pod alerts) | `false` |
| `JWT_PRIVATE_KEY_BASE64` | **Required in Prod** | Base64-encoded RS256 Private Key (run `npm run generate:keys`) | `LS0tLS1CRUdJTi...` |
| `JWT_PUBLIC_KEY_BASE64` | **Required in Prod** | Base64-encoded RS256 Public Key (run `npm run generate:keys`) | `LS0tLS1CRUdJTi...` |
| `BACKUP_ENCRYPTION_KEY` | Recommended | Dedicated 64-char hex key for backup archives (avoids key rotation trap) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BACKUP_HEARTBEAT_URL` | Optional | Dead-man's switch webhook (e.g. Healthchecks.io / Better Uptime) | `https://hc-ping.com/your-uuid` |
| `SENTRY_DSN` | Recommended | Sentry DSN for exception tracking (allowlist-scrubbed for PHI/DPDP) | `https://key@sentry.internal/1` |
| `SENTRY_ENVIRONMENT` | Optional | Environment tag for Sentry issues | `production` |
| `OPS_ALERT_WEBHOOK_URL` | Recommended | Webhook URL for near-real-time P0/P1 paging (PagerDuty / Slack) | `https://events.pagerduty.com/v2/enqueue` or Slack incoming webhook |
| `JWT_PRIVATE_KEY` | Alternative | Raw RS256 Private PEM (with `\n` line breaks) | `"-----BEGIN PRIVATE KEY-----\n..."` |
| `JWT_PUBLIC_KEY` | Alternative | Raw RS256 Public PEM (with `\n` line breaks) | `"-----BEGIN PUBLIC KEY-----\n..."` |
| `SMTP_HOST` | Recommended | Outbound SMTP server hostname | `smtp.postmarkapp.com` |
| `SMTP_PORT` | Recommended | Outbound SMTP server port (587 or 465) | `587` |
| `SMTP_USER` | Recommended | SMTP username | `api-key` |
| `SMTP_PASS` | Recommended | SMTP password / API token | `your_secret_token` |
| `SMTP_FROM_EMAIL` | Recommended | Default sender address | `notifications@ananta.health` |
| `SMTP_FROM_NAME` | Recommended | Sender name | `ANANTA Healthcare` |
| `CLOUDFLARE_ACCOUNT_ID` | Conditional | Cloudflare R2 account ID for document storage | `...` |
| `R2_ACCESS_KEY_ID` | Conditional | R2 S3 access key ID | `...` |
| `R2_SECRET_ACCESS_KEY` | Conditional | R2 S3 secret access key | `...` |
| `R2_BUCKET_NAME` | Conditional | R2 storage bucket name | `ananta-prod-storage` |

### Frontend (`frontend/.env.production`)

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `NEXT_PUBLIC_API_URL` | Yes | Public REST API base URL | `https://api.ananta.health/api` |

---

## 3. Production Hardening Features Implemented

1. **2FA Secrets AES-256-GCM Encryption:** All Google Authenticator / TOTP secrets are encrypted before persisting to MongoDB, preventing 2FA compromise in database leaks.
2. **Organization SMTP Passwords Encrypted:** Passwords for custom clinic SMTP credentials are encrypted at rest with automatic runtime decryption.
3. **Cross-Site Request Forgery (CSRF) Protection:** State-changing mutation routes (`POST`, `PUT`, `PATCH`, `DELETE`) with cookie authentication validate the `Origin` and `Referer` against configured `CORS_ALLOWED_ORIGINS`.
4. **Refresh Token Rotation & Reuse Detection:** Every refresh operation revokes the old refresh token, issues a fresh rotated token, and invalidates all user sessions if a revoked token reuse attempt is detected.
5. **NoSQL Injection Sanitization:** Recursive request preValidation hook strips `$` and dot-notation injection keys from bodies and queries.
6. **Reverse-Proxy Rate Limiting:** Configured with `trustProxy: true` to properly inspect `X-Forwarded-For` from Cloudflare, AWS ALB, Nginx, and Render.
7. **Connection Pool Management:** Mongoose configured with pooled min/max connections, fast fail timeouts (5000ms), and standalone topology warnings.
8. **Strict Allowlist PHI Scrubbing:** Sentry telemetry employs an explicit allowlist pattern. All request bodies, cookies, and local patient variables are discarded; error messages are scrubbed for Aadhaar, ABHA, mobile numbers, and auth tokens. Clinical telemetry adheres to Indian DPDP requirements (self-hosted Sentry or sovereign cloud instance recommended).
9. **Real-time Ops Paging (P0 Critical):** Panic-alert and diagnostic engine evaluation exceptions trigger real-time HTTP webhooks (`OPS_ALERT_WEBHOOK_URL`) to PagerDuty or Slack, preventing life-critical failures from idling in unmonitored inboxes.
10. **CI Security Audit Threshold:** Automated pipeline dependency checks run with `--audit-level=high` to block critical and high CVEs without fatiguing the team with low-severity dev dependency noise.

---

## 4. Docker Deployment

### Building Backend Image
```bash
docker build -t ananta-backend:latest ./backend
docker run -d -p 5000:5000 --env-file ./backend/.env --name ananta-backend ananta-backend:latest
```

### Building Frontend Image
```bash
docker build -t ananta-frontend:latest --build-arg NEXT_PUBLIC_API_URL=https://api.ananta.health/api ./frontend
docker run -d -p 3000:3000 --name ananta-frontend ananta-frontend:latest
```

### Health & Readiness Probes (Step 4.2 Hardened)
- **Liveness probe (`GET /api/health/liveness`):** HTTP 200 process-level check reporting PID, process uptime, and memory RSS. It intentionally ignores temporary downstream database/Redis degradation to prevent Kubernetes restart thrashing.
- **Readiness probe (`GET /api/health/readiness`):**
  Returns HTTP 200 only when ALL of the following are satisfied:
  1. MongoDB is open (`readyState === 1`) and responds to an admin ping within 1500ms.
  2. Redis is reachable and responds to `PING` with `PONG` within 1500ms (or `ALLOW_SINGLE_NODE_IN_PRODUCTION=true` is explicitly set).
  3. Environment configuration is fully valid (`validateConfig()`).
  4. Server startup/bootstrap is finished (`seedDefaultRoles` and `syncOrganizationPlanQuotas` completed).
  5. The server is not shutting down.
  *Note:* On `SIGTERM` / `SIGINT`, readiness returns HTTP 503 immediately while traffic is drained for `SHUTDOWN_DRAIN_MS` (default 2000ms) before HTTP listeners close.
- **Worker Health & Readiness:** Background workers expose independent health and readiness endpoints (`/health` and `/ready`) on configurable ports (e.g. port 5004 for `domain-event-worker`). Worker readiness checks DB connectivity and worker loop state independently from HTTP routing.
- **Synthetic Canary probe (`GET /api/health/synthetic`):** HTTP 200 with full end-to-end verification: dedicated `_canary_probes` collection write/read/delete, diagnostic engine panic threshold test on Potassium 6.9, and Redis WebSocket fan-out test on isolated test channel.
- **System metrics (`GET /api/health`):** HTTP 200 with ISO timestamp.

---

## 5. Background Workers Architecture

Production separates HTTP request serving from asynchronous event processing and message deliveries. The API container never runs timers or background loops directly.

| Worker Process | Command | Purpose |
| :--- | :--- | :--- |
| **Notification Worker** | `npm run worker:notifications` | Claims and delivers in-app/email `NotificationDelivery` rows with leases and exponential backoff |
| **Outbound Message Worker** | `npm run worker:outbound-messages` | Dispatches encrypted WhatsApp, SMS, and invoice payment receipts |
| **Disruption Timeout Worker** | `npm run worker:disruption-timeouts` | Executes single-leader lease-managed disruption sweep and queue timeout claims |
| **Domain Event Worker** | `npm run worker:domain-events` | Claims and dispatches durable encrypted domain events from `DomainEventOutbox` |

In Docker Compose or Kubernetes, run each worker as an independent replica container using the same backend image.

---

## 6. Required Production Migrations

Before launching API or worker instances against a newly provisioned MongoDB replica set, run the following index and lock migrations:

```bash
# 1. Backfill sparse unique active-consultation lock
npm run migrate:active-consultation-lock

# 2. Prepare compound indexes for notification & message outboxes
npm run migrate:outbox-indexes

# 3. Prepare unique idempotency & compound indexes for domain event outbox
npm run migrate:domain-event-indexes
```

---

## 7. Historical Audit Remediation Runbook

If legacy audit records exist prior to the write-time PHI redaction boundary, use the chain-preserving remediation tool:

```bash
# 1. Scan audit chain for unredacted fields or broken links (non-mutating)
npm run audit:scan

# 2. Export cryptographic chain attestation artifact before remediation
node --env-file=.env --experimental-strip-types scripts/audit-remediation.ts --export-chain --org=<ORG_ID>

# 3. Dry-run remediation to verify planned modifications
node --env-file=.env --experimental-strip-types scripts/audit-remediation.ts --execute --dry-run --org=<ORG_ID>

# 4. Execute remediation (redacts PHI, updates hash chain, records ChainTransitionRecord)
npm run audit:remediate -- --org=<ORG_ID> --reason="VAPT compliance audit remediation" --operator=<ROOT_USER_ID>
```

---

## 8. Multi-Replica Horizontal Scaling Architecture (Phase 6)

### 8.1 API Replicas & Stateless Invariants
HealthOS API instances are fully stateless and run with at least 2 active replicas behind a reverse proxy / load balancer:
- **No in-process sticky state**: User sessions, permissions, and locks do not depend on routing affinity.
- **Session Revocation Broadcast**: Handled via Redis Pub/Sub channel `session:events` and `session:revoke`. When any replica revokes a session or token family, all peer replicas immediately evict local memory caches and disconnect user WebSockets.
- **Authoritative Permission Invalidation**: Changes to roles or user permissions broadcast across `auth:role:invalidate` and `perm:invalidate`, immediately purging in-memory role caches across all nodes.
- **WebSocket Pub/Sub & Fan-Out**: Real-time notifications and queue display updates broadcast via Redis pub/sub (`user_notifications:*`, `clinic_queue:*`, `clinic_clinical:*`). Each node tags outgoing messages with `NODE_ID` to guarantee self-echo suppression.
- **Graceful Draining**: On `SIGTERM`/`SIGINT`, readiness probes immediately return HTTP 503 to decouple from load-balancer ingress traffic, draining in-flight requests for `SHUTDOWN_DRAIN_MS` (default 2000ms) before terminating listeners.

### 8.2 Distributed Locks & Leader-Elected Background Jobs
- **WorkerLease**: Scheduled jobs (e.g. `noShowSweepJob`, `disruptionTimeoutJob`) acquire an atomic distributed lease backed by MongoDB with unique index on `name`.
- **Fail-Safe Invariant**: If a lease acquisition fails or encounters network partition, replicas fail safely by skipping execution rather than falling back to competing local work.

### 8.3 Worker Scaling & Backpressure
- **Independent Concurrency**: Each worker defines concurrency independently via `scalability.ts` (`DOMAIN_EVENT_WORKER_BATCH_SIZE`, `OUTBOUND_MESSAGE_WORKER_BATCH_SIZE`).
- **Single-Worker Claim Semantics**: Outbox rows are claimed atomically with `findOneAndUpdate` using unique `lockedBy` UUIDs, status CAS updates, and TTL locks (`lockedUntil`).
- **Dynamic Backpressure**: When queue age exceeds `WORKER_BACKPRESSURE_QUEUE_AGE_SEC` (300s) or pending count exceeds `WORKER_BACKPRESSURE_PENDING_LIMIT` (500), workers throttle poll rates by `WORKER_BACKPRESSURE_POLL_MULTIPLIER` to prevent downstream cascading failures.
- **Queue Age Metrics**: Monitored via `/health` metrics reporting `oldestEventAgeMs`, `pendingCount`, `retryingCount`, `processingCount`, and `inBackpressure`.

### 8.4 Resource Budgets
Centralized limits in `backend/utilities/scalability.ts`:
- Request body ceiling: `MAX_REQUEST_BODY_BYTES` (10 MB)
- Single-file upload: `MAX_UPLOAD_BYTES` (25 MB)
- Hard pagination ceiling: `MAX_PAGINATION_LIMIT` (100 items, default 20)
- Report range ceiling: `MAX_REPORT_RANGE_DAYS` (365 days)
- Report export row limit: `MAX_REPORT_ROWS` (10,000 rows)
- AI context window: `MAX_AI_CONTEXT_TURNS` (8 turns)
- AI session message ceiling: `MAX_AI_SESSION_MESSAGES` (500 messages)
- Domain event retry ceiling: `MAX_EVENT_RETRY_COUNT` (5 retries)
- Database pool size: `DB_POOL_SIZE` (50 in production, 10 in dev)
- Per-tenant rate limit: `TENANT_RATE_LIMIT_PER_MINUTE` (2,000 req/min enforced via `tenantRateLimiter`)


