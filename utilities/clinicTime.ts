import { Clinic } from "../models/Clinic.ts";
import { Organization } from "../models/Organization.ts";

function parts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: string) => Number(values.find(value => value.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute") };
}

export function clinicDateKey(date: Date, timezone: string): string {
  const { year, month, day } = parts(date, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function clinicClockMinutes(date: Date, timezone: string): number {
  const { hour, minute } = parts(date, timezone);
  return hour * 60 + minute;
}

export function clinicLocalTimeToDate(dateKey: string, time: string, timezone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isInteger)) throw new Error("Invalid clinic time");
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}:\d{2}(?::00)?$/.test(time)
    || calendarDate.toISOString().slice(0, 10) !== dateKey || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Invalid clinic time");
  }
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = parts(new Date(instant), timezone);
    const observed = Date.UTC(found.year, found.month - 1, found.day, found.hour, found.minute);
    if (observed === wanted) return new Date(instant);
    instant += wanted - observed;
  }
  throw new Error("Clinic time does not exist due to a timezone change");
}

export function clinicDayRange(dateKey: string, timezone: string) {
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextKey = next.toISOString().slice(0, 10);
  return {
    start: clinicLocalTimeToDate(dateKey, "00:00", timezone),
    end: new Date(clinicLocalTimeToDate(nextKey, "00:00", timezone).getTime() - 1),
  };
}

export async function getClinicTimezone(clinicId: string): Promise<string> {
  const clinic = await Clinic.findById(clinicId).select("timezone organizationId").lean();
  if (clinic?.timezone) return clinic.timezone;
  const organization = clinic?.organizationId
    ? await Organization.findById(clinic.organizationId).select("timezone").lean()
    : null;
  return organization?.timezone || "Asia/Kolkata";
}
