# Ekavyu Healthcare Platform — VM Deployment Guide (Development Environment)

Target URL: **`https://dev.ekavyu.com`**
Target Infrastructure: **Single VM (Google Cloud Compute Engine `e2-medium` or similar)**
Isolation Boundary: Strictly isolated from future production infrastructure and payment credentials. `https://ekavyu.com` remains completely untouched.

---

## 1. Architecture Overview

All services run in isolated Docker containers connected to a private bridge network (`ekavyu-net`). **Caddy is the only service that publishes public ports (80 and 443).**

```
Internet (HTTPS 443 / HTTP 80)
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│                       Caddy (Port 80/443)                   │
│             Automatic HTTPS & Reverse Proxy                 │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
    /api/*, /ws/*, /documentation*    All Other Traffic
               │                               │
               ▼                               ▼
┌──────────────────────────────┐ ┌───────────────────────────┐
│     Backend API (Node 24)    │ │   Frontend App (Next.js)  │
│        Port 5000 (Internal)  │ │     Port 3000 (Internal)  │
└──────────────┬───────────────┘ └───────────────────────────┘
               │
       ┌───────┴───────────────┬──────────────────────────────┐
       │                       │                              │
       ▼                       ▼                              ▼
┌──────────────┐ ┌───────────────────────────────┐ ┌───────────────────────────────┐
│ Redis 7      │ │ 5 Dedicated Workers           │ │ MongoDB Atlas Replica Set     │
│ Port 6379    │ │ Notification (5001)           │ │ (External Cloud Managed)      │
│ (Internal)   │ │ Outbound Messages (5002)      │ │ TLS & SCRAM-SHA-256 Auth      │
│ Persistent   │ │ Disruption Timeout (5003)     │ │ Min Pool: 2, Max Pool: 10     │
│ AOF Volume   │ │ Domain Events (5004)          │ └───────────────────────────────┘
└──────────────┘ │ No-Show Sweeper (5005)        │
                 └───────────────────────────────┘
```

---

## 2. Important Build-Time Distinction: `NEXT_PUBLIC_API_URL`

> [!IMPORTANT]
> In Next.js client-side code, all environment variables prefixed with `NEXT_PUBLIC_` are **inlined into the JavaScript bundle at build time**, NOT at container runtime.
>
> If you change `NEXT_PUBLIC_API_URL` in `.env`, you **must re-execute `docker compose build frontend`** to bake the new endpoint into the browser assets.
>
> For `dev.ekavyu.com`, the build argument is preconfigured in `docker-compose.yml`:
> ```yaml
> args:
>   NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-https://dev.ekavyu.com/api}
> ```

---

## 3. Directory Structure on Target Host (`/opt/ekavyu`)

The stack is designed to run from the root of `/opt/ekavyu`:

```
/opt/ekavyu/
├── docker-compose.yml       # Complete multi-service Compose configuration
├── Caddyfile                # Caddy reverse proxy rules & TLS termination
├── .env                     # Secrets & environment configuration (from .env.example)
├── backend/                 # Backend repository clone (Fastify + Workers)
│   ├── Dockerfile
│   └── ...
└── frontend/                # Frontend repository clone (Next.js Standalone)
    ├── Dockerfile
    └── ...
```

---

## 4. Required External Resources (Pre-Requisites)

Before launching the containers, the following external cloud resources must be ready:

