import { describe, expect, it } from "vitest";
import { appointmentReviewState } from "../utilities/appointmentReview.ts";
import { runNoShowSweep } from "../jobs/noShowSweepJob.ts";

const now = new Date("2026-09-29T12:00:00.000Z");
const visit = (status: string, hoursAgo: number, bookingMode = "sequential_queue") => ({ status, bookingMode, appointmentTime: new Date(now.getTime() - hoursAgo * 3600000) });

describe("appointment review without inferred medical events", () => {
  it("flags old bookings, check-ins, standbys and unfinished consultations for staff review", () => {
    for (const status of ["pending_payment", "pending", "confirmed", "checked-in", "standby", "in-consultation", "disruption_triage"]) {
      expect(appointmentReviewState(visit(status, 25), now)).toBe("unresolved");
    }
  });
  it("shows passed time slots as overdue without changing queue visits or terminal statuses", () => {
    expect(appointmentReviewState(visit("confirmed", 1, "time_slot"), now)).toBe("overdue");
    expect(appointmentReviewState(visit("pending", 1), now)).toBeNull();
    expect(appointmentReviewState(visit("checked-in", 1, "time_slot"), now)).toBeNull();
    expect(appointmentReviewState(visit("in-consultation", 1), now)).toBeNull();
    for (const status of ["completed", "cancelled", "no-show"]) expect(appointmentReviewState(visit(status, 30), now)).toBeNull();
    expect(appointmentReviewState(visit("confirmed", -1, "time_slot"), now)).toBeNull();
  });
  it("retired automatic sweep never writes or fabricates no-shows", async () => {
    expect(await runNoShowSweep()).toEqual({ sweptCount: 0, clinicIdsAffected: [] });
  });
});
