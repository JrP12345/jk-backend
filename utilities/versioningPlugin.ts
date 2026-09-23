import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    apiVersion?: string;
  }
}

export interface DeprecationOptions {
  sunsetDate?: string; // e.g. "Wed, 01 Jan 2027 00:00:00 GMT"
  successor?: string;  // e.g. "/api/v2/appointments"
  note?: string;
}

/**
 * Emits RFC 8594 standard deprecation headers on a Fastify response.
 */
export function markDeprecated(reply: FastifyReply, options: DeprecationOptions = {}): void {
  reply.header("Deprecation", "true");
  if (options.sunsetDate) {
    reply.header("Sunset", options.sunsetDate);
  }
  if (options.successor) {
    reply.header("Link", `<${options.successor}>; rel="successor-version"`);
  }
  if (options.note) {
    reply.header("X-Deprecation-Notice", options.note);
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
      req.raw.url = rawUrl.replace("/api/v1/", "/api/");
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
