import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyEnv } from "../utilities/config.ts";

describe("Production Environment Configuration Guards", () => {
  const originalEnv = { ...process.env };
  let exitSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("fails verifyEnv in production if MONGODB_URI is a standalone instance", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://localhost:27017/ananta_prod";
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.ananta.health";
    process.env.JWT_PRIVATE_KEY_BASE64 = "dGVzdC1wcml2YXRl";
    process.env.JWT_PUBLIC_KEY_BASE64 = "dGVzdC1wdWJsaWM=";
    process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION = "true";
    process.env.UPI_WEBHOOK_SECRET = "test-secret";
    delete process.env.ALLOW_STANDALONE_IN_PRODUCTION;

    verifyEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedErrors = errorSpy.mock.calls.flat().join(" ");
    expect(loggedErrors).toContain("MONGODB_URI must specify a Replica Set");
  });

  it("passes verifyEnv in production when MONGODB_URI is mongodb+srv or has replicaSet", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb+srv://user:pass@cluster0.mongodb.net/ananta_prod?retryWrites=true&w=majority";
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.ananta.health";
    process.env.JWT_PRIVATE_KEY_BASE64 = "dGVzdC1wcml2YXRl";
    process.env.JWT_PUBLIC_KEY_BASE64 = "dGVzdC1wdWJsaWM=";
    process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION = "true";
    process.env.UPI_WEBHOOK_SECRET = "test-secret";

    verifyEnv();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("fails verifyEnv in production if payment webhook secret is missing", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://host1:27017,host2:27017/ananta_prod?replicaSet=rs0";
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.ananta.health";
    process.env.JWT_PRIVATE_KEY_BASE64 = "dGVzdC1wcml2YXRl";
    process.env.JWT_PUBLIC_KEY_BASE64 = "dGVzdC1wdWJsaWM=";
    process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION = "true";
    delete process.env.UPI_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;

    verifyEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedErrors = errorSpy.mock.calls.flat().join(" ");
    expect(loggedErrors).toContain("UPI_WEBHOOK_SECRET or RAZORPAY_WEBHOOK_SECRET");
  });
});
