import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { FacilityTransfer } from "../models/FacilityTransfer.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function createFacilityTransfer(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const {
      patientId, sourceClinicId, targetClinicId, reasonForTransfer, priority, ambulanceDispatched, ambulanceVehicleNumber, transferNotes
    } = req.body as {
      patientId: string;
      sourceClinicId: string;
      targetClinicId: string;
      reasonForTransfer: string;
      priority?: "routine" | "urgent" | "emergency";
      ambulanceDispatched?: boolean;
      ambulanceVehicleNumber?: string;
      transferNotes?: string;
    };

    if (!patientId || !sourceClinicId || !targetClinicId || !reasonForTransfer) {
      return reply.code(400).send(errorResponse("patientId, sourceClinicId, targetClinicId, and reasonForTransfer are required"));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const seq = await getNextAtomicSequence(`transfer_${sourceClinicId}`);
    const transferNumber = `TRF-${new Date().getFullYear()}-${seq.toString().padStart(5, "0")}`;

    const transfer = await FacilityTransfer.create({
      transferNumber,
      patientId,
      sourceClinicId,
      targetClinicId,
      reasonForTransfer: reasonForTransfer.trim(),
      priority: priority || "routine",
      ambulanceDispatched: !!ambulanceDispatched,
      ambulanceVehicleNumber: ambulanceVehicleNumber?.trim(),
      transferNotes: transferNotes?.trim(),
      status: "requested",
    });

    await AuditLog.create({
      userId,
      action: "FACILITY_TRANSFER_CREATE",
      targetId: transfer._id,
      targetModel: "FacilityTransfer",
      details: { transferNumber, sourceClinicId, targetClinicId, priority }
    });

    return reply.code(201).send(successResponse(transfer, "Inter-facility patient transfer request dispatched"));
  } catch (err) {
    console.error("createFacilityTransfer error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFacilityTransfers(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, status, priority, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      filter.$or = [{ sourceClinicId: clinicId }, { targetClinicId: clinicId }];
    }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    const totalCount = await FacilityTransfer.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const transfers = await FacilityTransfer.find(filter)
      .populate("sourceClinicId", "name city")
      .populate("targetClinicId", "name city")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone" }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(transfers));
  } catch (err) {
    console.error("getFacilityTransfers error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateTransferStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { status, ambulanceVehicleNumber, transferNotes } = req.body as {
      status: "requested" | "accepted" | "in_transit" | "completed" | "rejected";
      ambulanceVehicleNumber?: string;
      transferNotes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Transfer ID"));
    }

    const transfer = await FacilityTransfer.findById(id);
    if (!transfer) {
      return reply.code(404).send(errorResponse("Facility transfer request not found"));
    }

    if (status) transfer.status = status;
    if (ambulanceVehicleNumber) {
      transfer.ambulanceVehicleNumber = ambulanceVehicleNumber.trim();
      transfer.ambulanceDispatched = true;
    }
    if (transferNotes) transfer.transferNotes = transferNotes.trim();

    await transfer.save();

    await AuditLog.create({
      userId,
      action: "FACILITY_TRANSFER_STATUS_UPDATE",
      targetId: transfer._id,
      targetModel: "FacilityTransfer",
      details: { transferNumber: transfer.transferNumber, status }
    });

    return reply.code(200).send(successResponse(transfer, `Facility transfer status updated to ${status}`));
  } catch (err) {
    console.error("updateTransferStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
