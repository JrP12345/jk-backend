import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { checkSlotLock } from "./SlotLockService.ts";

export interface TimeSlot {
  time: string; // e.g. "09:00", "09:15"
  available: boolean;
  reason?: string;
  isLocked?: boolean;
  lockedByOther?: boolean;
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
  clinicId: string,
  targetDate: Date | string,
  assignmentWorkingHours?: any
): Promise<EffectiveSchedule> {
  const d = typeof targetDate === "string" ? new Date(targetDate) : targetDate;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = daysOfWeek[d.getDay()];

  // 1. Check for day override
  const override = await DoctorDayOverride.findOne({ clinicId, doctorId, date: dateStr });

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
        const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
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
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
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
  clinicId: string,
  dateStr: string,
  requestingUserId?: string
): Promise<GetDoctorSlotsResult> {
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate.getTime())) {
    throw new Error("Invalid date format. Expected YYYY-MM-DD");
  }

  // Find assignment
  const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
  const duration = assignment?.appointmentDuration || 15;
  const bookingMode = (assignment as any)?.bookingMode || "sequential_queue";
  const maxDailyTokens = (assignment as any)?.maxDailyTokens || null;

  const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
  const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

  // Fetch existing non-cancelled appointments count for this day
  const existingAppts = await Appointment.find({
    doctorId,
    clinicId,
    appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ["cancelled", "no-show"] }
  }).select("appointmentTime status tokenNumber");

  const tokensToday = existingAppts.length;
  const nextToken = tokensToday + 1;

  // Day of week e.g. "monday"
  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = daysOfWeek[targetDate.getDay()];

  const daySchedule = await getEffectiveDoctorSchedule(doctorId, clinicId, targetDate, assignment?.workingHours);
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
      const hours = d.getHours().toString().padStart(2, "0");
      const minutes = d.getMinutes().toString().padStart(2, "0");
      return `${hours}:${minutes}`;
    })
  );

  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, "0");
  const day = String(targetDate.getDate()).padStart(2, "0");

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
      const slotISOTime = `${year}-${month}-${day}T${timeFormatted}:00`;
      let isLocked = false;
      let lockedByOther = false;

      try {
        const lockInfo = await checkSlotLock(clinicId, doctorId, slotISOTime);
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
