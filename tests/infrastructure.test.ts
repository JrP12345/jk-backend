import { describe, it, expect } from "vitest";
import app from "../index.js";

describe("Milestone 9: Infrastructure & DevOps Hardening Tests", () => {
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
    expect(readyBody.database).toBe("connected");

    // General Health
    const healthRes = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(healthRes.statusCode).toBe(200);
    expect(JSON.parse(healthRes.body).status).toBe("ok");
  });

  it("should respond to versioned health probe endpoints under /api/v1/*", async () => {
    const v1HealthRes = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(v1HealthRes.statusCode).toBe(200);
    expect(JSON.parse(v1HealthRes.body).status).toBe("ok");

    const v1LiveRes = await app.inject({
      method: "GET",
      url: "/api/v1/health/liveness",
    });
    expect(v1LiveRes.statusCode).toBe(200);

    const v1ReadyRes = await app.inject({
      method: "GET",
      url: "/api/v1/health/readiness",
    });
    expect(v1ReadyRes.statusCode).toBe(200);
  });
});
