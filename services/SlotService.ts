import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { Location } from "../models/Location.ts";
import { isActiveBookingDoctor } from "../utilities/doctorBookingEligibility.ts";

import { checkSlotLock } from "./SlotLockService.ts";
import { locationClockMinutes, locationDateKey, locationDayRange, locationLocalTimeToDate, getLocationTimezone } from "../utilities/locationTime.ts";

export interface TimeSlot {
  time: string; // e.g. "09:00", "09:15"
  available: boolean;
  reason?: string;
  isLocked?: boolean;
  lockedByOther?: boolean;
}

export class DoctorBookingUnavailableError extends Error {
  constructor() {
    super("Doctor is unavailable for new appointments at this location");
    this.name = "DoctorBookingUnavailableError";
  }
}

export interface GetDoctorSlotsResult {
  date: string;
  appointmentDuration: number;
  bookingMode: "time_slot" | "sequential_queue";
  maxDailyTokens?: number | null;
  tokensToday?: number;
  nextToken?: number;
  slots: TimeSlot[];
  workingHours?: string;
  dayStartTime?: string;
  dayEndTime?: string;
  isWorkingDay?: boolean;
  overrideActive?: boolean;
  isHoliday?: boolean;
  holidayReason?: string | null;
  overrideStatus?: string | null;
  overrideReason?: string | null;
}

export interface ParsedDaySchedule {
  isWorkingDay: boolean;
  intervals: { start: string; end: string }[];
  workingHoursLabel: string;
  dayStartTime: string;
  dayEndTime: string;
}

export interface EffectiveSchedule extends ParsedDaySchedule {
  overrideActive: boolean;
  overrideStatus?: "available" | "unavailable" | "delayed" | "extended";
  overrideReason?: string;
}

export async function getEffectiveDoctorSchedule(
  doctorId: string,
  locationId: string,
  targetDate: Date | string,
  assignmentWorkingHours?: any,
  locationTimezone?: string
): Promise<EffectiveSchedule> {
  const timezone = locationTimezone || await getLocationTimezone(locationId);
  const dateStr = typeof targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)
    ? targetDate
    : locationDateKey(typeof targetDate === "string" ? new Date(targetDate) : targetDate, timezone);
  const d = new Date(`${dateStr}T12:00:00Z`);

  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = daysOfWeek[d.getUTCDay()];

  // 1. Check for day override
  const override = await DoctorDayOverride.findOne({ locationId, doctorId, date: dateStr });

  if (override) {
    if (override.status === "unavailable") {
      return {
        isWorkingDay: false,
        intervals: [],
        workingHoursLabel: override.reason ? `Unavailable: ${override.reason}` : "Doctor Unavailable (Override)",
        dayStartTime: "00:00",
        dayEndTime: "00:00",
        overrideActive: true,
        overrideStatus: "unavailable",
        overrideReason: override.reason || undefined,
      };
    }

    if (override.status === "delayed" || override.status === "extended" || override.status === "available") {
      let baseSchedule: ParsedDaySchedule;
      if (assignmentWorkingHours !== undefined) {
        baseSchedule = parseDoctorWorkingHours(assignmentWorkingHours, dayName);
      } else {
        const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
        baseSchedule = parseDoctorWorkingHours(assignment?.workingHours, dayName);
      }

      const start = override.effectiveStartTime || baseSchedule.dayStartTime || "09:00";
      const end = override.effectiveEndTime || baseSchedule.dayEndTime || "17:00";

      return {
        isWorkingDay: true,
        intervals: [{ start, end }],
        workingHoursLabel: `${start} - ${end}${override.reason ? ` (${override.reason})` : ""}`,
        dayStartTime: start,
        dayEndTime: end,
        overrideActive: true,
        overrideStatus: override.status as any,
        overrideReason: override.reason || undefined,
      };
    }
  }

  // 2. Default schedule from assignment
  let baseSchedule: ParsedDaySchedule;
  if (assignmentWorkingHours !== undefined) {
    baseSchedule = parseDoctorWorkingHours(assignmentWorkingHours, dayName);
  } else {
    const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
    baseSchedule = parseDoctorWorkingHours(assignment?.workingHours, dayName);
  }

  return {
    ...baseSchedule,
    overrideActive: false,
  };
}

