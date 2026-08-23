import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Prescription } from "../models/Prescription.ts";
import { Appointment } from "../models/Appointment.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, getRequestClinicIds } from "../utilities/tenant.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

// ─── Medicine CRUD Handlers ─────────────────────────────────────

export async function createMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const {
      clinicId, name, genericName, stockQuantity, price, costPrice,
      expiryDate, batchNumber, manufacturer, category, scheduleType
    } = req.body as any;

    if (!clinicId || !name || !genericName || stockQuantity === undefined || price === undefined || costPrice === undefined || !expiryDate || !batchNumber) {
      return reply.code(400).send(errorResponse("All fields (clinicId, name, genericName, stockQuantity, price, costPrice, expiryDate, batchNumber) are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }
    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
    if (!Number.isInteger(stockQuantity) || stockQuantity < 0 || !Number.isFinite(price) || price < 0 || !Number.isFinite(costPrice) || costPrice < 0) {
      return reply.code(400).send(errorResponse("Stock and prices must be non-negative numbers; stock must be an integer"));
    }
    const parsedExpiryDate = new Date(expiryDate);
    if (Number.isNaN(parsedExpiryDate.getTime())) {
      return reply.code(400).send(errorResponse("Invalid expiry date"));
    }

    const medicine = await Medicine.create({
      clinicId,
      name,
      genericName,
      stockQuantity,
      price,
      costPrice,
      expiryDate: parsedExpiryDate,
      batchNumber,
      manufacturer: manufacturer?.trim() || undefined,
      category: category || "tablet",
      scheduleType: scheduleType || "general",
    });

    return reply.code(201).send(successResponse(medicine, "Medicine registered successfully"));
  } catch (err) {
    console.error("createMedicine error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getMedicines(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, search, page, limit } = req.query as { clinicId?: string; search?: string; page?: string | number; limit?: string | number };

    const query: any = { deletedAt: null };
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

    if (search) {
      const safeSearch = escapeRegex(search);
      query.$or = [
        { name: { $regex: safeSearch, $options: "i" } },
        { genericName: { $regex: safeSearch, $options: "i" } }
      ];
    }

    const totalCount = await Medicine.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const medicines = await Medicine.find(query)
      .sort({ name: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(medicines));
  } catch (err) {
    console.error("getMedicines error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const { name, genericName, stockQuantity, price, costPrice, expiryDate, batchNumber, manufacturer, category, scheduleType } = req.body as any;

    const medicine: any = await Medicine.findOne({ _id: id, deletedAt: null });
    if (!medicine) {
      return reply.code(404).send(errorResponse("Medicine not found"));
    }
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);

    if (name !== undefined) medicine.name = name;
    if (genericName !== undefined) medicine.genericName = genericName;
    if (stockQuantity !== undefined) medicine.stockQuantity = stockQuantity;
    if (price !== undefined) medicine.price = price;
    if (costPrice !== undefined) medicine.costPrice = costPrice;
    if (expiryDate !== undefined) medicine.expiryDate = new Date(expiryDate);
    if (batchNumber !== undefined) medicine.batchNumber = batchNumber;
    if (manufacturer !== undefined) medicine.manufacturer = manufacturer;
    if (category !== undefined) medicine.category = category;
    if (scheduleType !== undefined) medicine.scheduleType = scheduleType;

    await medicine.save();
    return reply.code(200).send(successResponse(medicine, "Medicine updated successfully"));
  } catch (err) {
    console.error("updateMedicine error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const medicine = await Medicine.findOne({ _id: id, deletedAt: null });
    if (!medicine) {
      return reply.code(404).send(errorResponse("Medicine not found"));
    }
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);

    medicine.deletedAt = new Date();
    await medicine.save();

    return reply.code(200).send(successResponse(null, "Medicine deleted successfully"));
  } catch (err) {
    console.error("deleteMedicine error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Pending Prescriptions (Pharmacy Dispensing Desk) ─────────────

export async function getPendingPrescriptionsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId } = req.query as { clinicId?: string };

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Valid clinicId is required"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    const prescriptions = await Prescription.find({
      clinicId,
      status: "active",
      deletedAt: null,
    })
      .populate("patientId", "name phone userId")
      .populate("doctorId", "name email phone")
      .populate("encounterId", "appointmentId startedAt endedAt")
      .sort({ createdAt: -1 })
      .lean();

    const grouped = new Map<string, {
      encounterId: string;
      appointmentId: string | null;
      appointmentTime: string | null;
      patientId: { id: string; name: string; phone?: string };
      doctorId: { id: string; name: string };
      prescriptions: Array<{
        id: string;
        medicineId: string | null;
        name: string;
        dosage: string;
        frequency: string;
        duration: string;
        instructions: string;
      }>;
    }>();

    for (const rx of prescriptions) {
      const encounterId = String((rx as any).encounterId?._id || rx.encounterId);
      if (!grouped.has(encounterId)) {
        const patientDoc = (rx as any).patientId;
        const doctorDoc = (rx as any).doctorId;
        const encounterDoc = (rx as any).encounterId;

        let appointmentTime: string | null = null;
        let appointmentId: string | null = null;
        if (encounterDoc?.appointmentId) {
          appointmentId = String(encounterDoc.appointmentId);
          const appt = await Appointment.findById(encounterDoc.appointmentId).select("appointmentTime").lean();
          appointmentTime = appt?.appointmentTime ? new Date(appt.appointmentTime).toISOString() : null;
        } else if (encounterDoc?.startedAt) {
          appointmentTime = new Date(encounterDoc.startedAt).toISOString();
        }

        grouped.set(encounterId, {
          encounterId,
          appointmentId,
          appointmentTime,
          patientId: {
            id: String(patientDoc?._id || rx.patientId),
            name: patientDoc?.name || "Patient",
            phone: patientDoc?.phone,
          },
          doctorId: {
            id: String(doctorDoc?._id || rx.doctorId),
            name: doctorDoc?.name || "Doctor",
          },
          prescriptions: [],
        });
      }

      grouped.get(encounterId)!.prescriptions.push({
        id: String((rx as any)._id),
        medicineId: (rx as any).medicineId ? String((rx as any).medicineId) : null,
        name: (rx as any).medicineName,
        dosage: (rx as any).dosage,
        frequency: (rx as any).frequency || "1-0-1",
        duration: (rx as any).duration,
        instructions: (rx as any).instructions || "",
      });
    }

    return reply.code(200).send(successResponse(Array.from(grouped.values())));
  } catch (err) {
    console.error("getPendingPrescriptionsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Dispensing Prescriptions Handler ─────────────────────────────

export async function dispensePrescription(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;

    const { patientId, clinicId, doctorId, items, prescriptionIds } = req.body as {
      patientId: string;
      clinicId: string;
      doctorId?: string;
      items: Array<{ medicineId: string; quantity: number }>;
      prescriptionIds?: string[];
    };

    if (!patientId || !clinicId || !items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(errorResponse("Missing fields: patientId, clinicId, and items are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid patientId or clinicId"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    // Verify Patient
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

    // Validate doctorId if passed
    let invoiceDoctorId = doctorId || userId;
    if (doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid doctorId"));
    }

    // Load and validate stocks
    const medsToUpdate: any[] = [];
    const medicineIds = new Set<string>();

    for (const item of items) {
      if (!mongoose.Types.ObjectId.isValid(item.medicineId)) {
        return reply.code(400).send(errorResponse(`Invalid medicineId: ${item.medicineId}`));
      }
      if (!item.quantity || item.quantity <= 0) {
        return reply.code(400).send(errorResponse("Item quantities must be positive integers"));
      }
      if (!Number.isInteger(item.quantity)) {
        return reply.code(400).send(errorResponse("Item quantities must be positive integers"));
      }
      if (medicineIds.has(item.medicineId)) {
        return reply.code(400).send(errorResponse("Each medicine may appear only once per dispense request"));
      }
      medicineIds.add(item.medicineId);

      const medicine = await Medicine.findById(item.medicineId);
      if (!medicine) {
        return reply.code(404).send(errorResponse(`Medicine ID ${item.medicineId} not found`));
      }
      if (medicine.clinicId.toString() !== clinicId) {
        return reply.code(404).send(errorResponse(`Medicine ID ${item.medicineId} not found in selected clinic`));
      }

      if (medicine.stockQuantity < item.quantity) {
        return reply.code(400).send(errorResponse(`Insufficient stock for ${medicine.name}. Available: ${medicine.stockQuantity}, Requested: ${item.quantity}`));
      }

      medsToUpdate.push({
        medicine,
        originalStock: medicine.stockQuantity,
        deductAmount: item.quantity
      });

    }

    const invoice = await withTransaction(async (session) => {
      const updatedMedicines: any[] = [];
      const dispensedResults: Array<{ medicine: any; item: { quantity: number }; result: any }> = [];
      try {
        for (const m of medsToUpdate) {
          const { dispenseMedicineFEFO } = await import("../services/PharmacyInventoryService.ts");
          const result = await dispenseMedicineFEFO(m.medicine._id.toString(), clinicId, m.deductAmount, session);
          dispensedResults.push({ medicine: m.medicine, item: { quantity: m.deductAmount }, result });
          updatedMedicines.push(m);
        }

        const invoiceItems = dispensedResults.map(({ medicine, item, result }) => ({
          description: `Prescription Medicine: ${medicine.name} (Batch: ${result.dispensedBatches.length > 0 ? result.dispensedBatches.map((batch: any) => batch.batchNumber).join(", ") : (medicine.batchNumber || "aggregate stock")})`,
          amount: result.totalCost / item.quantity,
          quantity: item.quantity,
        }));
        const subtotal = invoiceItems.reduce((total, item) => total + item.amount * item.quantity, 0);

        const { generateClinicInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
        const invoiceNumber = await generateClinicInvoiceNumber(clinicId);
        const createdInvoice = await createWithSession(Invoice, {
          invoiceNumber,
          patientId,
          clinicId,
          organizationId: clinicAccess.organizationId || undefined,
          doctorId: invoiceDoctorId,
          items: invoiceItems,
          subtotal,
          tax: 0,
          discount: 0,
          totalAmount: subtotal,
          status: "unpaid"
        }, session);

        await createWithSession(AuditLog, {
          userId,
          action: "PRESCRIPTION_DISPENSE",
          targetId: createdInvoice._id,
          targetModel: "Invoice",
          organizationId: clinicAccess.organizationId || undefined,
          details: { invoiceNumber: createdInvoice.invoiceNumber, totalAmount: subtotal, itemCount: items.length }
        }, session);

        if (prescriptionIds && prescriptionIds.length > 0) {
          const validIds = prescriptionIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
          if (validIds.length > 0) {
            await Prescription.updateMany(
              {
                _id: { $in: validIds },
                clinicId,
                patientId,
                status: "active",
                deletedAt: null,
              },
              { $set: { status: "dispensed" } },
              session ? { session } : undefined,
            );
          }
        }

        return createdInvoice;
      } catch (error) {
        // Transaction rollback handles replica-set deployments. Keep the
        // standalone development fallback recoverable as well.
        if (!session) {
          for (const m of updatedMedicines) {
            m.medicine.stockQuantity = m.originalStock;
            await m.medicine.save();
          }
          for (const dispensed of dispensedResults) {
            for (const batch of dispensed.result.dispensedBatches) {
              const batchDoc = await MedicineBatch.findById(batch.batchId);
              if (batchDoc) {
                batchDoc.quantity += batch.quantity;
                batchDoc.status = "active";
                await batchDoc.save();
              }
            }
          }
        }
        throw error;
      }
    });

    return reply.code(201).send(successResponse(invoice, "Medications dispensed and billed successfully"));
  } catch (err) {
    console.error("dispensePrescription error:", err);
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("Insufficient") || message.includes("expired") || message.includes("allocate")) {
      return reply.code(400).send(errorResponse(message));
    }
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Multi-Batch Pharmacy Inventory Handlers ─────────────────────

export async function createMedicineBatch(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { medicineId, clinicId, batchNumber, expiryDate, quantity, purchaseCost, sellingPrice, mrp, hsnCode, gstRate } = req.body as any;

    if (!medicineId || !clinicId || !batchNumber || !expiryDate || quantity === undefined || purchaseCost === undefined || sellingPrice === undefined) {
      return reply.code(400).send(errorResponse("medicineId, clinicId, batchNumber, expiryDate, quantity, purchaseCost, and sellingPrice are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(medicineId) || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid medicine or clinic ID"));
    }
    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
    const medicine = await Medicine.findById(medicineId);
    if (!medicine) return reply.code(404).send(errorResponse("Medicine record not found"));
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);
    if (medicine.clinicId.toString() !== clinicId) return reply.code(404).send(errorResponse("Medicine not found in selected clinic"));
    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(purchaseCost) || purchaseCost < 0 || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
      return reply.code(400).send(errorResponse("Quantity must be a positive integer and prices must be non-negative numbers"));
    }

    const { addBatchToMedicine } = await import("../services/PharmacyInventoryService.ts");
    const batch = await addBatchToMedicine({
      medicineId,
      clinicId,
      batchNumber,
      expiryDate,
      quantity,
      purchaseCost,
      sellingPrice,
      mrp,
      hsnCode,
      gstRate,
    });

    return reply.code(201).send(successResponse(batch, "Medicine batch stock added successfully"));
  } catch (err: any) {
    console.error("createMedicineBatch error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function getMedicineBatches(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const { MedicineBatch } = await import("../models/MedicineBatch.ts");
    const medicine = await Medicine.findById(id);
    if (!medicine) return reply.code(404).send(errorResponse("Medicine not found"));
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);
    const batches = await MedicineBatch.find({ medicineId: id }).sort({ expiryDate: 1 });

    return reply.code(200).send(successResponse(batches));
  } catch (err) {
    console.error("getMedicineBatches error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getExpiringMedicinesController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, days } = req.query as { clinicId?: string; days?: string | number };
    const targetClinicId = clinicId || (req as any).user?.clinicId;
    if (!targetClinicId || !mongoose.Types.ObjectId.isValid(targetClinicId)) {
      return reply.code(200).send(successResponse([]));
    }

    const clinicAccess = await checkClinicAccess(req, targetClinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    const daysThreshold = days ? parseInt(String(days), 10) : 30;
    if (!Number.isInteger(daysThreshold) || daysThreshold < 0) {
      return reply.code(400).send(errorResponse("days must be a non-negative integer"));
    }
    const { getExpiringBatches } = await import("../services/PharmacyInventoryService.ts");
    const expiring = await getExpiringBatches(targetClinicId, daysThreshold);

    return reply.code(200).send(successResponse(expiring));
  } catch (err) {
    console.error("getExpiringMedicinesController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function adjustStock(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { medicineId, newQuantity, reason, notes } = req.body as {
      medicineId: string;
      newQuantity: number;
      reason: "physical_audit" | "damaged" | "expired" | "restock" | "other";
      notes?: string;
    };

    if (!medicineId || newQuantity === undefined || !reason) {
      return reply.code(400).send(errorResponse("medicineId, newQuantity, and reason are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(medicineId)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      return reply.code(400).send(errorResponse("newQuantity must be a non-negative integer"));
    }

    const medicine = await Medicine.findById(medicineId);
    if (!medicine) return reply.code(404).send(errorResponse("Medicine not found"));

    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);

    const oldQuantity = medicine.stockQuantity;
    medicine.stockQuantity = newQuantity;
    await medicine.save();

    await AuditLog.create({
      userId,
      action: "MEDICINE_STOCK_ADJUSTMENT",
      targetId: medicine._id,
      targetModel: "Medicine",
      details: {
        medicineName: medicine.name,
        oldQuantity,
        newQuantity,
        adjustmentDelta: newQuantity - oldQuantity,
        reason,
        notes: notes?.trim() || null,
      },
    });

    return reply.code(200).send(
      successResponse(
        medicine,
        `Stock for '${medicine.name}' adjusted from ${oldQuantity} to ${newQuantity} (${reason})`
      )
    );
  } catch (err: any) {
    console.error("adjustStock error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}
