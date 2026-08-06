import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { BloodBankUnit } from "../models/BloodBankUnit.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestClinicIds } from "../utilities/tenant.ts";
import { checkPatientAccess } from "../utilities/tenant.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";

export async function registerBloodUnit(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { unitNumber, clinicId, bloodGroup, componentType, volumeMl, expiryDate } = req.body as {
      unitNumber: string;
      clinicId: string;
      bloodGroup: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-";
      componentType?: "whole_blood" | "prbc" | "ffp" | "platelets";
      volumeMl: number;
      expiryDate: string;
    };

    if (!unitNumber || !clinicId || !bloodGroup || !volumeMl || !expiryDate) {
      return reply.code(400).send(errorResponse("unitNumber, clinicId, bloodGroup, volumeMl, and expiryDate are required"));
    }

    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const unit = await BloodBankUnit.create({
      unitNumber: unitNumber.trim(),
      clinicId,
      bloodGroup,
      componentType: componentType || "prbc",
      volumeMl,
      expiryDate: new Date(expiryDate),
      status: "available",
    });

    await AuditLog.create({
      userId,
      action: "BLOOD_UNIT_REGISTER",
      targetId: unit._id,
      targetModel: "BloodBankUnit",
      details: { unitNumber, bloodGroup, componentType, volumeMl }
    });

    return reply.code(201).send(successResponse(unit, "Blood bank unit registered in inventory successfully"));
  } catch (err) {
    console.error("registerBloodUnit error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getBloodUnits(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, bloodGroup, status, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      filter.clinicId = clinicId;
    } else if (req.user?.role !== "root") {
      filter.clinicId = { $in: await getRequestClinicIds(req) };
    }
    if (bloodGroup) filter.bloodGroup = bloodGroup;
    if (status) filter.status = status;

    const totalCount = await BloodBankUnit.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const units = await BloodBankUnit.find(filter)
      .populate("clinicId", "name city")
      .populate({
        path: "reservedForPatientId",
        populate: { path: "userId", select: "name phone" }
      })
      .sort({ expiryDate: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(units));
  } catch (err) {
    console.error("getBloodUnits error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function crossMatchAndReserve(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { patientId, bloodGroup, requiredUnits } = req.body as {
      patientId: string;
      bloodGroup: string;
      requiredUnits: number;
    };

    if (!patientId || !bloodGroup || !requiredUnits || requiredUnits <= 0) {
      return reply.code(400).send(errorResponse("patientId, bloodGroup, and requiredUnits are required"));
    }

    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    if (req.user?.role !== "root" && patient.organizationId && patientAccess.organizationId && patient.organizationId.toString() !== patientAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const COMPATIBLE_DONORS: Record<string, string[]> = {
      "O-": ["O-"],
      "O+": ["O-", "O+"],
      "A-": ["O-", "A-"],
      "A+": ["O-", "O+", "A-", "A+"],
      "B-": ["O-", "B-"],
      "B+": ["O-", "O+", "B-", "B+"],
      "AB-": ["O-", "A-", "B-", "AB-"],
      "AB+": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"],
    };

    const now = new Date();
    const allowedGroups = COMPATIBLE_DONORS[bloodGroup] || [bloodGroup];

    const unitFilter: any = {
      bloodGroup: { $in: allowedGroups as any },
      status: "available",
      expiryDate: { $gt: now },
    };
    if (req.user?.role !== "root") unitFilter.clinicId = { $in: await getRequestClinicIds(req) };

    const reservedIds = await withTransaction(async (session) => {
      const availableUnits = await BloodBankUnit.find(unitFilter)
        .sort({ expiryDate: 1 })
        .limit(requiredUnits)
        .session(session);

      if (availableUnits.length < requiredUnits) {
        const error: any = new Error(`Cross-match failed: Insufficient compatible blood units in stock for recipient group ${bloodGroup}. Available: ${availableUnits.length}, Requested: ${requiredUnits}`);
        error.statusCode = 409;
        throw error;
      }

      const originalStates = availableUnits.map((unit) => ({
        unit,
        status: unit.status,
        reservedForPatientId: unit.reservedForPatientId,
      }));
      const reservedUnitNumbers = availableUnits.map((unit) => unit.unitNumber);
      try {
        for (const unit of availableUnits) {
          unit.status = "reserved";
          unit.reservedForPatientId = new mongoose.Types.ObjectId(patientId);
          await unit.save(session ? { session } : undefined);
        }

        await createWithSession(AuditLog, {
          userId,
          action: "BLOOD_CROSS_MATCH_RESERVE",
          targetId: patient._id,
          targetModel: "Patient",
          organizationId: patientAccess.organizationId || undefined,
          details: { bloodGroup, requiredUnits, reservedUnits: reservedUnitNumbers }
        }, session);
        return reservedUnitNumbers;
      } catch (error) {
        if (!session) {
          for (const original of originalStates) {
            original.unit.status = original.status;
            original.unit.reservedForPatientId = original.reservedForPatientId;
            await original.unit.save();
          }
        }
        throw error;
      }
    });

    return reply.code(200).send(
      successResponse({
        reservedCount: reservedIds.length,
        reservedUnits: reservedIds,
      }, `Cross-matching verified! ${reservedIds.length} units of ${bloodGroup} blood reserved for patient.`)
    );
  } catch (err: any) {
    console.error("crossMatchAndReserve error:", err);
    if (err?.statusCode === 409) return reply.code(409).send(errorResponse(err.message));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateBloodUnitStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: "available" | "reserved" | "transfused" | "expired" | "discarded" };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Blood Unit ID"));
    }

    if (!status || !["available", "reserved", "transfused", "expired", "discarded"].includes(status)) {
      return reply.code(400).send(errorResponse("Valid status (available, reserved, transfused, expired, discarded) is required"));
    }

    const unit = await BloodBankUnit.findById(id);
    if (!unit) {
      return reply.code(404).send(errorResponse("Blood unit not found"));
    }

    const scope = await checkOperationalRecordAccess(req, unit);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const previousStatus = unit.status;
    unit.status = status;
    if (status === "available" || status === "discarded") {
      unit.reservedForPatientId = undefined;
    }

    await unit.save();

    await AuditLog.create({
      userId,
      action: "BLOOD_UNIT_STATUS_UPDATE",
      targetId: unit._id,
      targetModel: "BloodBankUnit",
      details: { unitNumber: unit.unitNumber, previousStatus, newStatus: status }
    });

    return reply.code(200).send(successResponse(unit, `Blood unit status updated to ${status}`));
  } catch (err) {
    console.error("updateBloodUnitStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
