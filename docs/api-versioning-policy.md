# ANANTA API Versioning & Compatibility Policy

## 1. Stable Compatibility Contract (`/api/v1`)
`/api/v1` represents the stable, production-grade compatibility contract for all supported mobile clients, portal frontends, and external third-party integrations (e.g. ABDM, insurance TPAs, lab aggregators).

### Core Invariants:
1. **Additive Changes Only**: Within a major API version (`/api/v1`), changes must be strictly backward-compatible and additive:
   - New fields may be added to response payloads.
   - Optional fields may be accepted in request bodies.
   - Existing fields must NEVER be removed, renamed, or have their types altered.
2. **Semantic URL Prefixing**: Clients must explicitly target `/api/v1/...` for long-term compatibility. The root `/api/...` routes default to the active canonical version.
3. **Deprecation Standard (RFC 8594)**:
   - When an endpoint or field is deprecated, the server emits:
     - `Deprecation: @<timestamp>` or `Deprecation: true`
     - `Sunset: <HTTP-date>` (minimum 180-day grace period for clinical endpoints)
     - `Link: </api/v2/...>; rel="successor-version"`
   - Telemetry automatically logs caller user-agent and IP to track migration progress before decommissioning.

## 2. Supported Baseline Contracts
Refer to `backend/tests/fixtures/apiContractFixtures.ts` for the immutable JSON schema baselines of:
- `POST /api/v1/auth/login`
- `GET /api/v1/appointments/:id`
- `GET /api/v1/encounters/:encounterId`
- `GET /api/v1/invoices/:id`
