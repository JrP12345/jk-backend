import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";

export interface TimeSlot {
  time: string; // e.g. "09:00", "09:15"
  available: boolean;
  reason?: string;
}

export async function getDoctorAvailableSlots(
  doctorId: string,
  clinicId: string,
  dateStr: string
): Promise<{ date: string; appointmentDuration: number; slots: TimeSlot[] }> {
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate.getTime())) {
    throw new Error("Invalid date format. Expected YYYY-MM-DD");
  }

  // Find assignment
  const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
  const duration = assignment?.appointmentDuration || 15;

  // Day of week e.g. "monday"
  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = daysOfWeek[targetDate.getDay()];

  // Default start/end times if not configured in JSON
  let startHour = 9;
  let startMinute = 0;
  let endHour = 17;
  let endMinute = 0;

  if (assignment?.workingHours) {
    try {
      const parsedHours = JSON.parse(assignment.workingHours);
      if (parsedHours[dayName]) {
        const daySchedule = parsedHours[dayName];
        if (daySchedule.start) {
          const [sh, sm] = daySchedule.start.split(":").map(Number);
          startHour = sh;
          startMinute = sm || 0;
        }
        if (daySchedule.end) {
          const [eh, em] = daySchedule.end.split(":").map(Number);
          endHour = eh;
          endMinute = em || 0;
        }
      }
    } catch {
      // Fallback to default 9am-5pm if parsing fails
    }
  }

  // Fetch existing non-cancelled appointments for this doctor & clinic on this day
  const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
  const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

  const existingAppts = await Appointment.find({
    doctorId,
    clinicId,
    appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ["cancelled", "no-show"] }
  }).select("appointmentTime status");

  const bookedTimes = new Set(
    existingAppts.map(a => {
      const d = new Date(a.appointmentTime);
      const hours = d.getHours().toString().padStart(2, "0");
      const minutes = d.getMinutes().toString().padStart(2, "0");
      return `${hours}:${minutes}`;
    })
  );

  // Generate slots
  const slots: TimeSlot[] = [];
  let currentMinutes = startHour * 60 + startMinute;
  const endMinutesTotal = endHour * 60 + endMinute;

  while (currentMinutes + duration <= endMinutesTotal) {
    const h = Math.floor(currentMinutes / 60);
    const m = currentMinutes % 60;
    const timeFormatted = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;

    const isBooked = bookedTimes.has(timeFormatted);
    slots.push({
      time: timeFormatted,
      available: !isBooked,
      reason: isBooked ? "Booked" : undefined
    });

    currentMinutes += duration;
  }

  return {
    date: dateStr,
    appointmentDuration: duration,
    slots
  };
}