export function parseDoctorWorkingHours(workingHoursRaw: any, dayName: string): ParsedDaySchedule {
  const defaultSchedule: ParsedDaySchedule = {
    isWorkingDay: dayName.toLowerCase() !== "sunday",
    intervals: [{ start: "09:00", end: "17:00" }],
    workingHoursLabel: "09:00 - 17:00",
    dayStartTime: "09:00",
    dayEndTime: "17:00",
  };

  if (!workingHoursRaw) return defaultSchedule;

  try {
    let parsed = workingHoursRaw;
    if (typeof workingHoursRaw === "string") {
      const trimmed = workingHoursRaw.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        parsed = JSON.parse(trimmed);
      } else {
        // Plain string range e.g. "09:00 - 17:00" or "08:30-18:30"
        const parts = trimmed.split(/[-–—to]/i).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const start = parts[0];
          const end = parts[1];
          return {
            isWorkingDay: dayName.toLowerCase() !== "sunday",
            intervals: [{ start, end }],
            workingHoursLabel: `${start} - ${end}`,
            dayStartTime: start,
            dayEndTime: end,
          };
        }
        return defaultSchedule;
      }
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return defaultSchedule;
      const intervals = parsed.map((item: any) => ({
        start: item.start || "09:00",
        end: item.end || "17:00",
      }));
      return {
        isWorkingDay: dayName.toLowerCase() !== "sunday",
        intervals,
        workingHoursLabel: intervals.map(i => `${i.start} - ${i.end}`).join(", "),
        dayStartTime: intervals[0].start,
        dayEndTime: intervals[intervals.length - 1].end,
      };
    }

    if (typeof parsed === "object" && parsed !== null) {
      const lowerKey = Object.keys(parsed).find(k => k.toLowerCase() === dayName.toLowerCase());
      const dayData = lowerKey ? parsed[lowerKey] : (parsed.all || parsed.daily || null);

      if (!dayData) {
        return {
          isWorkingDay: false,
          intervals: [],
          workingHoursLabel: "Closed / Off",
          dayStartTime: "09:00",
          dayEndTime: "17:00",
        };
      }

      if (Array.isArray(dayData)) {
        if (dayData.length === 0) {
          return {
            isWorkingDay: false,
            intervals: [],
            workingHoursLabel: "Closed / Off",
            dayStartTime: "09:00",
            dayEndTime: "17:00",
          };
        }
        const intervals = dayData.map((item: any) => ({
          start: item.start || "09:00",
          end: item.end || "17:00",
        }));
        return {
          isWorkingDay: true,
          intervals,
          workingHoursLabel: intervals.map(i => `${i.start} - ${i.end}`).join(", "),
          dayStartTime: intervals[0].start,
          dayEndTime: intervals[intervals.length - 1].end,
        };
      }

      if (typeof dayData === "object" && dayData.start && dayData.end) {
        return {
          isWorkingDay: true,
          intervals: [{ start: dayData.start, end: dayData.end }],
          workingHoursLabel: `${dayData.start} - ${dayData.end}`,
          dayStartTime: dayData.start,
          dayEndTime: dayData.end,
        };
      }
    }

    return defaultSchedule;
  } catch {
    return defaultSchedule;
  }
}

