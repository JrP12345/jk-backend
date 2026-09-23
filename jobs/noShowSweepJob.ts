import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

let intervalHandle: NodeJS.Timeout | null = null;

export interface NoShowSweepOptions {
  organizationId?: string;
  clinicId?: string;
  gracePeriodMinutes?: number;
}

export interface NoShowSweepResult {
  sweptCount: number;
  clinicIdsAffected: string[];
}

/**
 * Scheduled background job: sweeps for past-due un-arrived appointments
 * and idempotently marks them as "no-show".
 *
 * Invariants:
 * - Decoupled from HTTP GET tracker requests (zero read-time mutations).
 * - Scoped by organization/clinic.
 * - Uses indexed query: { clinicId, status: { $in: ["pending", "confirmed"] }, appointmentTime: { $gte, $lte } }.
 * - Emits real-time and domain events ONLY when state actually changes.
 */
export async function runNoShowSweep(options: NoShowSweepOptions = {}): Promise<NoShowSweepResult> {
  try {
    const now = new Date();
    const graceMinutes = options.gracePeriodMinutes ?? 30;
    const cutoffTime = new Date(now.getTime() - graceMinutes * 60 * 1000);

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const query: Record<string, any> = {
      status: { $in: ["pending", "confirmed"] },
      appointmentTime: { $gte: startOfDay, $lte: cutoffTime },
    };

    if (options.clinicId && mongoose.Types.ObjectId.isValid(options.clinicId)) {
      query.clinicId = new mongoose.Types.ObjectId(options.clinicId);
    }
    if (options.organizationId && mongoose.Types.ObjectId.isValid(options.organizationId)) {
      query.organizationId = new mongoose.Types.ObjectId(options.organizationId);
    }

    // Step 1: Find candidate stale appointments (indexed read)
    const candidates = await Appointment.find(query)
      .select("_id clinicId doctorId tokenNumber status patientId organizationId")
      .lean();

    if (candidates.length === 0) {
      return { sweptCount: 0, clinicIdsAffected: [] };
    }

    const candidateIds = candidates.map((c) => c._id);
    const noteSuffix = ` [Auto-marked no-show: Patient did not arrive within ${graceMinutes} mins of slot]`;

    // Step 2: Atomic, idempotent bulk update
    const updateResult = await Appointment.updateMany(
      {
        _id: { $in: candidateIds },
        status: { $in: ["pending", "confirmed"] }, // Idempotency guard: only touch if still un-arrived
      },
      {
        $set: {
          status: "no-show",
          updatedAt: now,
        },
      },
    );

    const sweptCount = updateResult.modifiedCount;

    // Step 3: Emit events ONLY when state actually changes
    if (sweptCount > 0) {
      const clinicMap = new Map<string, any[]>();
      for (const c of candidates) {
        const cId = c.clinicId?.toString();
        if (cId) {
          if (!clinicMap.has(cId)) clinicMap.set(cId, []);
          clinicMap.get(cId)!.push(c);
        }
      }

      for (const [clinicIdStr, appts] of clinicMap.entries()) {
        try {
          broadcastQueueUpdate(clinicIdStr, {
            type: "QUEUE_UPDATED",
            data: {
              clinicId: clinicIdStr,
              autoNoShowsDetected: appts.length,
            },
            message: `${appts.length} un-arrived appointment(s) marked as no-show by scheduled sweeper`,
            timestamp: now.toISOString(),
          });
        } catch (wsErr) {
          console.warn("[NoShowSweepJob] WebSocket broadcast notice:", wsErr);
        }

        // Publish durable domain event for each marked appointment
        for (const appt of appts) {
          eventBus
            .publishDurable({
              eventType: EVENT_TYPES.APPOINTMENT_CANCELLED,
              category: "clinical",
              targetUserId: appt.patientId?.toString() || "",
              title: "Appointment Marked No-Show",
              message: `Your appointment (Token #${appt.tokenNumber}) was automatically marked as no-show due to non-arrival.`,
              severity: "warning",
              organizationId: appt.organizationId?.toString(),
              metadata: {
                appointmentId: appt._id.toString(),
                tokenNumber: appt.tokenNumber,
                clinicId: clinicIdStr,
                reason: "no_show_timeout",
              },
            })
            .catch(() => {});
        }
      }

      console.log(`[NoShowSweepJob] Idempotently marked ${sweptCount} stale appointment(s) as no-show across ${clinicMap.size} clinic(s).`);
      return { sweptCount, clinicIdsAffected: Array.from(clinicMap.keys()) };
    }

    return { sweptCount: 0, clinicIdsAffected: [] };
  } catch (err: any) {
    console.error("[NoShowSweepJob] Error during no-show sweep:", err);
    return { sweptCount: 0, clinicIdsAffected: [] };
  }
}

export function startNoShowSweepJob(intervalMs: number = 5 * 60 * 1000) {
  if (intervalHandle) return;
  console.log(`[NoShowSweepJob] Starting scheduled no-show sweeper (interval: ${intervalMs}ms)`);
  intervalHandle = setInterval(() => {
    runNoShowSweep().catch((err) => console.error("[NoShowSweepJob] Scheduled run failed:", err));
  }, intervalMs);
  if (intervalHandle.unref) {
    intervalHandle.unref();
  }
}

export function stopNoShowSweepJob() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[NoShowSweepJob] Scheduled no-show sweeper stopped.");
  }
}
