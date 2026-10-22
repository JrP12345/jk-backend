# Verification for coding agents

## Project stage

This entire project is in development, with no production customers or legacy production data (user clarification, 20 October 2026). Skip migration/backfill and compatibility layers solely for hypothetical legacy deployments. Use current intended contracts while preserving and verifying current clinical, financial, security and inventory flows when shared code changes. Synthetic fixtures are development coverage, not legacy production obligations.

Classify the highest risk of the change before running checks. Use the smallest meaningful validation set, then broaden only for a real dependency or failure. Never run every script merely to prove work was done. The frontend sibling repository has a detailed `docs/verification-workflow.md`; the rules here stand alone when this repository is checked out separately.

- Level 1 (docs or isolated nonfunctional change): inspect the diff; no database suite or build by default.
- Level 2 (local behavior): run the affected test file with `npm test -- tests/name.test.ts`. Add `npm run check:fast` if TypeScript contracts changed.
- Level 3 (shared service, utility, API infrastructure, worker): test direct consumers and relevant regression files; run `npm run check:fast`; build if bundling or worker entry points changed.
- Level 4 (auth, permissions, tenant isolation, booking, billing, payments, inventory, patient data, DB writes/migrations, concurrency): test the relevant integration and edge cases, related flows, and run TypeScript and build checks as appropriate. Keep real tenant and persistence boundaries covered.
- Level 5 (release/production): retain the complete CI and release gates, including the serial Mongo-backed suite and architecture auditor.

`vitest.config.ts` makes test files serial, and `tests/setup.ts` starts a MongoDB memory server for each test file. Avoid the full suite during ordinary edits. Never run a migration, seed, backup/restore drill, production MFA setup, or live replay as a verification shortcut. `npm run audit:release` runs TypeScript plus the entire suite and writes release artifacts; reserve it for the release gate. Do not repeat a passing check against unchanged code. If a check fails, fix and rerun the affected check first. Run frontend checks only if its code or a cross-repository contract changed.