export async function getDoctorAvailableSlots(
  doctorId: string,
  locationId: string,
  dateStr: string,
  requestingUserId?: string
): Promise<GetDoctorSlotsResult> {
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(`${dateStr}T00:00:00Z`) : new Date(NaN);
  if (isNaN(targetDate.getTime()) || targetDate.toISOString().slice(0, 10) !== dateStr) {
    throw new RangeError("Invalid date format. Expected YYYY-MM-DD");
  }

  // Find assignment
  const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
  if (!assignment || !(await Location.exists({ _id: locationId, organizationId: assignment.organizationId, isActive: true })) || !(await isActiveBookingDoctor(doctorId))) {
    throw new DoctorBookingUnavailableError();
  }

  const duration = assignment?.appointmentDuration || 15;
  const bookingMode = (assignment as any)?.bookingMode || "sequential_queue";
  const maxDailyTokens = (assignment as any)?.maxDailyTokens || null;

  const timezone = await getLocationTimezone(locationId);
  const { start: startOfDay, end: endOfDay } = locationDayRange(dateStr, timezone);

  // Fetch existing non-cancelled appointments count for this day
  const existingAppts = await Appointment.find({
    doctorId,
    locationId,
    appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ["cancelled", "no-show"] }
  }).select("appointmentTime status tokenNumber");

  const tokensToday = existingAppts.length;
  const nextToken = tokensToday + 1;

  const daySchedule = await getEffectiveDoctorSchedule(doctorId, locationId, dateStr, assignment?.workingHours, timezone);
  const isHoliday = daySchedule.overrideActive && daySchedule.overrideStatus === "unavailable";
  const holidayReason = isHoliday ? (daySchedule.overrideReason || "Doctor Holiday / Leave") : null;

  if (bookingMode === "sequential_queue") {
    return {
      date: dateStr,
      appointmentDuration: duration,
      bookingMode: "sequential_queue",
      maxDailyTokens,
      tokensToday,
      nextToken: daySchedule.isWorkingDay ? nextToken : (null as any),
      slots: [],
      workingHours: daySchedule.workingHoursLabel,
      dayStartTime: daySchedule.dayStartTime,
      dayEndTime: daySchedule.dayEndTime,
      isWorkingDay: daySchedule.isWorkingDay,
      overrideActive: daySchedule.overrideActive,
      isHoliday,
      holidayReason,
      overrideStatus: daySchedule.overrideStatus || null,
      overrideReason: daySchedule.overrideReason || null,
    };
  }

  if (!daySchedule.isWorkingDay || daySchedule.intervals.length === 0) {
    return {
      date: dateStr,
      appointmentDuration: duration,
      bookingMode: "time_slot",
      maxDailyTokens,
      tokensToday,
      nextToken: null as any,
      slots: [],
      workingHours: daySchedule.workingHoursLabel,
      dayStartTime: daySchedule.dayStartTime,
      dayEndTime: daySchedule.dayEndTime,
      isWorkingDay: false,
      overrideActive: daySchedule.overrideActive,
      isHoliday,
      holidayReason,
      overrideStatus: daySchedule.overrideStatus || null,
      overrideReason: daySchedule.overrideReason || null,
    };
  }

  const bookedTimes = new Set(
    existingAppts.map(a => {
      const d = new Date(a.appointmentTime);
      const clockMinutes = locationClockMinutes(d, timezone);
      const hours = Math.floor(clockMinutes / 60).toString().padStart(2, "0");
      const minutes = (clockMinutes % 60).toString().padStart(2, "0");
      return `${hours}:${minutes}`;
    })
  );

  // Generate slots across all intervals for the day
  const slots: TimeSlot[] = [];

  for (const interval of daySchedule.intervals) {
    const [startH, startM] = interval.start.split(":").map(Number);
    const [endH, endM] = interval.end.split(":").map(Number);

    let currentMinutes = (startH || 0) * 60 + (startM || 0);
    const endMinutesTotal = (endH || 0) * 60 + (endM || 0);

    while (currentMinutes + duration <= endMinutesTotal) {
      const h = Math.floor(currentMinutes / 60);
      const m = currentMinutes % 60;
      const timeFormatted = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;

      const isBooked = bookedTimes.has(timeFormatted);

      // Check lock status for this slot
      let slotISOTime: string;
      try {
        slotISOTime = locationLocalTimeToDate(dateStr, timeFormatted, timezone).toISOString();
      } catch {
        currentMinutes += duration;
        continue;
      }
      let isLocked = false;
      let lockedByOther = false;

      try {
        const lockInfo = await checkSlotLock(locationId, doctorId, slotISOTime);
        if (lockInfo.isLocked) {
          isLocked = true;
          lockedByOther = requestingUserId ? lockInfo.heldByUserId !== requestingUserId : true;
        }
      } catch {
        // Non-critical: if lock check fails, treat as unlocked
      }

      slots.push({
        time: timeFormatted,
        available: !isBooked,
        reason: isBooked ? "Booked" : undefined,
        isLocked,
        lockedByOther: isBooked ? false : lockedByOther,
      });

      currentMinutes += duration;
    }
  }

  return {
    date: dateStr,
    appointmentDuration: duration,
    bookingMode: "time_slot",
    maxDailyTokens,
    tokensToday,
    nextToken,
    slots,
    workingHours: daySchedule.workingHoursLabel,
    dayStartTime: daySchedule.dayStartTime,
    dayEndTime: daySchedule.dayEndTime,
    isWorkingDay: daySchedule.isWorkingDay,
    overrideActive: daySchedule.overrideActive,
    isHoliday: false,
    holidayReason: null,
    overrideStatus: daySchedule.overrideStatus || null,
    overrideReason: daySchedule.overrideReason || null,
  };
}
