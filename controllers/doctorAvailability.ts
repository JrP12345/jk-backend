import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess } from "../utilities/tenant.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { disruptionService } from "../services/disruptionService.ts";

export async function setDoctorDayOverride(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const {
      clinicId,
      doctorId,
      date,
      status,
      effectiveStartTime,
      effectiveEndTime,
      reason,
    } = req.body as {
      clinicId: string;
      doctorId: string;
      date: string;
      status: "available" | "unavailable" | "delayed" | "extended";
      effectiveStartTime?: string;
      effectiveEndTime?: string;
      reason?: string;
    };

    if (!clinicId || !doctorId || !date || !status) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, date, and status are required"));
    }

    if (!["available", "unavailable", "delayed", "extended"].includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    // Authorization check
    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    // Only the doctor themselves, or staff (receptionist/admin/root) can set overrides
    if (userRole === "doctor" && userId !== doctorId) {
      return reply.code(403).send(errorResponse("Doctors can only modify their own availability"));
    }

    const orgId = clinicCheck.organizationId || req.user?.organization_id;

    // Upsert DoctorDayOverride
    const override = await DoctorDayOverride.findOneAndUpdate(
      { clinicId, doctorId, date },
      {
        clinicId,
        doctorId,
        organizationId: orgId || null,
        date,
        status,
        effectiveStartTime: effectiveStartTime || null,
        effectiveEndTime: effectiveEndTime || null,
        reason: reason || null,
        createdBy: userId,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Process Disruption and Patient Triage via disruptionService
    let disruptionSummary: any = null;
    if (status === "unavailable" || effectiveEndTime) {
      disruptionSummary = await disruptionService.processDoctorDisruption({
        clinicId,
        doctorId,
        date,
        status,
        effectiveStartTime,
        effectiveEndTime,
        reason,
        userId,
        organizationId: orgId || null,
        disruptionId: override._id,
      });
    }

    // Audit Log
    await AuditLog.create({
      userId,
      action: "DOCTOR_DAY_OVERRIDE_SET",
      targetId: override._id,
      targetModel: "DoctorDayOverride",
      details: {
        clinicId,
        doctorId,
        date,
        status,
        effectiveStartTime,
        effectiveEndTime,
        disruptionSummary,
      },
    });

    // Real-time queue broadcast
    broadcastQueueUpdate(clinicId, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId,
        doctorId,
        date,
        overrideStatus: status,
        effectiveStartTime,
        effectiveEndTime,
      },
      message: `Doctor availability changed: ${status}`,
      timestamp: new Date().toISOString(),
    });

    return reply.code(200).send(
      successResponse(
        {
          override,
          affectedSummary: disruptionSummary || {
            inConsultationPreservedCount: 0,
            checkedInTriageCount: 0,
            remoteNotifiedCount: 0,
            checkedInAtRisk: 0,
            autoCancelled: 0,
          },
        },
        "Doctor availability override set successfully"
      )
    );
  } catch (err) {
    console.error("setDoctorDayOverride error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getDoctorDayOverrides(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date, startDate, endDate } = req.query as {
      clinicId?: string;
      doctorId?: string;
      date?: string;
      startDate?: string;
      endDate?: string;
    };

    if (clinicId) {
      const clinicCheck = await checkClinicAccess(req, clinicId);
      if (!clinicCheck.allowed) {
        return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
      }
    }

    const filter: any = {};
    if (clinicId) filter.clinicId = clinicId;
    if (doctorId) filter.doctorId = doctorId;

    if (date) {
      filter.date = date;
    } else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate) filter.date.$lte = endDate;
    }

    const overrides = await DoctorDayOverride.find(filter)
      .populate("doctorId", "name email phone specialization")
      .sort({ date: 1 });

    return reply.code(200).send(successResponse(overrides));
  } catch (err) {
    console.error("getDoctorDayOverrides error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteDoctorDayOverride(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const userRole = req.user!.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid override ID"));
    }

    const override = await DoctorDayOverride.findById(id);
    if (!override) {
      return reply.code(404).send(errorResponse("Override not found"));
    }

    const clinicCheck = await checkClinicAccess(req, override.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    if (userRole === "doctor" && userId !== override.doctorId.toString()) {
      return reply.code(403).send(errorResponse("Doctors can only delete their own overrides"));
    }

    await override.deleteOne();

    await AuditLog.create({
      userId,
      action: "DOCTOR_DAY_OVERRIDE_DELETE",
      targetId: override._id,
      targetModel: "DoctorDayOverride",
      details: { clinicId: override.clinicId, doctorId: override.doctorId, date: override.date },
    });

    broadcastQueueUpdate(override.clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: override.clinicId.toString(),
        doctorId: override.doctorId.toString(),
        date: override.date,
        overrideStatus: "reverted_to_default",
      },
      message: "Doctor override removed; returned to standard schedule",
      timestamp: new Date().toISOString(),
    });

    return reply.code(200).send(successResponse(null, "Doctor availability override removed successfully"));
  } catch (err) {
    console.error("deleteDoctorDayOverride error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getTriageAppointments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = req.query as {
      clinicId: string;
      doctorId?: string;
      date?: string;
    };

    if (!clinicId) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const query: any = {
      clinicId,
      status: "disruption_triage",
    };

    if (doctorId) query.doctorId = doctorId;

    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      const startOfDay = new Date(y, m - 1, d, 0, 0, 0, 0);
      const endOfDay = new Date(y, m - 1, d, 23, 59, 59, 999);
      query.appointmentTime = { $gte: startOfDay, $lte: endOfDay };
    }

    const appointments = await Appointment.find(query)
      .populate("doctorId", "name email specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      })
      .sort({ tokenNumber: 1, appointmentTime: 1 });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getTriageAppointments error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getEligibleReplacements(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = req.query as {
      clinicId: string;
      doctorId: string;
      date?: string;
    };

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const targetDate = date || new Date().toISOString().slice(0, 10);
    const eligible = await disruptionService.getEligibleReplacementDoctors(clinicId, targetDate, doctorId);

    return reply.code(200).send(successResponse(eligible));
  } catch (err) {
    console.error("getEligibleReplacements error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function triageTransferAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, replacementDoctorId, reason } = req.body as {
      appointmentId: string;
      replacementDoctorId: string;
      reason?: string;
    };

    if (!appointmentId || !replacementDoctorId) {
      return reply.code(400).send(errorResponse("appointmentId and replacementDoctorId are required"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appt.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const updated = await disruptionService.transferPatient({
      appointmentId,
      replacementDoctorId,
      transferredByUserId: userId,
      reason,
    });

    return reply.code(200).send(successResponse(updated, "Patient transferred to replacement doctor successfully"));
  } catch (err: any) {
    console.error("triageTransferAppointment error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function triageCancelAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, reason } = req.body as {
      appointmentId: string;
      reason?: string;
    };

    if (!appointmentId) {
      return reply.code(400).send(errorResponse("appointmentId is required"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appt.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const updated = await disruptionService.cancelByDisruption({
      appointmentId,
      cancelledByUserId: userId,
      reason,
    });

    return reply.code(200).send(successResponse(updated, "Appointment cancelled successfully"));
  } catch (err: any) {
    console.error("triageCancelAppointment error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function triageRescheduleAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, targetDate, targetDoctorId, targetTimeSlot, reason } = req.body as {
      appointmentId: string;
      targetDate: string;
      targetDoctorId?: string;
      targetTimeSlot?: string;
      reason?: string;
    };

    if (!appointmentId || !targetDate) {
      return reply.code(400).send(errorResponse("appointmentId and targetDate are required"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appt.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const result = await disruptionService.priorityReschedule({
      appointmentId,
      targetDate,
      targetDoctorId,
      targetTimeSlot,
      rescheduledByUserId: userId,
      reason,
    });

    return reply.code(200).send(successResponse(result, "Appointment rescheduled successfully with high priority"));
  } catch (err: any) {
    console.error("triageRescheduleAppointment error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function triageBatchAction(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { action, appointmentIds, replacementDoctorId, targetDate, targetTimeSlot, reason } = req.body as {
      action: "transfer" | "cancel" | "reschedule";
      appointmentIds: string[];
      replacementDoctorId?: string;
      targetDate?: string;
      targetTimeSlot?: string;
      reason?: string;
    };

    if (!action || !appointmentIds || !Array.isArray(appointmentIds) || appointmentIds.length === 0) {
      return reply.code(400).send(errorResponse("action and non-empty appointmentIds array are required"));
    }

    // Verify access on first appointment
    const sampleAppt = await Appointment.findById(appointmentIds[0]);
    if (sampleAppt) {
      const clinicCheck = await checkClinicAccess(req, sampleAppt.clinicId.toString());
      if (!clinicCheck.allowed) {
        return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
      }
    }

    const result = await disruptionService.batchTriageAction({
      action,
      appointmentIds,
      actorUserId: userId,
      replacementDoctorId,
      targetDate,
      targetTimeSlot,
      reason,
    });

    return reply.code(200).send(successResponse(result, "Batch triage action completed"));
  } catch (err: any) {
    console.error("triageBatchAction error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function patientDisruptionAction(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId, action, targetDate, targetTimeSlot, reason } = req.body as {
      appointmentId: string;
      action: "reschedule" | "cancel";
      targetDate?: string;
      targetTimeSlot?: string;
      reason?: string;
    };

    if (!appointmentId || !action) {
      return reply.code(400).send(errorResponse("appointmentId and action are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (appt.status !== "disruption_triage") {
      return reply.code(400).send(errorResponse(`Appointment is not in disruption triage (current status: ${appt.status})`));
    }

    // Check patient authorization if user is authenticated
    if (req.user && req.user.role === "patient") {
      const { Patient } = await import("../models/Patient.ts");
      const patient = await Patient.findOne({ userId: req.user.id });
      if (patient && appt.patientId.toString() !== patient._id.toString() && appt.bookedByUserId?.toString() !== req.user.id) {
        return reply.code(403).send(errorResponse("Unauthorized to action this appointment"));
      }
    }

    const actorId = req.user?.id || "patient";

    if (action === "reschedule") {
      if (!targetDate) {
        return reply.code(400).send(errorResponse("targetDate is required for rescheduling"));
      }
      const result = await disruptionService.priorityReschedule({
        appointmentId,
        targetDate,
        targetTimeSlot,
        rescheduledByUserId: actorId,
        reason: reason || "Patient self-service reschedule following disruption",
      });
      return reply.code(200).send(successResponse(result, "Appointment rescheduled successfully"));
    } else if (action === "cancel") {
      const result = await disruptionService.cancelByDisruption({
        appointmentId,
        cancelledByUserId: actorId,
        reason: reason || "Patient self-service cancellation following disruption",
      });
      return reply.code(200).send(successResponse(result, "Appointment cancelled successfully"));
    } else {
      return reply.code(400).send(errorResponse("Invalid action. Must be 'reschedule' or 'cancel'"));
    }
  } catch (err: any) {
    console.error("patientDisruptionAction error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}
