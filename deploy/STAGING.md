# Ekavyu staging deployment and apex cutover

2026-10-08. **Configuration prepared; remote deployment is pending approval and infrastructure.** Staging is https://dev.ekavyu.com. The final application origin will be https://ekavyu.com after a separately approved cutover. No cloud resource, DNS record, remote database or deployment was changed.

## Architecture and prerequisites

Use one dedicated Ubuntu 24.04 LTS or supported Debian VM with Docker Engine/Compose, Caddy, the existing Next/Fastify images, Redis and all four existing workers. Start with approximately 2 vCPU / 4 GB RAM if building images on the host; this is a sizing starting point, not a capacity guarantee. Keep the current static marketing hosting/DNS untouched during testing. No Kubernetes, separate API host, registry or new paid app service is required.

Use a separate Atlas project/replica set and database **ekavyu_dev**, with a database user restricted to that database and network access restricted to the VM's egress IP. Atlas Free is suitable for small synthetic staging fixtures if its limits fit: three-node replication, 0.5 GB storage including indexes, and no managed backups. It is not a production capacity/backup plan. Keep a recoverable private export when staging data matters. [Atlas limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/), [IP access](https://www.mongodb.com/docs/atlas/security/ip-access-list/).

| Setting | Testing | After approved production cutover |
| --- | --- | --- |
| Application origin / API | https://dev.ekavyu.com /api | https://ekavyu.com /api |
| Marketing | Existing ekavyu.com hosting | Remove apex mapping only at cutover; optionally retain marketing elsewhere |
| Caddy configuration | Caddyfile.staging, forced noindex | Caddyfile, eligible public pages indexable |
| Persistence | Dedicated staging DB/bucket/volumes | Explicitly approved production DB/bucket/volumes and backup plan |
| Cookies | Secure, host-only, SameSite=Lax | Secure, host-only; do not share cookies across environments |
| Passkeys | dev.ekavyu.com RP ID | ekavyu.com RP ID; users must re-enroll for the new RP ID |

Caddy owns public ports 80/443, routes /api and WebSockets directly to backend:5000, and sends other requests to frontend:3000. Frontend SSR and compiled fallback rewrites also use backend:5000 directly. A single public origin avoids cross-domain session problems. API/workers/Redis publish no host ports. Staging gets its own Compose project, Docker network and three persistent volumes, bounded container logs, readiness probes and restart policies. Use a separate host if production and staging must coexist; both stacks bind 80/443.

## Required configuration

Copy [.env.staging.example](.env.staging.example) to **.env.staging**, owner-readable only. Public values are already set to dev.ekavyu.com. Keep the explicit origin-only PUBLIC_API_BASE_URL: existing webhook generation appends /api itself.

| Variables | Required action |
| --- | --- |
| APP_URL, FRONTEND_URL, PUBLIC_API_BASE_URL, CORS_ALLOWED_ORIGINS, NEXT_PUBLIC_API_URL, CADDY_SITE_ADDRESS, WEBAUTHN_ORIGIN, WEBAUTHN_RP_ID | Use the supplied staging values. APP_URL is supplied at build and runtime; NEXT_PUBLIC_API_URL is compiled into browser code. |
| ACME_EMAIL | Real certificate contact address. |
| MONGODB_URI | Authenticated TLS Atlas/replica-set URI, explicit ekavyu_dev database; URL-encode password characters. Do not use standalone/single-node bypass flags. |
| REDIS_PASSWORD | Independent random hex password. Compose builds the private Redis URL; leave REDIS_URL unset for this recipe. |
| DATA_ENCRYPTION_KEY | Persistent fresh 64-character hex secret for this new installation. |
| PRESCRIPTION_SIGNING_KEY | Independent persistent random secret, at least 32 characters. |
| JWT_PRIVATE_KEY_BASE64, JWT_PUBLIC_KEY_BASE64 | Matching RSA PEM keypair encoded as single-line base64. Keep identical across restarts. Workers receive public keys only. |
| UPI_WEBHOOK_SECRET or RAZORPAY_WEBHOOK_SECRET | A private test webhook secret is required by production-mode startup even if testing payment at reception only. |
| STAGING_BACKEND_IMAGE, STAGING_FRONTEND_IMAGE | Unique release tags containing the relevant committed revisions; never overwrite a prior release tag. |
| COOKIE_DOMAIN, COOKIE_SAME_SITE | Leave domain blank and use lax. Production mode supplies Secure; access/refresh tokens remain HttpOnly. |
| CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME | Separate private staging bucket/credentials before branding or document-upload testing. No public document bucket/domain. Configure bucket CORS only for the staging origin if signed browser uploads are tested. |
| SMTP_* | Test inbox/provider before claiming email/OTP/reset/notification delivery. Root TOTP and OTP-free guest booking do not prove email delivery. |
| RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET | Test-mode account and webhook configuration before online-payment verification. No live-payment credentials. |
| GEMINI_API_KEY, META_WHATSAPP_* | Optional for Phase 1; leave blank until the associated integration is deliberately configured for testing. |

