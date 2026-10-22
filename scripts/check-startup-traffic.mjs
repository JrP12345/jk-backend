import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { registerStartupTrafficGuard } from "../utilities/startupTraffic.ts";

export async function checkStartupTraffic() {
  const app = fastify();
  let accepting = false;
  let handled = 0;
  let upgraded = 0;
  const allowed = "https://startup-check.example.test";
  registerStartupTrafficGuard(app, () => accepting);
  app.register(cors, { origin: [allowed], credentials: true });
  app.register(websocket);
  app.register(async scope => {
    scope.get("/api/socket", { websocket: true }, socket => { upgraded++; socket.on("message", message => socket.send(message)); });
  });
  app.get("/api/private", () => { handled++; return { ok: true }; });
  for (const path of ["/api/health", "/api/health/liveness", "/api/health/readiness"]) {
    app.get(path, () => ({ probe: true }));
  }
  try {
    await app.ready();
    const blocked = await app.inject({ url: "/api/private", headers: { origin: allowed } });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.headers["access-control-allow-origin"], allowed);
    assert.equal(blocked.headers["access-control-allow-credentials"], "true");
    assert.equal(blocked.headers["retry-after"], "2");
    assert.deepEqual(blocked.json(), { success: false, message: "The service is starting or shutting down. Please try again shortly." });
    assert.equal(handled, 0);
    await assert.rejects(app.injectWS("/api/socket", { headers: { origin: allowed } }), /503/);
    assert.equal(upgraded, 0);
    const hostile = await app.inject({ url: "/api/private", headers: { origin: "https://hostile.example.test" } });
    assert.equal(hostile.statusCode, 503);
    assert.equal(hostile.headers["access-control-allow-origin"], undefined);
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/private", headers: { origin: allowed, "access-control-request-method": "GET" } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], allowed);
    for (const path of ["/api/health", "/api/health/liveness", "/api/health/readiness"]) {
      assert.equal((await app.inject(`${path}?check=1`)).statusCode, 200);
    }
    assert.equal((await app.inject("/api/health/other")).statusCode, 503);
    accepting = true;
    assert.equal((await app.inject({ url: "/api/private", headers: { origin: allowed } })).statusCode, 200);
    assert.equal(handled, 1);
    const socket = await app.injectWS("/api/socket", { headers: { origin: allowed } });
    assert.equal(upgraded, 1);
    socket.terminate();
    accepting = false;
    assert.equal((await app.inject("/api/private")).statusCode, 503);
    assert.equal(handled, 1);
    console.log("PASS: startup/shutdown refusal preserves CORS, strict origins, preflight and exact probe paths; HTTP and WebSocket work stays blocked until ready.");
  } finally { await app.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await checkStartupTraffic();
