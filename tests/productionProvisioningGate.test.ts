import { afterEach, describe, expect, it } from "vitest";
import { createOrganization } from "../controllers/onboarding.ts";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;

});

describe("production organization provisioning gate", () => {
  it("rejects an unauthenticated caller even when it supplies the retired onboarding mode", async () => {
    process.env.NODE_ENV = "production";
    const reply = {
      statusCode: 0,
      body: undefined as unknown,
      code(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      send(body: unknown) {
        this.body = body;
        return body;
      },
    };

    await createOrganization(
      {
        headers: { "x-onboarding-mode": "new_org", "x-onboarding-secret": "retired-shared-secret" },
        cookies: {},
        body: {},
      } as any,
      reply as any,
    );

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { message?: string }).message).toContain("platform administrator");
  });
});
