# Current API contract

All first-party clients use `/api/...`. There is one route representation and no internal version-prefix rewrite or version response header. External provider URLs retain the versions required by those providers.

OpenAPI is available at `/documentation/json`; `/documentation` serves its UI. Contract fixtures and integration tests cover authentication, authorization and selected response shapes. Add focused contract tests whenever a request or response changes.
