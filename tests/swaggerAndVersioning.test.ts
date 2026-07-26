import { describe, it, expect } from "vitest";
import app from "../index.js";

describe("Milestone 4: API Versioning & OpenAPI Documentation Tests", () => {
  it("should serve OpenAPI 3.0 JSON specification at /documentation/json", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/documentation/json",
    });
    expect(res.statusCode).toBe(200);

    const spec = JSON.parse(res.body);
    expect(spec.openapi).toContain("3.");
    expect(spec.info.title).toContain("ANANTA Healthcare Infrastructure Platform API");
    expect(spec.info.version).toBe("1.0.0");
  });

  it("should serve interactive Swagger UI at /documentation", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/documentation",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("should resolve /api/v1/* versioned endpoint requests transparently", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
  });
});
