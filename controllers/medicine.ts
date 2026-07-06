import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

// ─── Medicine CRUD Handlers ─────────────────────────────────────

export async function createMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can manage medicine stock"));
    }

    const { clinicId, name, genericName, stockQuantity, price, costPrice, expiryDate, batchNumber } = req.body as {
      clinicId: string;
      name: string;
      genericName: string;
      stockQuantity: number;
      price: number;
      costPrice: number;
      expiryDate: string;
      batchNumber: string;
    };

    if (!clinicId || !name || !genericName || stockQuantity === undefined || price === undefined || costPrice === undefined || !expiryDate || !batchNumber) {
      return reply.code(400).send(errorResponse("All fields (clinicId, name, genericName, stockQuantity, price, costPrice, expiryDate, batchNumber) are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const medicine = await Medicine.create({
      clinicId,
      name,
      genericName,
      stockQuantity,
      price,
      costPrice,
      expiryDate: new Date(expiryDate),
      batchNumber
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

    const query: any = {};
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      query.clinicId = clinicId;
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
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can edit medicine stock"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const { name, genericName, stockQuantity, price, costPrice, expiryDate, batchNumber } = req.body as any;

    const medicine = await Medicine.findById(id);
    if (!medicine) {
      return reply.code(404).send(errorResponse("Medicine not found"));
    }

    if (name !== undefined) medicine.name = name;
    if (genericName !== undefined) medicine.genericName = genericName;
    if (stockQuantity !== undefined) medicine.stockQuantity = stockQuantity;
    if (price !== undefined) medicine.price = price;
    if (costPrice !== undefined) medicine.costPrice = costPrice;
    if (expiryDate !== undefined) medicine.expiryDate = new Date(expiryDate);
    if (batchNumber !== undefined) medicine.batchNumber = batchNumber;

    await medicine.save();
    return reply.code(200).send(successResponse(medicine, "Medicine updated successfully"));
  } catch (err) {
    console.error("updateMedicine error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin") {
      return reply.code(403).send(errorResponse("Forbidden: Only admin can delete medicine records"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const medicine = await Medicine.findById(id);
    if (!medicine) {
      return reply.code(404).send(errorResponse("Medicine not found"));
    }

    await Medicine.findByIdAndDelete(id);
    return reply.code(200).send(successResponse(null, "Medicine deleted successfully"));
  } catch (err) {
    console.error("deleteMedicine error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Dispensing Prescriptions Handler ─────────────────────────────

export async function dispensePrescription(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can dispense medications"));
    }

    const { patientId, clinicId, doctorId, items } = req.body as {
      patientId: string;
      clinicId: string;
      doctorId?: string; // Optional doctor responsible
      items: Array<{ medicineId: string; quantity: number }>;
    };

    if (!patientId || !clinicId || !items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(errorResponse("Missing fields: patientId, clinicId, and items are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid patientId or clinicId"));
    }

    // Verify Patient
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    // Validate doctorId if passed
    let invoiceDoctorId = doctorId || userId;
    if (doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid doctorId"));
    }

    // Load and validate stocks
    const medsToUpdate = [];
    const invoiceItems = [];
    let subtotal = 0;

    for (const item of items) {
      if (!mongoose.Types.ObjectId.isValid(item.medicineId)) {
        return reply.code(400).send(errorResponse(`Invalid medicineId: ${item.medicineId}`));
      }
      if (!item.quantity || item.quantity <= 0) {
        return reply.code(400).send(errorResponse("Item quantities must be positive integers"));
      }

      const medicine = await Medicine.findById(item.medicineId);
      if (!medicine) {
        return reply.code(404).send(errorResponse(`Medicine ID ${item.medicineId} not found`));
      }

      if (medicine.stockQuantity < item.quantity) {
        return reply.code(400).send(errorResponse(`Insufficient stock for ${medicine.name}. Available: ${medicine.stockQuantity}, Requested: ${item.quantity}`));
      }

      medsToUpdate.push({
        medicine,
        originalStock: medicine.stockQuantity,
        deductAmount: item.quantity
      });

      subtotal += medicine.price * item.quantity;
      invoiceItems.push({
        description: `Prescription Medicine: ${medicine.name} (Batch: ${medicine.batchNumber})`,
        amount: medicine.price,
        quantity: item.quantity
      });
    }

    // Perform Stock Updates
    const updatedMedicines = [];
    try {
      for (const m of medsToUpdate) {
        m.medicine.stockQuantity -= m.deductAmount;
        await m.medicine.save();
        updatedMedicines.push(m.medicine);
      }
    } catch (stockError) {
      // Rollback stock updates for any completed saves if one fails mid-way
      for (const m of medsToUpdate) {
        const checkUpdated = updatedMedicines.find(um => um._id.toString() === m.medicine._id.toString());
        if (checkUpdated) {
          m.medicine.stockQuantity = m.originalStock;
          await m.medicine.save();
        }
      }
      throw stockError;
    }

    let invoice: any = null;
    try {
      // Generate Invoice
      const year = new Date().getFullYear();
      const count = await Invoice.countDocuments();
      const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

      invoice = await Invoice.create({
        invoiceNumber,
        patientId,
        clinicId,
        doctorId: invoiceDoctorId,
        items: invoiceItems,
        subtotal,
        tax: 0,
        discount: 0,
        totalAmount: subtotal,
        status: "unpaid"
      });
    } catch (invoiceError) {
      // Rollback all stock updates if invoice creation fails
      for (const m of medsToUpdate) {
        m.medicine.stockQuantity = m.originalStock;
        await m.medicine.save();
      }
      throw invoiceError;
    }

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "PRESCRIPTION_DISPENSE",
      targetId: invoice._id,
      targetModel: "Invoice",
      details: { invoiceNumber: invoice.invoiceNumber, totalAmount: subtotal, itemCount: items.length }
    });

    return reply.code(201).send(successResponse(invoice, "Medications dispensed and billed successfully"));
  } catch (err) {
    console.error("dispensePrescription error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
