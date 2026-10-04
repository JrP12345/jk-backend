import { describe, expect, it } from "vitest";
import { escapeHtml, normalizeManualNotificationActionUrl } from "../utilities/manualNotificationContent.ts";

describe("manual notification content boundary", () => {
  it("encodes HTML content before it is used in an email template", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("keeps manual notification actions on trusted application paths", () => {
    expect(normalizeManualNotificationActionUrl("/dashboard/billing?tab=refunds#pending")).toBe("/dashboard/billing?tab=refunds#pending");
    expect(normalizeManualNotificationActionUrl("/track/appointment?token=synthetic")).toBe("/track/appointment?token=synthetic");
    expect(normalizeManualNotificationActionUrl("https://attacker.invalid/login")).toBeNull();
    expect(normalizeManualNotificationActionUrl("//attacker.invalid/login")).toBeNull();
    expect(normalizeManualNotificationActionUrl("javascript:alert(1)")).toBeNull();
  });
});
