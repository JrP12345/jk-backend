# Optional combined Docker deployment

These files are for an operator running both prebuilt frontend and backend
images on one Docker host. Render deployments do not use this Compose setup.

Create `.env` in this directory with production values. The existing
`.env.example` describes the development deployment and must not be copied
unchanged into production. Configure image tags, `CADDY_SITE_ADDRESS` (the actual
frontend hostname, without a scheme/path), `ACME_EMAIL`, production URLs and
credentials before running from this directory:

```sh
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

Use prebuilt images with `pull`/`up`; the optional Compose build contexts require
the frontend sibling checkout. MongoDB is externally managed; Compose includes
private password-protected Redis, or `REDIS_URL` can point to a managed service. See
[backend deployment](../DEPLOYMENT.md) for worker and readiness requirements.

The Caddyfile reads `CADDY_SITE_ADDRESS` and `ACME_EMAIL` from its container
environment. Production Compose requires both; development Compose keeps its
explicit development defaults. Edge access logs omit URIs and request/response
headers so tracker proofs, auth callbacks, cookies and clinical searches are not
retained in those fields.

For the prepared dev.ekavyu.com staging stack, isolated storage, secret templates, first-account setup and later ekavyu.com cutover, use [the staging runbook](STAGING.md). No deployment is automatic.
