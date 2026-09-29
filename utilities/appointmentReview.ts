/** A display-only signal. Never infer arrival, absence or clinical completion. */
export type AppointmentReviewState = "overdue" | "unresolved" | null;

export function appointmentReviewState(
  appointment: { status: string; appointmentTime: Date | string; bookingMode?: string },
  now: Date = new Date(),
): AppointmentReviewState {
  if (["completed", "cancelled", "no-show"].includes(appointment.status)) return null;
  const at = new Date(appointment.appointmentTime).getTime();
  if (!Number.isFinite(at) || at > now.getTime()) return null;
  // A full elapsed day is unambiguous across supported clinic time zones.
  if (now.getTime() - at >= 24 * 60 * 60 * 1000) return "unresolved";
  if (appointment.bookingMode === "time_slot" && ["pending_payment", "pending", "confirmed"].includes(appointment.status)) return "overdue";
  return null;
}

export const reviewCandidateFilter = (now: Date = new Date()) => ({
  $or: [
    {
      status: { $in: ["pending_payment", "pending", "confirmed", "checked-in", "in-consultation", "standby", "disruption_triage"] },
      appointmentTime: { $lte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
    {
      status: { $in: ["pending_payment", "pending", "confirmed"] },
      bookingMode: "time_slot",
      appointmentTime: { $lte: now },
    },
  ],
});
