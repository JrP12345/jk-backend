import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Bed } from "../models/Bed.ts";
import { Admission } from "../models/Admission.ts";
import { Patient } from "../models/Patient.ts";
import { Doctor } from "../models/Doctor.ts";
import { User } from "../models/User.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, getRequestClinicIds } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

// ─── Bed CRUD Handlers ───────────────────────────────────────────

export async function createBed(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "root") {
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

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

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
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      query.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) query.clinicId = { $in: clinicIds };
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
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "root") {
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
    const bedAccess = await checkOperationalRecordAccess(req, bed);
    if (!bedAccess.allowed) return sendTenantError(reply, bedAccess);

    if (wardName !== undefined) bed.wardName = wardName;
    if (bedNumber !== undefined) bed.bedNumber = bedNumber;
    if (pricePerDay !== undefined) bed.pricePerDay = pricePerDay;
    if (status !== undefined) {
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
    if (userRole !== "admin" && userRole !== "root") {
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
    const bedAccess = await checkOperationalRecordAccess(req, bed);
    if (!bedAccess.allowed) return sendTenantError(reply, bedAccess);

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

// ─── Admission Handlers (ACID Transactional) ───────────────────────

export async function admitPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor" && userRole !== "root") {
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

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    // Verify patient profile
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (patient.organizationId && clinicAccess.organizationId && patient.organizationId.toString() !== clinicAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (!patient.organizationId && clinicAccess.organizationId) {
      patient.organizationId = new mongoose.Types.ObjectId(clinicAccess.organizationId);
      await patient.save();
    }

    // Verify bed is available
    const bed = await Bed.findById(bedId);
    if (!bed) {
      return reply.code(404).send(errorResponse("Bed not found"));
    }
    if (bed.clinicId.toString() !== clinicId) {
      return reply.code(404).send(errorResponse("Bed not found in selected clinic"));
    }
    if (bed.status !== "available") {
      return reply.code(400).send(errorResponse(`Bed is currently ${bed.status}`));
    }

    // Check if patient is already actively admitted
    const existingAdmission = await Admission.findOne({
      patientId,
      clinicId,
      status: "admitted",
      deletedAt: null,
    });
    if (existingAdmission) {
      return reply.code(400).send(errorResponse("Patient is already actively admitted in another ward bed"));
    }

    return await withTransaction(async (session) => {
      const option = session ? { session } : {};

      // 1. Update Bed status
      bed.status = "occupied";
      bed.occupiedBy = patient._id;
      await bed.save(option);

      // 2. Create Admission record
      const [admission] = await Admission.create(
        [
          {
            clinicId,
            patientId,
            bedId,
            reasonForAdmission,
            doctorInCharge,
            organizationId: clinicAccess.organizationId || undefined,
            status: "admitted",
            notes: notes || ""
          }
        ],
        option
      );

      // 3. Create Audit Log
      await AuditLog.create(
        [
          {
            userId,
            action: "PATIENT_ADMIT",
            targetId: admission._id,
            targetModel: "Admission",
            details: { bedNumber: bed.bedNumber, wardName: bed.wardName, reason: reasonForAdmission }
          }
        ],
        option
      );

      return reply.code(201).send(successResponse(admission, "Patient admitted successfully"));
    });
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
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) query.clinicId = { $in: clinicIds };
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

    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor" && userRole !== "root") {
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
    const admissionAccess = await checkOperationalRecordAccess(req, admission);
    if (!admissionAccess.allowed) return sendTenantError(reply, admissionAccess);

    if (admission.status === "discharged") {
      return reply.code(400).send(errorResponse("Patient is already discharged"));
    }

    const bed = await Bed.findById(admission.bedId);
    if (!bed) {
      return reply.code(404).send(errorResponse("Associated bed not found"));
    }
    const bedAccess = await checkOperationalRecordAccess(req, bed);
    if (!bedAccess.allowed) return sendTenantError(reply, bedAccess);

    return await withTransaction(async (session) => {
      const option = session ? { session } : {};

      // 1. Release bed
      bed.status = "available";
      bed.occupiedBy = null;
      await bed.save(option);

      // 2. Calculate stay duration & billing amount
      const dischargeDate = new Date();
      const stayMs = dischargeDate.getTime() - admission.admissionDate.getTime();
      const stayDays = Math.max(1, Math.ceil(stayMs / (1000 * 60 * 60 * 24)));
      const subtotal = stayDays * bed.pricePerDay;

      // 3. Generate sequential invoice
      const year = dischargeDate.getFullYear();
      const count = await Invoice.countDocuments({}, option);
      const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

      const [invoice] = await Invoice.create(
        [
          {
            invoiceNumber,
            patientId: admission.patientId,
            clinicId: admission.clinicId,
            organizationId: admissionAccess.organizationId || undefined,
            doctorId: admission.doctorInCharge,
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
          }
        ],
        option
      );

      // 4. Update Admission record
      admission.dischargeDate = dischargeDate;
      admission.status = "discharged";
      await admission.save(option);

      // 5. Create Audit Log
      await AuditLog.create(
        [
          {
            userId,
            action: "PATIENT_DISCHARGE",
            targetId: admission._id,
            targetModel: "Admission",
            details: { bedNumber: bed.bedNumber, wardName: bed.wardName, stayDays, invoiceNumber }
          }
        ],
        option
      );

      return reply.code(200).send(successResponse({ admission, invoice }, "Patient discharged and billed successfully"));
    });
  } catch (err) {
    console.error("dischargePatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Ward Hierarchy & Bed Matrix Board ─────────────────────────
export async function getWardHierarchyBoard(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId } = req.query as { clinicId?: string };

    const filter: any = {};
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      filter.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) filter.clinicId = { $in: clinicIds };
    }

    const beds = await Bed.find(filter)
      .populate({
        path: "occupiedBy",
        populate: { path: "userId", select: "name phone email" }
      })
      .sort({ floor: 1, wardName: 1, bedNumber: 1 });

    const hierarchy: Record<string, Record<string, any[]>> = {};

    let totalBeds = 0;
    let totalAvailable = 0;
    let totalOccupied = 0;
    let totalMaintenance = 0;

    beds.forEach((bed: any) => {
      totalBeds++;
      if (bed.status === "available") totalAvailable++;
      else if (bed.status === "occupied") totalOccupied++;
      else if (bed.status === "maintenance") totalMaintenance++;

      const floorKey = bed.floor || "Ground Floor";
      const wardKey = bed.wardName || "General Ward";

      if (!hierarchy[floorKey]) hierarchy[floorKey] = {};
      if (!hierarchy[floorKey][wardKey]) hierarchy[floorKey][wardKey] = [];

      hierarchy[floorKey][wardKey].push(bed);
    });

    const occupancyRate = totalBeds > 0 ? Math.round((totalOccupied / totalBeds) * 100) : 0;

    return reply.code(200).send(
      successResponse({
        summary: {
          totalBeds,
          totalAvailable,
          totalOccupied,
          totalMaintenance,
          occupancyRatePercent: occupancyRate,
        },
        hierarchy,
      })
    );
  } catch (err) {
    console.error("getWardHierarchyBoard error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function transferBed(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only providers can transfer patient beds"));
    }

    const { id } = req.params as { id: string };
    const { targetBedId, reason } = req.body as { targetBedId: string; reason?: string };

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(targetBedId)) {
      return reply.code(400).send(errorResponse("Invalid ObjectID reference"));
    }

    const admission = await Admission.findById(id);
    if (!admission) {
      return reply.code(404).send(errorResponse("Admission record not found"));
    }
    const admissionAccess = await checkOperationalRecordAccess(req, admission);
    if (!admissionAccess.allowed) return sendTenantError(reply, admissionAccess);
    if (admission.status !== "admitted") {
      return reply.code(400).send(errorResponse("Cannot transfer a discharged patient"));
    }

    const targetBed = await Bed.findById(targetBedId);
    if (!targetBed) {
      return reply.code(404).send(errorResponse("Target bed not found"));
    }
    const targetBedAccess = await checkOperationalRecordAccess(req, targetBed);
    if (!targetBedAccess.allowed) return sendTenantError(reply, targetBedAccess);
    if (targetBed.clinicId.toString() !== admission.clinicId.toString()) {
      return reply.code(404).send(errorResponse("Target bed not found in admission clinic"));
    }
    if (targetBed.status !== "available") {
      return reply.code(400).send(errorResponse(`Target bed is currently ${targetBed.status}`));
    }

    const oldBedId = admission.bedId;
    const oldBed = await Bed.findById(oldBedId);
    if (oldBed) {
      const oldBedAccess = await checkOperationalRecordAccess(req, oldBed);
      if (!oldBedAccess.allowed) return sendTenantError(reply, oldBedAccess);
    }

    return await withTransaction(async (session) => {
      const option = session ? { session } : {};

      if (oldBed) {
        oldBed.status = "available";
        oldBed.occupiedBy = null;
        await oldBed.save(option);
      }

      targetBed.status = "occupied";
      targetBed.occupiedBy = admission.patientId;
      await targetBed.save(option);

      admission.bedId = targetBed._id as any;
      if (reason) {
        admission.notes = admission.notes
          ? `${admission.notes}\n[Bed Transfer] ${new Date().toISOString()}: Transferred from ${oldBed?.bedNumber || "old bed"} to ${targetBed.bedNumber}. Reason: ${reason}`
          : `[Bed Transfer] ${new Date().toISOString()}: Transferred to ${targetBed.bedNumber}. Reason: ${reason}`;
      }
      await admission.save(option);

      await AuditLog.create(
        [
          {
            userId,
            action: "PATIENT_BED_TRANSFER",
            targetId: admission._id,
            targetModel: "Admission",
            details: {
              fromBed: oldBed?.bedNumber,
              toBed: targetBed.bedNumber,
              wardName: targetBed.wardName,
              reason: reason || "Routine ward transfer",
            },
          },
        ],
        option
      );

      return reply.code(200).send(successResponse({ admission, bed: targetBed }, "Patient transferred to new bed successfully"));
    });
  } catch (err) {
    console.error("transferBed error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

