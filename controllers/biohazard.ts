import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { BiohazardWasteLog } from "../models/BiohazardWasteLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getBiohazardLogs(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, wasteCategory, status, search } = req.query as {
      clinicId?: string;
      wasteCategory?: string;
      status?: string;
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

    if (wasteCategory && wasteCategory !== "ALL") query.wasteCategory = wasteCategory;
    if (status && status !== "ALL") query.status = status;

    if (search) {
      query.$or = [
        { manifestNumber: { $regex: search, $options: "i" } },
        { originDepartment: { $regex: search, $options: "i" } },
        { disposalVendor: { $regex: search, $options: "i" } },
        { loggedBy: { $regex: search, $options: "i" } },
      ];
    }

    const logs = await BiohazardWasteLog.find(query).sort({ createdAt: -1 });

    // KPI Metrics
    const totalMassKg = logs.reduce((acc, curr) => acc + (curr.weightKg || 0), 0);
    const holdingMassKg = logs
      .filter((l) => l.status === "collected" || l.status === "stored_in_holding")
      .reduce((acc, curr) => acc + (curr.weightKg || 0), 0);
    const incinerationMassKg = logs
      .filter((l) => l.disposalMethod === "incineration")
      .reduce((acc, curr) => acc + (curr.weightKg || 0), 0);
    const completedDisposalsCount = logs.filter((l) => l.status === "processed_disposed").length;

    return reply.code(200).send(
      successResponse({
        logs,
        metrics: {
          totalLogs: logs.length,
          totalMassKg: Number(totalMassKg.toFixed(2)),
          holdingMassKg: Number(holdingMassKg.toFixed(2)),
          incinerationMassKg: Number(incinerationMassKg.toFixed(2)),
          completedDisposalsCount,
        },
      })
    );
  } catch (err) {
    console.error("getBiohazardLogs error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching biohazard logs"));
  }
}

export async function createBiohazardLog(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      manifestNumber,
      wasteCategory,
      weightKg,
      originDepartment,
      disposalMethod,
      status,
      disposalVendor,
      loggedBy,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId) || !manifestNumber?.trim() || !wasteCategory || weightKg === undefined || !originDepartment?.trim() || !disposalMethod || !disposalVendor?.trim()) {
      return reply.code(400).send(errorResponse("clinicId, manifestNumber, wasteCategory, weightKg, originDepartment, disposalMethod, and disposalVendor are required"));
    }

    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const newLog = await BiohazardWasteLog.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(clinicId),
      manifestNumber: manifestNumber.trim(),
      wasteCategory,
      weightKg: Number(weightKg),
      originDepartment: originDepartment.trim(),
      disposalMethod,
      status: status || "collected",
      disposalVendor: disposalVendor.trim(),
      loggedBy: loggedBy?.trim() || user!.name,
      notes: notes || "",
    });

    return reply.code(201).send(successResponse(newLog, "Biohazard waste manifest logged successfully"));
  } catch (err) {
    console.error("createBiohazardLog error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating biohazard log"));
  }
}

export async function updateBiohazardStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { status, disposalVendor, notes } = req.body as {
      status?: string;
      disposalVendor?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid biohazard log ID"));
    }

    const log = await BiohazardWasteLog.findById(id);
    if (!log || log.deletedAt) {
      return reply.code(404).send(errorResponse("Biohazard log not found"));
    }

    const scope = await checkOperationalRecordAccess(req, log);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (status) {
      log.status = status as any;
      if (status === "processed_disposed") {
        log.disposedDate = new Date();
      }
    }
    if (disposalVendor) log.disposalVendor = disposalVendor;
    if (notes !== undefined) log.notes = notes;

    await log.save();
    return reply.code(200).send(successResponse(log, "Biohazard status updated successfully"));
  } catch (err) {
    console.error("updateBiohazardStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating biohazard log status"));
  }
}

export async function deleteBiohazardLog(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid biohazard log ID"));
    }

    const log = await BiohazardWasteLog.findById(id);
    if (!log || log.deletedAt) {
      return reply.code(404).send(errorResponse("Biohazard log not found"));
    }

    const scope = await checkOperationalRecordAccess(req, log);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    log.deletedAt = new Date();
    await log.save();

    return reply.code(200).send(successResponse(log, "Biohazard log deleted successfully"));
  } catch (err) {
    console.error("deleteBiohazardLog error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting biohazard log"));
  }
}
