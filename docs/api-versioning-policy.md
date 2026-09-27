# API versioning

Register routes under /api/.... index.ts rewrites /api/v1/... to /api/... before
Fastify routes the request. Both paths therefore use the same handlers and access
controls. Do not register a second /api/v1 route or rewrite URLs in hooks.

The versioning plugin attaches X-API-Version: v1. The alias is not a separate
versioned implementation. Existing contract fixtures test selected endpoints,
not every route or response field. New breaking versions require explicit routing,
contract tests and an announced migration policy.

