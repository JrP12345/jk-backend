import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { SterileTrayLog } from "../models/SterileTrayLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getCssdLogs(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, status, biologicalIndicatorStatus, search } = req.query as {
      clinicId?: string;
      status?: string;
      biologicalIndicatorStatus?: string;
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

    if (status && status !== "ALL") query.status = status;
    if (biologicalIndicatorStatus && biologicalIndicatorStatus !== "ALL") query.biologicalIndicatorStatus = biologicalIndicatorStatus;

    if (search) {
      query.$or = [
        { trayBarcode: { $regex: search, $options: "i" } },
        { trayName: { $regex: search, $options: "i" } },
        { sterilizationCycleNo: { $regex: search, $options: "i" } },
        { technicianName: { $regex: search, $options: "i" } },
        { targetDepartment: { $regex: search, $options: "i" } },
      ];
    }

    const logs = await SterileTrayLog.find(query).sort({ sterilizationDate: -1 });

    // KPI Metrics
    const totalPacks = logs.length;
    const activeAutoclaveRuns = logs.filter((l) => l.status === "sterilizing").length;
    const indicatorPasses = logs.filter((l) => l.biologicalIndicatorStatus === "passed").length;
    const indicatorPassRateRate = totalPacks > 0 ? Math.round((indicatorPasses / totalPacks) * 100) : 100;
    const issuedToOr = logs.filter((l) => l.status === "issued_to_or").length;

    return reply.code(200).send(
      successResponse({
        logs,
        metrics: {
          totalPacks,
          activeAutoclaveRuns,
          indicatorPassRateRate,
          issuedToOr,
        },
      })
    );
  } catch (err) {
    console.error("getCssdLogs error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching CSSD sterilization logs"));
  }
}

export async function createSterileTrayLog(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      trayBarcode,
      trayName,
      autoclaveUnitId,
      sterilizationCycleNo,
      sterilizationMethod,
      biologicalIndicatorStatus,
      chemicalIndicatorColor,
      expirationDays,
      status,
      targetDepartment,
      technicianName,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId) || !trayName?.trim() || !autoclaveUnitId?.trim() || !sterilizationCycleNo?.trim() || !targetDepartment?.trim() || !technicianName?.trim() || expirationDays === undefined) {
      return reply.code(400).send(errorResponse("clinicId, trayName, autoclaveUnitId, sterilizationCycleNo, expirationDays, targetDepartment, and technicianName are required"));
    }

    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const generatedBarcode = trayBarcode || `TRAY-${Date.now().toString().slice(-6)}`;
    const generatedCycle = sterilizationCycleNo || `CYC-${Date.now().toString().slice(-6)}`;

    // Expiration date (default 30 days from sterilization date)
    const expDaysNum = Number(expirationDays) || 30;
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + expDaysNum);

    const newLog = await SterileTrayLog.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(clinicId),
      trayBarcode: generatedBarcode,
      trayName: trayName.trim(),
      autoclaveUnitId: autoclaveUnitId.trim(),
      sterilizationCycleNo: sterilizationCycleNo.trim(),
      sterilizationMethod: sterilizationMethod || "steam_autoclave",
      biologicalIndicatorStatus: biologicalIndicatorStatus || "passed",
      chemicalIndicatorColor: chemicalIndicatorColor || "black_pass",
      sterilizationDate: new Date(),
      expirationDate: expDate,
      status: status || "sterile_storage",
      targetDepartment: targetDepartment.trim(),
      technicianName: technicianName.trim(),
      notes: notes || "",
    });

    return reply.code(201).send(successResponse(newLog, "Sterile tray batch logged & autoclave cycle recorded"));
  } catch (err) {
    console.error("createSterileTrayLog error:", err);
    return reply.code(500).send(errorResponse("Internal server error logging CSSD tray batch"));
  }
}

export async function updateTrayStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { status, biologicalIndicatorStatus, chemicalIndicatorColor, targetDepartment, notes } = req.body as {
      status?: string;
      biologicalIndicatorStatus?: string;
      chemicalIndicatorColor?: string;
      targetDepartment?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid tray log ID"));
    }

    const log = await SterileTrayLog.findById(id);
    if (!log || log.deletedAt) {
      return reply.code(404).send(errorResponse("Sterile tray log not found"));
    }

    const scope = await checkOperationalRecordAccess(req, log);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (status) log.status = status as any;
    if (biologicalIndicatorStatus) log.biologicalIndicatorStatus = biologicalIndicatorStatus as any;
    if (chemicalIndicatorColor) log.chemicalIndicatorColor = chemicalIndicatorColor as any;
    if (targetDepartment) log.targetDepartment = targetDepartment;
    if (notes !== undefined) log.notes = notes;

    await log.save();
    return reply.code(200).send(successResponse(log, "Sterile tray status updated successfully"));
  } catch (err) {
    console.error("updateTrayStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating CSSD tray status"));
  }
}

export async function deleteSterileTrayLog(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid tray log ID"));
    }

    const log = await SterileTrayLog.findById(id);
    if (!log || log.deletedAt) {
      return reply.code(404).send(errorResponse("Sterile tray log not found"));
    }

    const scope = await checkOperationalRecordAccess(req, log);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    log.deletedAt = new Date();
    await log.save();

    return reply.code(200).send(successResponse(log, "Sterile tray log deleted successfully"));
  } catch (err) {
    console.error("deleteSterileTrayLog error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting CSSD tray log"));
  }
}
