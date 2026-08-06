import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { HBOTSession } from "../models/HBOTSession.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getHBOTSessions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, indication, sessionStatus, search } = req.query as {
      clinicId?: string;
      indication?: string;
      sessionStatus?: string;
      search?: string;
    };

    const query: any = {
      deletedAt: null,
    };

    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      query.clinicId = new mongoose.Types.ObjectId(clinicId);
    } else if (user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      query.organizationId = new mongoose.Types.ObjectId(orgId);
    }

    if (indication && indication !== "ALL") query.indication = indication;
    if (sessionStatus && sessionStatus !== "ALL") query.sessionStatus = sessionStatus;

    if (search) {
      query.$or = [
        { patientName: { $regex: search, $options: "i" } },
        { chamberId: { $regex: search, $options: "i" } },
        { supervisingPhysician: { $regex: search, $options: "i" } },
        { chamberOperator: { $regex: search, $options: "i" } },
      ];
    }

    const sessions = await HBOTSession.find(query).sort({ updatedAt: -1 });

    // Metrics
    const totalSessions = sessions.length;
    const activeSessions = sessions.filter(
      (s) => s.sessionStatus === "compressing" || s.sessionStatus === "at_depth_treatment" || s.sessionStatus === "decompressing"
    ).length;

    const clearedCount = sessions.filter((s) => s.barotraumaSafetyCleared).length;
    const barotraumaClearedRate = totalSessions > 0 ? Math.round((clearedCount / totalSessions) * 100) : 100;

    const totalMinutesCompleted = sessions
      .filter((s) => s.sessionStatus === "completed")
      .reduce((acc, s) => acc + (s.sessionDurationMinutes || 90), 0);
    const completedHBOTHours = Math.round((totalMinutesCompleted / 60) * 10) / 10;

    return reply.code(200).send(
      successResponse({
        sessions,
        metrics: {
          totalSessions,
          activeSessions,
          barotraumaClearedRate,
          completedHBOTHours,
        },
      })
    );
  } catch (err) {
    console.error("getHBOTSessions error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching HBOT sessions"));
  }
}

export async function createHBOTSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      chamberId,
      patientName,
      indication,
      pressureATA,
      sessionDurationMinutes,
      barotraumaSafetyCleared,
      supervisingPhysician,
      chamberOperator,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!patientName || !indication || !supervisingPhysician?.trim() || !chamberOperator?.trim()) {
      return reply.code(400).send(errorResponse("patientName, indication, supervisingPhysician and chamberOperator are required"));
    }

    const newSession = await HBOTSession.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      chamberId,
      patientName,
      indication,
      pressureATA: Number(pressureATA) || 2.4,
      sessionDurationMinutes: Number(sessionDurationMinutes) || 90,
      barotraumaSafetyCleared: barotraumaSafetyCleared !== undefined ? Boolean(barotraumaSafetyCleared) : true,
      sessionStatus: "scheduled",
      supervisingPhysician: supervisingPhysician.trim(),
      chamberOperator: chamberOperator.trim(),
      notes: notes || "",
    });

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HBOT_SESSION_CREATE",
      targetId: newSession._id,
      targetModel: "HBOTSession",
      details: { patientName: newSession.patientName, indication: newSession.indication, pressureATA: newSession.pressureATA }
    });

    return reply.code(201).send(successResponse(newSession, "Hyperbaric oxygen compression session scheduled successfully"));
  } catch (err) {
    console.error("createHBOTSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating HBOT session"));
  }
}

export async function updateHBOTStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { sessionStatus, barotraumaSafetyCleared, notes } = req.body as {
      sessionStatus?: string;
      barotraumaSafetyCleared?: boolean;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid HBOT session ID"));
    }

    const session = await HBOTSession.findById(id);
    if (!session || session.deletedAt) {
      return reply.code(404).send(errorResponse("HBOT session not found"));
    }
    const scope = await checkOperationalRecordAccess(req, session);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (sessionStatus) session.sessionStatus = sessionStatus as any;
    if (barotraumaSafetyCleared !== undefined) session.barotraumaSafetyCleared = Boolean(barotraumaSafetyCleared);
    if (notes !== undefined) session.notes = notes;

    await session.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HBOT_SESSION_STATUS_UPDATE",
      targetId: session._id,
      targetModel: "HBOTSession",
      details: { patientName: session.patientName, sessionStatus: session.sessionStatus }
    });

    return reply.code(200).send(successResponse(session, "Hyperbaric chamber session status updated"));
  } catch (err) {
    console.error("updateHBOTStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating HBOT session status"));
  }
}

export async function deleteHBOTSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid session ID"));
    }

    const session = await HBOTSession.findById(id);
    if (!session || session.deletedAt) {
      return reply.code(404).send(errorResponse("HBOT session not found"));
    }
    const scope = await checkOperationalRecordAccess(req, session);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    session.deletedAt = new Date();
    await session.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HBOT_SESSION_DELETE",
      targetId: session._id,
      targetModel: "HBOTSession",
      details: { patientName: session.patientName }
    });

    return reply.code(200).send(successResponse(session, "HBOT session deleted successfully"));
  } catch (err) {
    console.error("deleteHBOTSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting HBOT session"));
  }
}
