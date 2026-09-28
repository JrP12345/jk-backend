# Ekavyu backend

Fastify API for Ekavyu: booking, queues, encounters, clinical records, laboratory,
prescriptions, billing and notifications. This repository builds independently
of the frontend checkout. ABDM sandbox support does not imply live approval.

Use Node.js 24. Run `npm ci`, copy `.env.example` to `.env`, configure MongoDB and
the required environment, then run `npm run dev`. The default port is 5000.

Checks: `npm run check:fast`, `npm test`, `npm run build`, `npm run check:startup`.
`npm run check:build-install` verifies that installation skips the test-only
MongoDB download while integration tests retain their runtime download support.
`npm run audit:release` checks this backend repository and records its manifest
and history locally; the frontend runs its own tests and payment-boundary check.

Render build: `npm ci --include=dev && npm run build`. Start: `npm start`.
The standalone repository uses an empty Render root directory.

- [Deployment](DEPLOYMENT.md)
- [Production validation](docs/production-readiness-tracker.md)
- [Backup and recovery](DISASTER_RECOVERY.md)
- [WhatsApp setup](docs/whatsapp-setup.md)
- [Optional combined Docker deployment](deploy/README.md)
- [Frontend repository](https://github.com/JrP12345/jk-frontend)

## Local verification

Choose checks by change risk as described in [AGENTS.md](AGENTS.md). Run affected
Vitest files with `npm test -- tests/name.test.ts` during development; the full
Mongo-backed suite and release auditor remain CI/release gates.
