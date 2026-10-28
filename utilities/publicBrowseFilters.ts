/** Public discovery filters. Unknown hours never count as open. */
const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
type Interval = { start: number; end: number };

function minutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (minute > 59 || hour > (match[3] ? 12 : 24) || (hour === 24 && minute !== 0)) return null;
  if (match[3]) hour = hour % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
  return hour * 60 + minute;
}

function intervals(value: unknown): Interval[] {
  if (typeof value === "string") return value.split(/[,;\n]/).flatMap(part => {
    const [start, end] = part.split(/\s*(?:–|—|-|\bto\b)\s*/i);
    return intervals({ start, end });
  });
  if (Array.isArray(value)) return value.flatMap(intervals);
  if (!value || typeof value !== "object") return [];
  const slot = value as { start?: unknown; end?: unknown };
  const start = minutes(slot.start), end = minutes(slot.end);
  if (start === null || end === null || (start === end && start !== 0)) return [];
  return [{ start, end: end <= start ? end + 1440 : end }];
}

export function facilityHours(timings: unknown, timezone: string, now = new Date()) {
  if (typeof timings !== "string" || !timings.trim()) return { open: false, allDay: false };
  if (/24\s*(?:\/\s*7|x\s*7|hours|hrs)|round the clock|^open 24$/i.test(timings)) return { open: true, allDay: true };
  let value: unknown = timings;
  try { if (/^[\[{]/.test(timings.trim())) value = JSON.parse(timings); } catch { return { open: false, allDay: false }; }
  const weekly = days.map(day => {
    if (value && typeof value === "object" && !Array.isArray(value) && !("start" in value)) {
      const record = value as Record<string, unknown>;
      const key = Object.keys(record).find(key => key.toLowerCase() === day || key.toLowerCase() === day.slice(0, 3));
      return intervals(key ? record[key] : record.all || record.daily);
    }
    // The existing simple-range contract applies Monday to Saturday.
    return day === "sunday" ? [] : intervals(value);
  });
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string) => parts.find(part => part.type === type)?.value || "";
    const day = days.indexOf(get("weekday").toLowerCase());
    const time = Number(get("hour")) * 60 + Number(get("minute"));
    const open = weekly[day]?.some(slot => time >= slot.start && time < slot.end) || weekly[(day + 6) % 7]?.some(slot => slot.end > 1440 && time < slot.end - 1440) || false;
    const allDay = weekly.every(slots => slots.some(slot => slot.start === 0 && slot.end >= 1440));
    return { open, allDay };
  } catch { return { open: false, allDay: false }; }
}

export function parseBrowseFilters(query: Record<string, unknown>) {
  const raw = query.specialization === undefined ? [] : Array.isArray(query.specialization) ? query.specialization : [query.specialization];
  if (raw.length > 30 || raw.some(value => typeof value !== "string" || value.length > 160)) return null;
  const specialties = [...new Set((raw as string[]).map(value => value.trim()).filter(Boolean))];
  for (const key of ["openNow", "open24Hours"]) if (query[key] !== undefined && !["true", "false"].includes(String(query[key]))) return null;
  let bounds: [number, number, number, number] | undefined;
  if (query.bounds !== undefined) {
    if (typeof query.bounds !== "string") return null;
    const parts = query.bounds.split(",");
    const values = parts.map(Number);
    if (parts.length !== 4 || parts.some(part => !part.trim()) || values.some(value => !Number.isFinite(value)) || Math.abs(values[0]) > 90 || Math.abs(values[2]) > 90 || Math.abs(values[1]) > 180 || Math.abs(values[3]) > 180 || values[0] >= values[2]) return null;
    bounds = values as [number, number, number, number];
  }
  return { specialties, bounds, openNow: query.openNow === "true", open24Hours: query.open24Hours === "true" };
}
