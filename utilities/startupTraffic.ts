import type { FastifyInstance } from "fastify";

const probePaths = new Set(["/api/health", "/api/health/liveness", "/api/health/readiness"]);

export function registerStartupTrafficGuard(app: FastifyInstance, isAcceptingTraffic: () => boolean) {
  // CORS runs in onRequest. Refuse application work afterward so browsers can
  // read the 503 and Retry-After without bypassing the configured Origin policy.
  app.addHook("preValidation", (request, reply, done) => {
    if (!isAcceptingTraffic() && !probePaths.has(request.url.split("?")[0])) {
      reply.header("Retry-After", "2").code(503).send({ success: false, message: "The service is starting or shutting down. Please try again shortly." });
      return;
    }
    done();
  });
}
