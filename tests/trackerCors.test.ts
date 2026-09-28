import { expect, it } from "vitest";
import app from "../index.ts";

it("allows the private tracker headers from the configured frontend origin", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/public/track/example",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-tracker-token,if-none-match",
    },
  });

  expect(response.statusCode).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  const allowedHeaders = String(response.headers["access-control-allow-headers"] || "").toLowerCase();
  expect(allowedHeaders).toContain("x-tracker-token");
  expect(allowedHeaders).toContain("if-none-match");
});

it("does not grant tracker access to an untrusted origin", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/public/track/example",
    headers: {
      origin: "https://untrusted.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-tracker-token",
    },
  });

  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
});
