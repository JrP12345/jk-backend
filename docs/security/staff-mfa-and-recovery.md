# Staff security rollout and recovery

Production staff use the existing TOTP authenticator challenge. After primary sign-in,
unenrolled staff can only inspect their session, enroll, or sign out. HTTP APIs and
private WebSockets enforce the policy from the live session/user record. Patient and
family policies remain unchanged; platform root retains its stricter existing policy.

For an existing clinic rollout, communicate an explicit UTC `STAFF_MFA_ENFORCE_AFTER`
date before deployment and have staff enroll under Account → Security during that
grace period. Blank means immediate enforcement. Test an administrator, doctor,
receptionist and nurse before the deadline. Enrollment requires primary authentication
within ten minutes, stores the pending secret encrypted and binds it to that session.
It revokes old sessions after a valid code, then starts a fresh authenticated session.
Legacy sessions without a recorded credential time require a fresh sign-in before
enrollment. Token refresh and workspace switching preserve the original proof time;
neither is treated as a fresh primary authentication event.
Never distribute screenshots of enrollment QR codes or write them into support tickets.

Legacy location grants now derive only active, tenant-owned doctor/receptionist
assignments. Other staff without an explicit grant receive no branch access.
Before rollout, administrators must review existing staff through the location-access
editor (`PATCH /api/organizations/:id/members/:userId/location-access`). Use selected
owned locations or a deliberately reviewed all-location grant. No automatic database
rewrite or cross-tenant default is performed. Administrators retain organization scope.

## Lost authenticator

There is no HTTP recovery bypass and no implied recovery codes. A privileged operator
must verify the staff identity through an independent clinic contact, obtain an
independent active MFA-enabled platform-root reviewer, and record the support case.
Do not accept an unauthenticated email or an existing browser session as proof alone.

The operator-only script defaults to preview:

```sh
node --env-file=.env scripts/recover-staff-mfa.ts --user-id STAFF_ID --reviewed-by ROOT_ID
```

Only after authorized identity review, repeat with `--apply --identity-verified
--expected-auth-version VERSION_FROM_PREVIEW`. It uses a transaction and version check,
clears the old authenticator, revokes sessions/sockets and records an audit event.
It issues no credential and does not exempt enrollment. The staff member must sign in
with their primary credential and enroll again before accessing clinical operations.
The operator flag asserts completed human review; database/script access itself must
be restricted. Do not run against production as a development check.

Root recovery uses the separately controlled existing `setup:root-2fa:production`
procedure, with `ROOT_2FA_CONFIRM=RESET` and a private QR artifact; reset also revokes
existing sessions. Protect and delete enrollment artifacts after secure handoff.

## Transport and secrets

Production startup rejects non-HTTPS/wildcard CORS origins, invalid cookie settings,
unbounded/invalid proxy hops or CIDRs and invalid rollout dates. Production trusts no
proxy by default. The supplied Compose topology explicitly trusts one directly
connected Caddy hop and exposes only Caddy ports. For another topology, configure its
verified hop count **or** trusted CIDRs and firewall direct backend access. An origin
shield requires a random `ORIGIN_VERIFY_TOKEN` of at least 32 characters, set/overwritten
by the trusted proxy; never forward a client-supplied token unchanged.

Verify real HTTPS redirects/certificates, exact browser CORS/CSRF origins, Secure and
HttpOnly cookies, host-only cookie scope where possible, WebSocket origins, and proxy
client-IP/rate-limit behavior on staging. These cannot be proved by local code tests.
Keep persistent encryption, signing, JWT and backup keys in restricted deployment
secrets; do not rotate field/signing keys without preserving access to historical data.

## Recovery gates

Provider snapshots/PITR are the primary online database backup. The logical archive
script is supplementary, bounded, AES-GCM authenticated and requires a coordinated
write pause. New archives require a dedicated key of at least 32 random characters.
Restore accepts existing authenticated v1 archives and bounds decompression. Restrict
backup-directory ACLs (POSIX modes do not enforce Windows ACLs), use a private bucket
with retention and deletion protection, and escrow keys independently of the server.

Before release, perform an authorized isolated restore of an actual snapshot, restore
indexes and required keys, and verify application reads and cross-module workflows.
The repository archive drill alone does **not** prove application recovery. Record RPO,
RTO, operator, archive identity, tenant isolation and cleanup evidence. Neither a live
backup nor a restore has been performed by this implementation task.