Store keys privately outside Git and back them up securely. Never rotate encryption/signing keys just to redeploy. Secret files and nested key files are excluded from build contexts; the new .env.staging/.env.bootstrap files are Git-ignored. Docker administrators can inspect container environments, so restrict VM/Docker administrative access. Do not print resolved Compose configuration or share logs containing connection details.

Example key generation in a **private directory outside both repositories**, once for a fresh installation:
~~~sh
umask 077
mkdir -p "$HOME/.config/ekavyu-staging-keys"
cd "$HOME/.config/ekavyu-staging-keys"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
base64 -w 0 jwt-private.pem > jwt-private.base64
base64 -w 0 jwt-public.pem > jwt-public.base64
openssl rand -hex 32 > data-encryption.key
openssl rand -hex 32 > prescription-signing.key
openssl rand -hex 24 > redis-password.key
openssl rand -hex 32 > test-webhook.key
openssl rand -hex 24 > initial-root-password.key
~~~
Transfer values privately into the staging/bootstrap files; do not paste secrets into chat, tickets or commands that retain them in shell history.

## Operator steps, only after explicit staging deployment approval

These are exact setup instructions, **not commands already executed on a server**.

1. Provision the VM with SSH-key access, restrict SSH to operator IPs, and permit public 80/443 using the provider firewall. Keep all other application/database ports private. Install Docker Engine plus Buildx/Compose using the official [Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) or [Debian instructions](https://docs.docker.com/engine/install/debian/). Docker-published ports can bypass UFW; the manifests expose only Caddy. Enable time synchronization for root TOTP and install git/openssl/CA certificates.
2. Create the staging replica set/Atlas database user and VM-IP allowlist. Keep TLS certificate validation enabled. Select a nearby region. Test credentials only from the authorized host; the real connection has not been verified locally.
3. Clone approved **committed** backend and frontend revisions as siblings, for example /srv/ekavyu/backend and /srv/ekavyu/frontend. Obtain passing existing CI for both exact revisions. CI builds are verification artifacts with placeholder origins; no automatic deployment workflow is configured. Do not deploy the earlier local example.test build. Do not push release tags as a deployment shortcut: backend tag CI publishes a GitHub release.
4. From backend/deploy, prepare the private files:
~~~sh
umask 077
cp .env.staging.example .env.staging
cp .env.bootstrap.example .env.bootstrap
chmod 600 .env.staging .env.bootstrap
~~~
Fill all required blanks privately. In .env.bootstrap set the initial ROOT_ADMIN_EMAIL and a unique ROOT_ADMIN_PASSWORD of at least 16 characters. Keep STAGING_PROVISION_CONFIRM=ekavyu_dev. This file is only for one-time operator work and is never injected into the normal API/worker services. Record both revision hashes and set their unique image tags in .env.staging.

5. Define the staging Compose command and validate/build. This does not start the application:
~~~sh
dc() {
  sudo docker compose --env-file .env.staging \
    -f docker-compose.production.yml -f docker-compose.staging.yml "$@"
}
dc config --quiet
dc build backend frontend
BACKEND_REV=$(git -C .. rev-parse --short HEAD)
OPS_IMAGE="ekavyu-staging-ops:$BACKEND_REV"
sudo docker build --target builder -t "$OPS_IMAGE" ..
~~~
The extra operator image uses the existing backend builder/source/dependencies for manual provisioning and index/MFA utilities. It is not a running service and is not used as the application runner. Build caches reuse common layers. Keep it private because it contains source; environment files are excluded. Confirm the intended Caddy configuration using:
~~~sh
dc run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
~~~
This validates Caddy on the host without starting its public server.

6. **Fresh empty staging DB only, before starting the API:** preview, then manually authorize the one-time account write. Existing seedRoot.ts remains local-development-only and was not loosened:
~~~sh
sudo docker run --rm --env-file .env.staging --env-file .env.bootstrap \
  "$OPS_IMAGE" node deploy/provision-staging-root.mjs
sudo docker run --rm --env-file .env.staging --env-file .env.bootstrap \
  "$OPS_IMAGE" node deploy/provision-staging-root.mjs --apply
~~~
The preview makes no database connection. Apply requires the exact dev.ekavyu.com origin, ekavyu_dev database, production mode, explicit confirmation, a replica-set server and an empty database. It creates only one password-hashed root account. It refuses existing records, resets and apex/production provisioning. Stop if the database is already populated; recover/check the existing root rather than reseeding it.

Enroll MFA using the existing utility, with enrollment material stored privately rather than logged:
~~~sh
ENROLL_DIR=$(mktemp -d)
chmod 700 "$ENROLL_DIR"
sudo docker run --rm --env-file .env.staging --env-file .env.bootstrap \
  --mount "type=bind,src=$ENROLL_DIR,dst=/enrollment" \
  "$OPS_IMAGE" node --experimental-strip-types scripts/setupRoot2FA.ts
sudo chown "$(id -u):$(id -g)" "$ENROLL_DIR/root.png"
~~~
Scan the QR through a private operator channel and delete the enrollment PNG/directory after scanning. ROOT_2FA_CONFIRM=RESET is intentionally required by the existing MFA utility in production mode: execute it only for this freshly created account; do not rerun it to troubleshoot login. Then run the read-only verification:
~~~sh
sudo docker run --rm --env-file .env.staging --env-file .env.bootstrap \
  "$OPS_IMAGE" node --experimental-strip-types scripts/checkRoot2FA.ts
~~~
Remove the one-time password and reset confirmation from .env.bootstrap after enrollment; retain only the chosen email if needed for future read-only checks.

Prepare current schema indexes while the application is still stopped. The preview prints schema definitions without connecting; apply creates current indexes without dropping existing indexes or records:
~~~sh
sudo docker run --rm --env-file .env.staging \
  "$OPS_IMAGE" node --experimental-strip-types scripts/prepare-database-indexes.ts
sudo docker run --rm --env-file .env.staging \
  "$OPS_IMAGE" node --experimental-strip-types scripts/prepare-database-indexes.ts --apply --writes-paused
~~~
These are deliberate staging DB writes requiring operator authorization; none were performed against a remote database here.

7. Set only the **dev** DNS A record to the VM's public IPv4; set AAAA only if IPv6 is configured/reachable. Leave apex and www marketing records unchanged. Initially use DNS-only routing if an existing CDN proxy would complicate certificate issuance. Caddy needs reachable 80/443 and persistent /data for automatic certificate issuance/renewal. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https).
8. Start the prepared images and wait for health:
~~~sh
dc up -d --no-build --pull never --wait --wait-timeout 180
dc ps
curl --fail --silent --show-error https://dev.ekavyu.com/api/health/liveness
curl --fail --silent --show-error https://dev.ekavyu.com/api/health/readiness
curl --head https://dev.ekavyu.com/
~~~
Readiness must report success after Mongo/Redis/bootstrap checks; all four workers must be healthy. Root login must require TOTP. Create staging subscription plans through the existing root dashboard, then a synthetic clinic/doctor/schedule; do not import real patient records for public testing. Confirm the noindex header, HTTPS redirect, correct canonical/social origin, resource loading, host-only Secure cookies, session refresh/logout and guest confirmation. Finish the signed-out facility/doctor journeys, payment at reception and test-gateway payment if enabled, including full/disabled/unpublished/expired states. Keep dev links out of real Google Business Profiles.
9. Check R2 branding and private-document access separately, verify email/OTP delivery only with configured test credentials, and inspect resource use/latency/429s. No container startup, remote Mongo connection, certificate issuance or deployed smoke has been certified by local preparation.

## Updates and rollback

Before changing anything, retain the current backend/frontend image tags or image IDs, revision pair, Caddy/Compose files and a protected .env.staging.previous snapshot. Keep previous images locally or export them privately; do not prune them or delete volumes. Back up/export meaningful staging DB data privately and verify restore into an isolated database if it matters.

Build new unique tags, validate configuration, then use the same dc up command. Compose restarts services in place; brief downtime is expected, and rollback is manual. No automatic migration, reset or destructive schema operation is part of deployment.

If a release fails, restore the previous revision pair/configuration and protected environment file, then run dc up -d --no-build --pull never --wait --wait-timeout 180 against the retained old image tags. Recheck API and all worker health plus login/guest booking. Do not use down -v, volume pruning, database restore over the active database, or seed/reset commands as rollback. If a later release changes data semantics, evaluate compatibility before rolling code back; this preparation introduces no schema change.

## Later move to ekavyu.com

This is a separate approved release, not a rename of the existing staging environment.

1. Decide the production database/bucket/backup plan and synthetic-data disposition. Prefer isolated production data/secrets. Do not copy staging test patients into production. If explicitly retaining an existing real installation, keep its database, URL slugs, encryption/signing keys and bookings unchanged. The staging-only root provisioning tool refuses the apex; fresh production account provisioning needs an explicit operator plan.
2. Use production Compose alone with a private .env.production, production-specific image tags, Caddyfile and production volumes. Set APP_URL, FRONTEND_URL, PUBLIC_API_BASE_URL, CORS_ALLOWED_ORIGINS and WEBAUTHN_ORIGIN to https://ekavyu.com; NEXT_PUBLIC_API_URL to https://ekavyu.com/api; CADDY_SITE_ADDRESS/WEBAUTHN_RP_ID to ekavyu.com; host-only cookies and COOKIE_SAME_SITE=lax. Keep the direct backend:5000 target at build/runtime.
3. Rebuild the frontend image for the apex and validate it before switching DNS; changing runtime environment cannot repair compiled browser URLs or static metadata. Retain dev as isolated noindex staging on another host if needed. Production and staging cannot both claim the same host's 80/443 through separate Caddy containers without an explicit routing change.
4. Record previous marketing DNS/hosting and TTLs. After approval, remove the existing apex mapping from marketing hosting and point the apex to the application host; configure www redirects intentionally. Preserve the marketing repository/hosting for restoration or an agreed marketing subdomain.
5. Verify TLS, root/staff/guest login and cookies, newly enrolled apex passkeys, booking/payment, canonical/sitemap/robots and public 200/404/5xx behavior. Remove staging noindex by using production Caddyfile; private operational pages retain their app noindex. Check payment/email/webhook domains and Google appointment URLs before submitting the apex to Search Console.
6. Retain the previous app images and DNS/marketing configuration for rollback. Rolling DNS back does not roll back bookings or database writes; preserve data and plan that boundary before cutover.

## Local evidence and readiness

**PASS:** merged staging/production Compose using synthetic values; separate project/network/volumes; correct Caddy mount replacement; only edge ports published; build/runtime APP_URL and direct API target match; API/all worker configuration validators; host-only Secure/Lax cookie helper; secret/template ignore checks; bounded container logs; frontend rewrite evaluation; backend TypeScript and JS syntax/diff checks; 11 focused first-account provisioning tests using a temporary replica set (including hashed creation, safe preview, bad targets and nonempty-DB refusal).

No full suite or large build was repeated. The earlier 104 focused tests and production HTTP/browser verification remain recorded in [release verification](../../frontend/docs/discovery-release-verification.md), but they do not certify these new deployment files on a server.

**PENDING:** VM/Atlas/bucket creation, DNS and secrets, passing CI for committed release revisions, Caddy parser/container-image validation on a Docker host, encrypted MFA enrollment, real database connectivity, all container readiness, deployed phone/cookie/payment/notification checks and explicit deployment approval. Docker daemon is unavailable locally. No credentials or provider account access were requested.

Evidence: %TEMP%\ekavyu-staging-preparation-20261008 contains synthetic configuration assertions and bootstrap test reports. No real URI or production secret was read.
