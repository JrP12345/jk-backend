import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/**
 * API v1 Versioning Plugin.
 * Mounts all core API domain routes under /api/v1 prefix for API contract versioning.
 * Uses fastify-plugin to break encapsulation so the hook applies application-wide.
 */
async function versioningPlugin(app: FastifyInstance) {
  // Rewrite /api/v1/* requests to /api/* for backward compatibility & version transparency
  app.addHook("onRequest", (req, reply, done) => {
    if (req.raw.url && req.raw.url.startsWith("/api/v1/")) {
      req.raw.url = req.raw.url.replace("/api/v1/", "/api/");
    }
    done();
  });
}

export const apiV1VersioningPlugin = fp(versioningPlugin, {
  name: "api-v1-versioning-plugin",
  fastify: "5.x",
});
export default apiV1VersioningPlugin;
