import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { OccupationalHealthRecord } from "../models/OccupationalHealthRecord.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getOccupationalRecords(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, recordType, fitnessStatus, search } = req.query as {
      clinicId?: string;
      recordType?: string;
      fitnessStatus?: string;
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

    if (recordType && recordType !== "ALL") query.recordType = recordType;
    if (fitnessStatus && fitnessStatus !== "ALL") query.fitnessStatus = fitnessStatus;

    if (search) {
      query.$or = [
        { employeeId: { $regex: search, $options: "i" } },
        { employeeName: { $regex: search, $options: "i" } },
        { department: { $regex: search, $options: "i" } },
        { examiningPhysician: { $regex: search, $options: "i" } },
      ];
    }

    const records = await OccupationalHealthRecord.find(query).sort({ examinationDate: -1 });

    // KPI Metrics
    const totalRecords = records.length;
    const fullyCompliantCount = records.filter((r) => r.immunizationStatus === "fully_compliant").length;
    const immunizationComplianceRate = totalRecords > 0 ? Math.round((fullyCompliantCount / totalRecords) * 100) : 100;
    const activeNeedleStickPEP = records.filter((r) => r.needleStickProtocolStatus === "post_exposure_prophylaxis").length;
    const fitForDutyCount = records.filter((r) => r.fitnessStatus === "fit_for_unrestricted_duty").length;

    return reply.code(200).send(
      successResponse({
        records,
        metrics: {
          totalRecords,
          immunizationComplianceRate,
          activeNeedleStickPEP,
          fitForDutyCount,
        },
      })
    );
  } catch (err) {
    console.error("getOccupationalRecords error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching occupational health records"));
  }
}

export async function createOccupationalRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      employeeId,
      employeeName,
      department,
      recordType,
      immunizationStatus,
      radiationDosimetrymSv,
      needleStickProtocolStatus,
      fitnessStatus,
      nextDueDate,
      examiningPhysician,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!employeeName || !recordType || !department?.trim() || !examiningPhysician?.trim()) {
      return reply.code(400).send(errorResponse("employeeName, department, recordType and examiningPhysician are required"));
    }

    const generatedEmpId = employeeId || `EMP-${Date.now().toString().slice(-5)}`;

    const newRecord = await OccupationalHealthRecord.create({
      organizationId: scope.organizationId || undefined,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      employeeId: generatedEmpId,
      employeeName,
      department: department.trim(),
      recordType,
      immunizationStatus: immunizationStatus || "fully_compliant",
      radiationDosimetrymSv: Number(radiationDosimetrymSv) || 0,
      needleStickProtocolStatus: needleStickProtocolStatus || "none",
      fitnessStatus: fitnessStatus || "fit_for_unrestricted_duty",
      examinationDate: new Date(),
      nextDueDate: nextDueDate ? new Date(nextDueDate) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      examiningPhysician: examiningPhysician.trim(),
      notes: notes || "",
    });

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "OCCUPATIONAL_RECORD_CREATE",
      targetId: newRecord._id,
      targetModel: "OccupationalHealthRecord",
      details: { employeeName, recordType, department }
    });

    return reply.code(201).send(successResponse(newRecord, "Occupational health record & staff wellness log created"));
  } catch (err) {
    console.error("createOccupationalRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating occupational health record"));
  }
}

export async function updateOccupationalStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { fitnessStatus, immunizationStatus, needleStickProtocolStatus, radiationDosimetrymSv, notes } = req.body as {
      fitnessStatus?: string;
      immunizationStatus?: string;
      needleStickProtocolStatus?: string;
      radiationDosimetrymSv?: number;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid occupational record ID"));
    }

    const record = await OccupationalHealthRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Occupational health record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (fitnessStatus) record.fitnessStatus = fitnessStatus as any;
    if (immunizationStatus) record.immunizationStatus = immunizationStatus as any;
    if (needleStickProtocolStatus) record.needleStickProtocolStatus = needleStickProtocolStatus as any;
    if (radiationDosimetrymSv !== undefined) record.radiationDosimetrymSv = Number(radiationDosimetrymSv);
    if (notes !== undefined) record.notes = notes;

    await record.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "OCCUPATIONAL_RECORD_STATUS_UPDATE",
      targetId: record._id,
      targetModel: "OccupationalHealthRecord",
      details: { employeeName: record.employeeName, fitnessStatus: record.fitnessStatus }
    });

    return reply.code(200).send(successResponse(record, "Staff occupational health record updated successfully"));
  } catch (err) {
    console.error("updateOccupationalStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating occupational record"));
  }
}

export async function deleteOccupationalRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid record ID"));
    }

    const record = await OccupationalHealthRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Occupational health record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    record.deletedAt = new Date();
    await record.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "OCCUPATIONAL_RECORD_DELETE",
      targetId: record._id,
      targetModel: "OccupationalHealthRecord",
      details: { employeeName: record.employeeName }
    });

    return reply.code(200).send(successResponse(record, "Occupational health record deleted successfully"));
  } catch (err) {
    console.error("deleteOccupationalRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting occupational health record"));
  }
}
