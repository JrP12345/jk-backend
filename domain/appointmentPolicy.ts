export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "checked-in"
  | "in-consultation"
  | "standby"
  | "completed"
  | "cancelled"
  | "no-show"
  | "disruption_triage";

const VALID_STATE_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ["confirmed", "checked-in", "cancelled", "no-show", "disruption_triage"],
  confirmed: ["checked-in", "in-consultation", "cancelled", "no-show", "disruption_triage"],
  "checked-in": ["in-consultation", "standby", "cancelled", "no-show"],
  "in-consultation": ["completed", "standby", "cancelled"],
  standby: ["in-consultation", "completed", "cancelled", "no-show"],
  completed: [], // Terminal
  cancelled: [], // Terminal
  "no-show": ["confirmed", "checked-in"], // Re-instatement allowed by reception
  disruption_triage: ["confirmed", "cancelled"],
};

/**
 * Pure policy function: checks whether a state transition is permitted by clinical workflow rules.
 * Zero database I/O, zero side effects.
 */
export function isValidAppointmentStateTransition(
  currentStatus: AppointmentStatus,
  nextStatus: AppointmentStatus,
): { allowed: boolean; reason?: string } {
  if (currentStatus === nextStatus) {
    return { allowed: true };
  }

  const allowedNext = VALID_STATE_TRANSITIONS[currentStatus];
  if (!allowedNext || !allowedNext.includes(nextStatus)) {
    return {
      allowed: false,
      reason: `Cannot transition appointment from '${currentStatus}' to '${nextStatus}'. Permitted transitions: [${(allowedNext || []).join(", ")}]`,
    };
  }

  return { allowed: true };
}

export interface CancellationRefundCalculation {
  refundPercentage: number;
  refundAmount: number;
  feePenalty: number;
  policyApplied: "FULL_REFUND" | "STANDARD_REFUND" | "LATE_CANCELLATION_FEE" | "NO_REFUND";
}

/**
 * Pure policy function: calculates patient refund and penalty fees based on notice window.
 * Notice >= 24h: 100% refund.
 * Notice 4h - 24h: 80% refund (20% processing penalty).
 * Notice < 4h: 50% refund (50% late-cancellation penalty).
 * Post-appointment: 0% refund.
 */
export function calculateCancellationRefund(
  totalFee: number,
  appointmentTime: Date,
  cancelledAt: Date = new Date(),
): CancellationRefundCalculation {
  if (totalFee <= 0) {
    return { refundPercentage: 100, refundAmount: 0, feePenalty: 0, policyApplied: "FULL_REFUND" };
  }

  const noticeMs = appointmentTime.getTime() - cancelledAt.getTime();
  const noticeHours = noticeMs / (1000 * 60 * 60);

  if (noticeHours >= 24) {
    return {
      refundPercentage: 100,
      refundAmount: totalFee,
      feePenalty: 0,
      policyApplied: "FULL_REFUND",
    };
  }

  if (noticeHours >= 4) {
    const penalty = Math.round(totalFee * 0.2);
    const refund = totalFee - penalty;
    return {
      refundPercentage: 80,
      refundAmount: refund,
      feePenalty: penalty,
      policyApplied: "STANDARD_REFUND",
    };
  }

  if (noticeHours > 0) {
    const penalty = Math.round(totalFee * 0.5);
    const refund = totalFee - penalty;
    return {
      refundPercentage: 50,
      refundAmount: refund,
      feePenalty: penalty,
      policyApplied: "LATE_CANCELLATION_FEE",
    };
  }

  return {
    refundPercentage: 0,
    refundAmount: 0,
    feePenalty: totalFee,
    policyApplied: "NO_REFUND",
  };
}

/**
 * Pure function: checks for overlapping time-slot ranges.
 */
export function hasTimeSlotConflict(
  slotA: { start: Date; end: Date },
  slotB: { start: Date; end: Date },
): boolean {
  return slotA.start.getTime() < slotB.end.getTime() && slotA.end.getTime() > slotB.start.getTime();
}
