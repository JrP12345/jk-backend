import type { FastifyInstance } from "fastify";

/**
 * API v1 Versioning Plugin.
 * Mounts all core API domain routes under /api/v1 prefix for API contract versioning.
 */
export async function apiV1VersioningPlugin(app: FastifyInstance) {
  // Rewrite /api/v1/* requests to /api/* for backward compatibility & version transparency
  app.addHook("onRequest", (req, reply, done) => {
    if (req.raw.url && req.raw.url.startsWith("/api/v1/")) {
      req.raw.url = req.raw.url.replace("/api/v1/", "/api/");
    }
    done();
  });
}
