import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Invoice } from "../models/Invoice.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function createInvoice(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can create invoices manually"));
    }

    const {
      patientId, clinicId, doctorId, appointmentId, items, tax, discount
    } = req.body as {
      patientId: string;
      clinicId: string;
      doctorId: string;
      appointmentId?: string;
      items: Array<{ description: string; amount: number; quantity?: number }>;
      tax?: number;
      discount?: number;
    };

    if (!patientId || !clinicId || !doctorId || !items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(errorResponse("patientId, clinicId, doctorId, and items are required"));
    }

    // Verify patient profile
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    // Generate sequential invoice number
    const targetDate = new Date();
    const year = targetDate.getFullYear();
    const count = await Invoice.countDocuments();
    const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

    // Calculate totals
    let subtotal = 0;
    const formattedItems = items.map(item => {
      const quantity = item.quantity || 1;
      subtotal += item.amount * quantity;
      return {
        description: item.description,
        amount: item.amount,
        quantity
      };
    });

    const calculatedTax = tax || 0;
    const calculatedDiscount = discount || 0;
    const totalAmount = subtotal + calculatedTax - calculatedDiscount;

    const invoice = await Invoice.create({
      invoiceNumber,
      patientId,
      clinicId,
      doctorId,
      appointmentId: appointmentId || null,
      items: formattedItems,
      subtotal,
      tax: calculatedTax,
      discount: calculatedDiscount,
      totalAmount: Math.max(0, totalAmount),
      status: "unpaid"
    });

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "INVOICE_CREATE",
      targetId: invoice._id,
      targetModel: "Invoice",
      details: { invoiceNumber, totalAmount, status: "unpaid" }
    });

    return reply.code(201).send(successResponse(invoice, "Invoice created successfully"));
  } catch (err) {
    console.error("createInvoice error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getInvoices(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const { clinicId, doctorId, status, page, limit } = req.query as {
      clinicId?: string; doctorId?: string; status?: string;
      page?: string | number; limit?: string | number;
    };

    const query: any = {};

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient) return reply.code(200).send(successResponse([]));
      query.patientId = patient.id;
    } else if (userRole === "doctor") {
      query.doctorId = userId;
    } else if (userRole === "admin" || userRole === "receptionist") {
      if (clinicId) query.clinicId = clinicId;
      if (doctorId) query.doctorId = doctorId;
    } else {
      return reply.code(403).send(errorResponse("Unauthorized role"));
    }

    if (status) query.status = status;

    const totalCount = await Invoice.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const invoices = await Invoice.find(query)
      .populate("clinicId", "name city address")
      .populate("doctorId", "name email phone specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
      .populate("appointmentId", "tokenNumber appointmentTime")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(invoices));
  } catch (err) {
    console.error("getInvoices error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getInvoiceDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid invoice ID"));
    }

    const invoice = await Invoice.findById(id)
      .populate("clinicId", "name city address phone email")
      .populate("doctorId", "name email phone specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
      .populate("appointmentId", "tokenNumber appointmentTime notes");

    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    // Security: Patient can only view their own invoices, Doctor can only view theirs
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient || invoice.patientId._id.toString() !== patient._id.toString()) {
        return reply.code(403).send(errorResponse("Access denied: This invoice does not belong to you"));
      }
    } else if (userRole === "doctor" && invoice.doctorId._id.toString() !== userId) {
      return reply.code(403).send(errorResponse("Access denied: You are not the practitioner for this invoice"));
    }

    return reply.code(200).send(successResponse(invoice));
  } catch (err) {
    console.error("getInvoiceDetails error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function collectPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { paymentMethod } = req.body as { paymentMethod: "cash" | "card" | "upi" | "net-banking" | "insurance" | "online" };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid invoice ID"));
    }

    const validMethods = ["cash", "card", "upi", "net-banking", "insurance", "online"];
    if (!paymentMethod || !validMethods.includes(paymentMethod)) {
      return reply.code(400).send(errorResponse("Invalid or missing payment method"));
    }

    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    if (invoice.status === "paid") {
      return reply.code(400).send(errorResponse("Invoice has already been paid"));
    }

    // Security check: Patients can pay their own online, staff can collect anything
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient || invoice.patientId.toString() !== patient.id) {
        return reply.code(403).send(errorResponse("Access denied: Cannot pay invoices for other accounts"));
      }
      if (paymentMethod !== "online" && paymentMethod !== "upi") {
        return reply.code(400).send(errorResponse("Patients can only pay online or via UPI"));
      }
    }

    invoice.status = "paid";
    invoice.paymentMethod = paymentMethod;
    invoice.paymentDate = new Date();
    await invoice.save();

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "INVOICE_PAY",
      targetId: invoice._id,
      targetModel: "Invoice",
      details: { invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount, paymentMethod }
    });

    return reply.code(200).send(successResponse(invoice, "Invoice payment recorded successfully"));
  } catch (err) {
    console.error("collectPayment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
