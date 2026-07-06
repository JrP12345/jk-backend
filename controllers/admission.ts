import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Bed } from "../models/Bed.ts";
import { Admission } from "../models/Admission.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

// ─── Bed CRUD Handlers ───────────────────────────────────────────

export async function createBed(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can manage beds"));
    }

    const { clinicId, wardName, bedNumber, pricePerDay } = req.body as {
      clinicId: string;
      wardName: string;
      bedNumber: string;
      pricePerDay: number;
    };

    if (!clinicId || !wardName || !bedNumber || pricePerDay === undefined) {
      return reply.code(400).send(errorResponse("clinicId, wardName, bedNumber, and pricePerDay are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const bed = await Bed.create({
      clinicId,
      wardName,
      bedNumber,
      pricePerDay,
      status: "available",
      occupiedBy: null
    });

    return reply.code(201).send(successResponse(bed, "Bed created successfully"));
  } catch (err) {
    console.error("createBed error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getBeds(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId } = req.query as { clinicId?: string };

    const query: any = {};
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      query.clinicId = clinicId;
    }

    const beds = await Bed.find(query).populate({
      path: "occupiedBy",
      populate: { path: "userId", select: "name phone" }
    }).sort({ wardName: 1, bedNumber: 1 });

    return reply.code(200).send(successResponse(beds));
  } catch (err) {
    console.error("getBeds error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateBed(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can update beds"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid bed ID"));
    }

    const { wardName, bedNumber, pricePerDay, status } = req.body as {
      wardName?: string;
      bedNumber?: string;
      pricePerDay?: number;
      status?: "available" | "occupied" | "maintenance" | "reserved";
    };

    const bed = await Bed.findById(id);
    if (!bed) {
      return reply.code(404).send(errorResponse("Bed not found"));
    }

    if (wardName !== undefined) bed.wardName = wardName;
    if (bedNumber !== undefined) bed.bedNumber = bedNumber;
    if (pricePerDay !== undefined) bed.pricePerDay = pricePerDay;
    if (status !== undefined) {
      // If setting to available, ensure occupiedBy is cleared
      if (status === "available") {
        bed.occupiedBy = null;
      }
      bed.status = status;
    }

    await bed.save();
    return reply.code(200).send(successResponse(bed, "Bed updated successfully"));
  } catch (err) {
    console.error("updateBed error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteBed(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin") {
      return reply.code(403).send(errorResponse("Forbidden: Only admin can delete beds"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid bed ID"));
    }

    const bed = await Bed.findById(id);
    if (!bed) {
      return reply.code(404).send(errorResponse("Bed not found"));
    }

    if (bed.status === "occupied") {
      return reply.code(400).send(errorResponse("Cannot delete an occupied bed"));
    }

    await Bed.findByIdAndDelete(id);
    return reply.code(200).send(successResponse(null, "Bed deleted successfully"));
  } catch (err) {
    console.error("deleteBed error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Admission Handlers ───────────────────────────────────────────

export async function admitPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: Only providers can admit patients"));
    }

    const { clinicId, patientId, bedId, reasonForAdmission, doctorInCharge, notes } = req.body as {
      clinicId: string;
      patientId: string;
      bedId: string;
      reasonForAdmission: string;
      doctorInCharge: string;
      notes?: string;
    };

    if (!clinicId || !patientId || !bedId || !reasonForAdmission || !doctorInCharge) {
      return reply.code(400).send(errorResponse("Missing required fields: clinicId, patientId, bedId, reasonForAdmission, doctorInCharge"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId) || !mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(bedId) || !mongoose.Types.ObjectId.isValid(doctorInCharge)) {
      return reply.code(400).send(errorResponse("Invalid ObjectID reference"));
    }

    // Verify patient profile
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    // Verify bed is available
    const bed = await Bed.findById(bedId);
    if (!bed) {
      return reply.code(404).send(errorResponse("Bed not found"));
    }
    if (bed.status !== "available") {
      return reply.code(400).send(errorResponse(`Bed is currently ${bed.status}`));
    }

    // Update Bed status first
    bed.status = "occupied";
    bed.occupiedBy = patient._id;
    await bed.save();

    let admission: any = null;
    try {
      // Create admission
      admission = await Admission.create({
        clinicId,
        patientId,
        bedId,
        reasonForAdmission,
        doctorInCharge,
        status: "admitted",
        notes: notes || ""
      });
    } catch (saveError) {
      // Rollback bed status if admission creation fails
      bed.status = "available";
      bed.occupiedBy = null;
      await bed.save();
      throw saveError;
    }

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "PATIENT_ADMIT",
      targetId: admission._id,
      targetModel: "Admission",
      details: { bedNumber: bed.bedNumber, wardName: bed.wardName, reason: reasonForAdmission }
    });

    return reply.code(201).send(successResponse(admission, "Patient admitted successfully"));
  } catch (err) {
    console.error("admitPatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getAdmissions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { status, clinicId, page, limit } = req.query as {
      status?: string;
      clinicId?: string;
      page?: string | number;
      limit?: string | number;
    };

    const query: any = {};
    if (status) query.status = status;
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      query.clinicId = clinicId;
    }

    const totalCount = await Admission.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const admissions = await Admission.find(query)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
      .populate("bedId", "bedNumber wardName pricePerDay")
      .populate("doctorInCharge", "name specialization")
      .sort({ admissionDate: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(admissions));
  } catch (err) {
    console.error("getAdmissions error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function dischargePatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can discharge patients"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid admission ID"));
    }

    const admission = await Admission.findById(id);
    if (!admission) {
      return reply.code(404).send(errorResponse("Admission record not found"));
    }

    if (admission.status === "discharged") {
      return reply.code(400).send(errorResponse("Patient is already discharged"));
    }

    const bed = await Bed.findById(admission.bedId);
    if (!bed) {
      return reply.code(404).send(errorResponse("Associated bed not found"));
    }

    // 1. Release the bed
    const originalBedStatus = bed.status;
    const originalBedOccupant = bed.occupiedBy;

    bed.status = "available";
    bed.occupiedBy = null;
    await bed.save();

    let invoice: any = null;
    try {
      // 2. Calculate stay duration & billing amount
      const dischargeDate = new Date();
      const stayMs = dischargeDate.getTime() - admission.admissionDate.getTime();
      const stayDays = Math.max(1, Math.ceil(stayMs / (1000 * 60 * 60 * 24))); // Minimum 1 day charge
      const subtotal = stayDays * bed.pricePerDay;

      // 3. Generate sequential invoice
      const year = dischargeDate.getFullYear();
      const count = await Invoice.countDocuments();
      const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

      invoice = await Invoice.create({
        invoiceNumber,
        patientId: admission.patientId,
        clinicId: admission.clinicId,
        doctorId: admission.doctorInCharge, // Doctor in charge is responsible for care
        items: [
          {
            description: `Bed Occupancy Charge - Ward: ${bed.wardName}, Bed: ${bed.bedNumber} (${stayDays} Days)`,
            amount: bed.pricePerDay,
            quantity: stayDays
          }
        ],
        subtotal,
        tax: 0,
        discount: 0,
        totalAmount: subtotal,
        status: "unpaid"
      });

      // 4. Update Admission record
      admission.dischargeDate = dischargeDate;
      admission.status = "discharged";
      await admission.save();

      // Create Audit Log
      await AuditLog.create({
        userId,
        action: "PATIENT_DISCHARGE",
        targetId: admission._id,
        targetModel: "Admission",
        details: { bedNumber: bed.bedNumber, wardName: bed.wardName, stayDays, invoiceNumber }
      });

      return reply.code(200).send(successResponse({ admission, invoice }, "Patient discharged and billed successfully"));
    } catch (billingError) {
      // Rollback bed occupancy if billing/admission updates fail
      bed.status = originalBedStatus;
      bed.occupiedBy = originalBedOccupant;
      await bed.save();
      throw billingError;
    }
  } catch (err) {
    console.error("dischargePatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
