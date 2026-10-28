# Dependencies and licenses

Direct npm dependencies reviewed on 2026-10-24 against source, scripts,
configuration, installed licenses and lockfiles. Update this inventory with the
manifest. All listed packages are open-source and require no commercial software
license for normal use. Provider charges and server licenses are separate.

No direct package was confirmed unused. Type packages, configured plugins and
mandatory tool peers remain required without a runtime import. No dependency
versions were upgraded during cleanup.

## Production dependencies

| Package | Locked version | License | Required use |
| --- | --- | --- | --- |
| `@aws-sdk/client-s3` | 3.1152.0 | Apache-2.0 | R2/S3 storage and backups |
| `@aws-sdk/s3-request-presigner` | 3.1152.0 | Apache-2.0 | Signed storage URLs |
| `@fastify/compress` | 9.2.2 | MIT | HTTP compression |
| `@fastify/cookie` | 11.1.3 | MIT | Session cookies |
| `@fastify/cors` | 11.3.1 | MIT | Browser origin policy |
| `@fastify/rate-limit` | 11.2.1 | MIT | Rate limits |
| `@fastify/swagger` | 9.9.2 | MIT | OpenAPI schemas |
| `@fastify/swagger-ui` | 6.1.2 | MIT | API documentation UI |
| `@fastify/websocket` | 11.3.4 | MIT | Queue/notification sockets |
| `@sentry/node` | 11.8.0 | MIT | Optional error telemetry |
| `@simplewebauthn/server` | 14.0.3 | MIT | Passkeys |
| `bcryptjs` | 3.0.3 | BSD-3-Clause | Password hashing |
| `fastify` | 5.12.7 | MIT | API/hooks |
| `fastify-plugin` | 6.0.1 | MIT | Fastify plugin metadata and encapsulation |
| `ioredis` | 6.0.0 | MIT | Shared cache/coordination/pubsub |
| `jsonwebtoken` | 9.0.3 | MIT | JWT/session signatures |
| `mongoose` | 9.11.2 | MIT | MongoDB models/transactions |
| `nodemailer` | 10.1.2 | MIT-0 | SMTP delivery |
| `qrcode` | 1.5.4 | MIT | MFA provisioning QR |
| `sharp` | 0.35.5 | Apache-2.0 | Decode and re-encode public organization/location branding; remove metadata without misclassifying raster files |
| `speakeasy` | 2.0.0 | MIT | TOTP/MFA |

## Development dependencies

| Package | Locked version | License | Required use |
| --- | --- | --- | --- |
| `@types/jsonwebtoken` | 9.0.10 | MIT | Types for jsonwebtoken APIs |
| `@types/node` | 26.6.5 | MIT | Types for node APIs |
| `@types/nodemailer` | 8.0.2 | MIT | Types for nodemailer APIs |
| `@types/qrcode` | 1.5.6 | MIT | Types for qrcode APIs |
| `@types/speakeasy` | 2.0.10 | MIT | Types for speakeasy APIs |
| `@types/ws` | 8.18.2 | MIT | Types for ws APIs |
| `esbuild` | 0.28.2 | MIT | API and four worker executables: five bundles |
| `mongodb-memory-server` | 11.3.0 | MIT | Disposable test and scale-measurement databases |
| `typescript` | 7.0.2 | Apache-2.0 | Type compiler |
| `vitest` | 5.0.5 | MIT | Test runner |

## Non-MIT dependencies and services

- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` → Apache-2.0 → storage/signing and backups → no replacement needed. [AWS SDK license](https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE).
- `bcryptjs` → BSD-3-Clause → existing password hashes → no replacement needed; algorithm changes require compatibility work. [bcrypt.js license](https://github.com/dcodeIO/bcrypt.js/blob/main/LICENSE).
- `nodemailer` → MIT-0 → SMTP → no replacement needed. MIT-0 is reported separately from MIT. [Nodemailer license](https://github.com/nodemailer/nodemailer/blob/master/LICENSE).
- `typescript` → Apache-2.0 → compiler tooling → no replacement needed. [TypeScript license](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt).
- `sharp` → Apache-2.0 → branding image validation and metadata removal. Its prebuilt libvips dependencies carry their own included license notices, including LGPL-3.0-or-later for libvips. Retain those notices. [Sharp license and installation](https://sharp.pixelplumbing.com/install/).

The branding correction adds Sharp as a production dependency. Deployment must
install platform-specific optional packages (`npm ci`, without `--omit=optional`),
including the matching native binaries for Alpine/Linux or Windows. This is a
backend runtime requirement; the frontend's development copy is not used.

R2/S3 and optional Sentry are intentional infrastructure whose provider plans may
incur charges; the open-source SDKs have no mandatory commercial package license.
Payments, WhatsApp, AI, SMTP, video/imaging, and MongoDB/Redis hosting have their
own provider/server terms. An MIT database client does not establish an MIT
license for the external database server. These integrations remain because
removal or replacement would change the application architecture and workflows.

The policy prefers MIT and accepts the recorded permissive exceptions; it is not
strictly MIT-only. Verify feature and stored-data compatibility before replacing
required packages. Use npm for dependency changes and retain license notices.

## Maintenance follow-up

`speakeasy` remains required by the current TOTP/MFA service, but its
[upstream repository](https://github.com/speakeasyjs/speakeasy) explicitly marks
it unmaintained. Its MIT license requires no commercial payment. Retain it in
this behavior-preserving cleanup; a replacement needs a separate authentication
compatibility pass covering existing base32 secrets, token windows, QR enrollment
and current encrypted credentials. No MFA dependency or algorithm was changed.
