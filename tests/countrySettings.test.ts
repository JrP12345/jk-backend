import { describe, expect, it } from "vitest";
import { validateCountrySettings } from "../utilities/countrySettings.ts";
import { normalizePhone } from "../utilities/helpers.ts";
import { WhatsAppCloudApiService } from "../services/WhatsAppCloudApiService.ts";
import { locationClockMinutes, locationDateKey, locationDayRange, locationLocalTimeToDate } from "../utilities/locationTime.ts";

describe("country settings", () => {
  it("requires a timezone for countries spanning multiple zones", () => {
    expect(validateCountrySettings("US", "USD", undefined)).toMatch(/timezone/);
    expect(validateCountrySettings("CA", "CAD", "America/Toronto")).toBeNull();
    expect(validateCountrySettings("GB", "GBP", undefined)).toBeNull();
    expect(validateCountrySettings("AE", "INR", "Asia/Dubai")).toMatch(/AED/);
  });

  it("keeps Indian legacy phone identity and preserves explicit foreign numbers", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("9876543210");
    expect(normalizePhone("9876543210")).toBe("9876543210");
    expect(normalizePhone("+1 (415) 555-0199")).toBe("+14155550199");
    expect(normalizePhone("+44 20 7946 0123")).toBe("+442079460123");
    expect(normalizePhone("+44 12345678")).toBe("+4412345678");
    const provider = new WhatsAppCloudApiService();
    expect(provider.formatPhoneNumber("+44 12345678")).toBe("4412345678");
    expect(provider.formatPhoneNumber("9876543210")).toBe("919876543210");
  });
});

describe("clinic timezone", () => {
  it("uses the clinic's day and clock for booking", () => {
    const instant = new Date("2026-09-29T00:30:00Z");
    expect(locationDateKey(instant, "America/Los_Angeles")).toBe("2026-09-28");
    expect(locationClockMinutes(instant, "America/Los_Angeles")).toBe(17 * 60 + 30);
    expect(locationLocalTimeToDate("2026-01-15", "09:00", "America/New_York").toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(locationLocalTimeToDate("2026-07-15", "09:00", "America/New_York").toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("keeps a daylight-saving day to its actual local duration", () => {
    const range = locationDayRange("2026-03-08", "America/New_York");
    expect(range.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-09T03:59:59.999Z");
    const autumnRange = locationDayRange("2026-11-01", "America/New_York");
    expect(autumnRange.end.getTime() - autumnRange.start.getTime() + 1).toBe(25 * 60 * 60 * 1000);
  });

  it("rejects impossible dates and skipped daylight-saving times", () => {
    for (const [date, time] of [["2026-02-30", "09:00"], ["2026-09-29", "24:00"], ["2026-09-29", "09:60"], ["2026-03-08", "02:30"]]) {
      expect(() => locationLocalTimeToDate(date, time, "America/New_York")).toThrow();
    }
  });

  it("converts slots for all five supported country contexts", () => {
    expect(locationLocalTimeToDate("2026-01-15", "09:00", "Asia/Kolkata").toISOString()).toBe("2026-01-15T03:30:00.000Z");
    expect(locationLocalTimeToDate("2026-01-15", "09:00", "America/Toronto").toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(locationLocalTimeToDate("2026-01-15", "09:00", "Europe/London").toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(locationLocalTimeToDate("2026-07-15", "09:00", "Europe/London").toISOString()).toBe("2026-07-15T08:00:00.000Z");
    expect(locationLocalTimeToDate("2026-01-15", "09:00", "Asia/Dubai").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
});
