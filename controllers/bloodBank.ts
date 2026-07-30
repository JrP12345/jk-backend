import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { BloodBankUnit } from "../models/BloodBankUnit.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

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
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) filter.clinicId = clinicId;
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

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const now = new Date();
    const availableUnits = await BloodBankUnit.find({
      bloodGroup,
      status: "available",
      expiryDate: { $gt: now },
    })
      .sort({ expiryDate: 1 })
      .limit(requiredUnits);

    if (availableUnits.length < requiredUnits) {
      return reply.code(409).send(errorResponse(`Cross-match failed: Insufficient unexpired ${bloodGroup} blood units in stock. Available: ${availableUnits.length}, Requested: ${requiredUnits}`));
    }

    const reservedIds: string[] = [];
    for (const unit of availableUnits) {
      unit.status = "reserved";
      unit.reservedForPatientId = new mongoose.Types.ObjectId(patientId);
      await unit.save();
      reservedIds.push(unit.unitNumber);
    }

    await AuditLog.create({
      userId,
      action: "BLOOD_CROSS_MATCH_RESERVE",
      targetId: patient._id,
      targetModel: "Patient",
      details: { bloodGroup, requiredUnits, reservedUnits: reservedIds }
    });

    return reply.code(200).send(
      successResponse({
        reservedCount: reservedIds.length,
        reservedUnits: reservedIds,
      }, `Cross-matching verified! ${reservedIds.length} units of ${bloodGroup} blood reserved for patient.`)
    );
  } catch (err) {
    console.error("crossMatchAndReserve error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