1. **Virtual Machine**:
   - Ubuntu 24.04 LTS (e.g. GCP Compute Engine `e2-medium`, 2 vCPU, 4 GB RAM, 30 GB SSD).
   - Static External IP attached to the VM.
   - 2 GB Linux swapfile enabled (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`).
   - Docker Engine & Docker Compose Plugin installed.
   - Firewall: Allow inbound TCP ports `80`, `443`, and `22`.

2. **MongoDB Atlas Development Cluster**:
   - A dedicated development cluster (e.g. M0 free tier or M2/M5 shared) configured as a **Replica Set** (`mongodb+srv://...`).
   - Network Access: Whitelist the VM's static IP.
   - Database User: Create a user with readWrite access to the `ekavyu_dev` database.

3. **Cloudflare DNS & SSL**:
   - DNS: Add an `A` record pointing `dev.ekavyu.com` to the VM's static IP (Proxied enabled).
   - SSL/TLS: Set encryption mode to **Full (strict)**.

4. **Cloudflare R2 Bucket (Optional for dev uploads)**:
   - Create a development bucket (e.g. `ekavyu-dev-vault`) with an API token possessing read/write permissions.

---

## 5. Required Environment Variables

Copy the provided template to `.env`:

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and fill in the values:

| Variable | Description / How to Generate |
| :--- | :--- |
| `NODE_ENV` | Must be `production` for container optimization |
| `APP_URL` | `https://dev.ekavyu.com` |
| `FRONTEND_URL` | `https://dev.ekavyu.com` |
| `PUBLIC_API_BASE_URL` | `https://dev.ekavyu.com` |
| `CORS_ALLOWED_ORIGINS` | `https://dev.ekavyu.com` |
| `NEXT_PUBLIC_API_URL` | `https://dev.ekavyu.com/api` (Baked into frontend build) |
| `MONGODB_URI` | `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/ekavyu_dev?retryWrites=true&w=majority` |
| `MONGODB_MIN_POOL_SIZE` | `2` (Development connection sizing) |
| `MONGODB_MAX_POOL_SIZE` | `10` (Development connection sizing) |
| `REDIS_PASSWORD` | Generate via: `openssl rand -hex 24` |
| `REDIS_URL` | `redis://:${REDIS_PASSWORD}@redis:6379` |
| `RUN_INLINE_JOBS` | `false` (Ensures jobs are handled by dedicated workers) |
| `DATA_ENCRYPTION_KEY` | Persistent secret shared by API and workers; preserve the existing value. Generate only for a fresh database via: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_PRIVATE_KEY_BASE64`| Base64 of RS256 private key (run `npm run generate:keys` in backend) |
| `JWT_PUBLIC_KEY_BASE64` | Base64 of RS256 public key (run `npm run generate:keys` in backend) |
| `WEBAUTHN_ORIGIN` | `https://dev.ekavyu.com` |
| `WEBAUTHN_RP_ID` | `dev.ekavyu.com` |
| `RAZORPAY_KEY_ID` | Razorpay sandbox test key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay sandbox test key secret |
| `RAZORPAY_WEBHOOK_SECRET`| Razorpay test webhook secret |
| `UPI_WEBHOOK_SECRET` | Development UPI webhook secret |
| `ACME_EMAIL` | Email address for TLS certificate notifications |

---

## 6. Deployment Commands

### Build Container Images
From `/opt/ekavyu`:

```bash
# Build backend, 5 workers, and frontend with build arguments
docker compose build
```

### Start the Stack
```bash
# Launch all 9 services in detached mode
docker compose up -d
```

### Check Container Status & Health
```bash
docker compose ps
```
All services (`caddy`, `redis`, `backend`, `frontend`, and all 5 workers) should show status **`healthy`** (or `running`).

### Inspect Logs
```bash
# Stream all logs
docker compose logs -f

# Inspect specific service logs
docker compose logs -f caddy
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f notification-worker
docker compose logs -f outbound-message-worker
docker compose logs -f disruption-timeout-worker
docker compose logs -f domain-event-worker
docker compose logs -f no-show-worker
```

### Verify Endpoint Health
```bash
# Check Backend API readiness through Caddy
curl -I https://dev.ekavyu.com/api/health/readiness

# Check Frontend HTTP response through Caddy
curl -I https://dev.ekavyu.com/
```

### Stop the Stack
```bash
# Stop all services gracefully (preserving persistent volumes)
docker compose down

# Stop and remove volumes (WARNING: clears redis-data, caddy-data)
# docker compose down -v
```

---

## 7. Security Hardening Measures

- **No Public Database or Cache**: Neither Redis (port 6379) nor MongoDB are bound to the host network.
- **No Direct App Exposure**: Neither Fastify (port 5000) nor Next.js (port 3000) nor worker health ports (5001-5005) publish host ports. Only Caddy publishes `80:80` and `443:443`.
- **Non-Root Execution**: Both `backend` and `frontend` Docker images switch to `USER node` before running application processes.
- **Strict Network Isolation**: All internal communication is restricted to the Docker bridge network `ekavyu-net`.
- **Zero Secrets Committed**: All cryptographic keys, database URIs, and webhook secrets are injected via local `.env`.
