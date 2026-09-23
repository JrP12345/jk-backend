/**
 * Pure policy function: calculates estimated wait minutes and call time.
 */
export function calculateWaitEstimate(
  peopleAhead: number,
  averageDurationMinutes: number,
  inConsultationRemainingMinutes: number = 0,
  referenceTime: Date = new Date(),
): { estimatedWaitMinutes: number; estimatedCallTime: Date } {
  const safePeopleAhead = Math.max(0, peopleAhead);
  const safeDuration = Math.max(1, averageDurationMinutes);
  const safeRemaining = Math.max(0, inConsultationRemainingMinutes);

  const estimatedWaitMinutes = safeRemaining + safePeopleAhead * safeDuration;
  const estimatedCallTime = new Date(referenceTime.getTime() + estimatedWaitMinutes * 60 * 1000);

  return {
    estimatedWaitMinutes,
    estimatedCallTime,
  };
}

/**
 * Pure policy function: evaluates whether an un-arrived appointment is eligible for no-show status.
 */
export function evaluateNoShowEligibility(
  appointmentTime: Date,
  gracePeriodMinutes: number = 30,
  currentTime: Date = new Date(),
): boolean {
  const cutoffTime = new Date(appointmentTime.getTime() + gracePeriodMinutes * 60 * 1000);
  return currentTime.getTime() > cutoffTime.getTime();
}

/**
 * Pure policy function: calculates effective priority rank in queue.
 * Lower rank numbers appear earlier in queue. Emergency appointments receive negative rank offsets.
 */
export function calculateQueuePriorityRank(input: {
  tokenNumber: number;
  queuePosition?: number | null;
  isEmergency?: boolean;
  priorityLevel?: "normal" | "urgent" | "emergency";
}): number {
  const base = input.queuePosition ?? input.tokenNumber;

  if (input.isEmergency || input.priorityLevel === "emergency") {
    return base - 10000; // Immediate top priority
  }
  if (input.priorityLevel === "urgent") {
    return base - 1000;
  }
  return base;
}
