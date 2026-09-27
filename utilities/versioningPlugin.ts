import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    apiVersion?: string;
  }
}

/**
 * API Versioning Plugin.
 * Establishes /api/v1 as a stable, auditable compatibility contract.
 * Attaches version headers and identifies incoming contract versions.
 */
async function versioningPlugin(app: FastifyInstance) {
  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    const rawUrl = req.raw.url || "";
    
    // Detect explicit API version prefix
    if (rawUrl.startsWith("/api/v1/")) {
      req.apiVersion = "v1";
    } else if (rawUrl.startsWith("/api/")) {
      req.apiVersion = "v1"; // default canonical version
    }

    reply.header("X-API-Version", req.apiVersion || "v1");
    done();
  });
}

export const apiV1VersioningPlugin = fp(versioningPlugin, {
  name: "api-v1-versioning-plugin",
  fastify: "5.x",
});

export default apiV1VersioningPlugin;
