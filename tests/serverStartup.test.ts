import net from "node:net";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterAll, describe, expect, it, vi } from "vitest";
import app, { startServer } from "../index.ts";
import * as onboarding from "../controllers/onboarding.ts";
import { getServerPort } from "../utilities/serverPort.ts";

afterAll(async () => { await app.close(); vi.restoreAllMocks(); });

describe("API startup and port ownership", () => {
  it("honors a hosting provider port and rejects invalid values", () => {
    expect(getServerPort("")).toBe(5000);
    expect(getServerPort("10000")).toBe(10000);
    for (const value of ["0", "-1", "65536", "5000oops", "3.5"]) {
      expect(() => getServerPort(value)).toThrow("PORT must be an integer");
    }
  });

  it("reports production configuration failures before loading the database", () => {
    const child = spawnSync(process.execPath, ["utilities/startupEnvironment.ts"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Fatal Configuration Error");
    expect(child.stderr).toContain("MONGODB_URI");
    expect(child.stderr).not.toContain("MongoDB connection error");
  });

  it("rejects an occupied port before any bootstrap writes", async () => {
    const occupied = net.createServer();
    occupied.listen(0, "0.0.0.0");
    await once(occupied, "listening");
    const seed = vi.spyOn(onboarding, "seedDefaultRoles");
    try {
      const port = (occupied.address() as net.AddressInfo).port;
      await expect(startServer(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(seed).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
      seed.mockRestore();
    }
  });

  it("serves probes while bootstrap runs and keeps application traffic gated", async () => {
    let finishBootstrap!: () => void;
    const bootstrap = new Promise<void>(resolve => { finishBootstrap = resolve; });
    const seed = vi.spyOn(onboarding, "seedDefaultRoles").mockImplementation(() => bootstrap);
    const quotas = vi.spyOn(onboarding, "syncOrganizationPlanQuotas").mockResolvedValue(undefined);
    const listening = once(app.server, "listening");
    const starting = startServer(0);
    try {
      await listening;
      await vi.waitFor(() => expect(seed).toHaveBeenCalledOnce());
      const port = (app.server.address() as net.AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      const live = await fetch(`${origin}/api/health/liveness`);
      expect(live.status).toBe(200);
      const ready = await fetch(`${origin}/api/health/readiness`);
      expect(ready.status).toBe(503);
      expect((await ready.json()).bootstrap.complete).toBe(false);
      const application = await fetch(`${origin}/api/patients`);
      expect(application.status).toBe(503);
      expect(application.headers.get("retry-after")).toBe("2");
      finishBootstrap();
      await starting;
      const recovered = await fetch(`${origin}/api/health/readiness`);
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).bootstrap.complete).toBe(true);
    } finally {
      finishBootstrap();
      await starting.catch(() => {});
      seed.mockRestore();
      quotas.mockRestore();
    }
  });
});
