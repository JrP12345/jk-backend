import { markBootstrapComplete } from "../utilities/readiness.ts";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../index.ts";

describe("Milestone 9: Infrastructure & DevOps Hardening Tests", () => {
  beforeAll(async () => { await app.ready(); markBootstrapComplete(); });
  it("should respond cleanly to SRE health probe endpoints", async () => {
    // Liveness Probe
    const liveRes = await app.inject({
      method: "GET",
      url: "/api/health/liveness",
    });
    expect(liveRes.statusCode).toBe(200);
    expect(JSON.parse(liveRes.body).status).toBe("ok");

    // Readiness Probe
    const readyRes = await app.inject({
      method: "GET",
      url: "/api/health/readiness",
    });
    expect(readyRes.statusCode).toBe(200);
    const readyBody = JSON.parse(readyRes.body);
    expect(readyBody.status).toBe("ready");
    expect(readyBody.database.status).toBe("connected");

    // General Health
    const healthRes = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(healthRes.statusCode).toBe(200);
    expect(JSON.parse(healthRes.body).status).toBe("ok");
  });

});
