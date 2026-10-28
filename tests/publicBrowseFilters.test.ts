import { describe, expect, it } from "vitest";
import { facilityHours, parseBrowseFilters } from "../utilities/publicBrowseFilters.ts";

describe("Public directory filter contracts", () => {
  it("accepts multiple literal specialties and antimeridian bounds", () => {
    expect(parseBrowseFilters({ specialization: ["Cardiology", "Dermatology", "Cardiology"], bounds: "-10,170,10,-170", openNow: "true" })).toEqual({ specialties: ["Cardiology", "Dermatology"], bounds: [-10, 170, 10, -170], openNow: true, open24Hours: false });
  });
  it.each(["", "1,2,1,3", "-91,0,4,4", "0,181,4,4", "0,,4,4", "0,0,4,Infinity"])("rejects malformed bounds %s", bounds => {
    expect(parseBrowseFilters({ bounds })).toBeNull();
  });
  it("rejects malformed checkbox and specialty values", () => {
    expect(parseBrowseFilters({ openNow: "yes" })).toBeNull();
    expect(parseBrowseFilters({ specialization: { $ne: "" } })).toBeNull();
    expect(parseBrowseFilters({ specialization: Array(31).fill("x") })).toBeNull();
  });
  it("never treats missing or invalid hours as open", () => {
    for (const hours of [null, "", "invalid", "{broken", "99:00 - 99:30"]) expect(facilityHours(hours, "Asia/Kolkata")).toEqual({ open: false, allDay: false });
  });
  it("evaluates split shifts, local dates and unknown timezones", () => {
    const hours = JSON.stringify({ monday: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }] });
    expect(facilityHours(hours, "Asia/Kolkata", new Date("2026-10-26T05:00:00Z")).open).toBe(true);
    expect(facilityHours(hours, "Asia/Kolkata", new Date("2026-10-26T07:30:00Z")).open).toBe(false);
    expect(facilityHours(hours, "America/New_York", new Date("2026-10-26T05:00:00Z")).open).toBe(false);
    expect(facilityHours(hours, "Not/AZone").open).toBe(false);
  });
  it("carries overnight opening across midnight without keeping it open all day", () => {
    const hours = JSON.stringify({ monday: [{ start: "22:00", end: "02:00" }] });
    expect(facilityHours(hours, "UTC", new Date("2026-10-27T01:00:00Z"))).toEqual({ open: true, allDay: false });
    expect(facilityHours(hours, "UTC", new Date("2026-10-27T03:00:00Z")).open).toBe(false);
  });
  it("recognizes explicit round-the-clock schedules", () => {
    expect(facilityHours("24/7", "Asia/Kolkata")).toEqual({ open: true, allDay: true });
    const hours = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(day => [day, [{ start: "00:00", end: "24:00" }]]));
    expect(facilityHours(JSON.stringify(hours), "UTC")).toEqual({ open: true, allDay: true });
  });
});
