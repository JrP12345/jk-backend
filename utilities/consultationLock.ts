/**
 * A materialized local-calendar-day key used by Appointment's unique sparse
 * index. Keeping the day in the key lets MongoDB, rather than a read-then-
 * write race, enforce one active consultation per doctor.
 */
export function getActiveConsultationDoctorDayKey(doctorId: unknown, appointmentTime: Date | string) {
  const date = new Date(appointmentTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error("A valid appointment time is required for an active consultation lock");
  }

  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

  return `doctor:${String(doctorId)}:day:${day}`;
}

export function isActiveConsultationLockConflict(error: unknown) {
  const mongoError = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string } | undefined;
  return mongoError?.code === 11000 && (
    Boolean(mongoError.keyPattern?.activeConsultationDoctorDayKey) ||
    String(mongoError.message || "").includes("activeConsultationDoctorDayKey")
  );
}
