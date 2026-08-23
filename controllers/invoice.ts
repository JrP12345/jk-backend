import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestClinicIds } from "../utilities/tenant.ts";

export async function createInvoice(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    let orgId = req.user?.organization_id;

    const {
      patientId, clinicId, doctorId, appointmentId, encounterId, items, tax, discount,
      supplierGstin, customerGstin, invoiceType, placeOfSupply, isInterstate
    } = req.body as {
      patientId: string;
      clinicId: string;
      doctorId: string;
      appointmentId?: string;
      encounterId?: string;
      items: Array<{
        serviceCatalogId?: string;
        description: string;
        amount: number;
        quantity?: number;
        hsnSacCode?: string;
        gstRate?: number;
      }>;
      tax?: number;
      discount?: number;
      supplierGstin?: string;
      customerGstin?: string;
      invoiceType?: "B2C" | "B2B" | "SEZ" | "EXPORT";
      placeOfSupply?: string;
      isInterstate?: boolean;
    };

    if (!patientId || !clinicId || !doctorId || !items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(errorResponse("patientId, clinicId, doctorId, and items are required"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) {
      return reply.code(clinicAccess.statusCode).send(errorResponse(clinicAccess.message));
    }
    if (!orgId && clinicAccess.organizationId) orgId = clinicAccess.organizationId;

    // Verify patient profile
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    if (req.user?.role !== "root" && orgId && patient.organizationId && patient.organizationId.toString() !== orgId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const { generateClinicInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
    const invoiceNumber = await generateClinicInvoiceNumber(clinicId || "GLOBAL");

    // Calculate totals & GST Breakdown
    let subtotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;

    const formattedItems = items.map(item => {
      const quantity = item.quantity || 1;
      const baseLineAmount = item.amount * quantity;
      subtotal += baseLineAmount;

      const gstRate = item.gstRate || 0;
      const hsnSacCode = item.hsnSacCode || "999312";

      let cgstAmount = 0;
      let sgstAmount = 0;
      let igstAmount = 0;

      if (gstRate > 0) {
        if (isInterstate) {
          igstAmount = Number((baseLineAmount * (gstRate / 100)).toFixed(2));
          igstTotal += igstAmount;
        } else {
          cgstAmount = Number((baseLineAmount * (gstRate / 200)).toFixed(2));
          sgstAmount = Number((baseLineAmount * (gstRate / 200)).toFixed(2));
          cgstTotal += cgstAmount;
          sgstTotal += sgstAmount;
        }
      }

      const totalItemAmount = Number((baseLineAmount + cgstAmount + sgstAmount + igstAmount).toFixed(2));

      return {
        serviceCatalogId: item.serviceCatalogId || null,
        description: item.description,
        amount: item.amount,
        quantity,
        hsnSacCode,
        gstRate,
        cgstAmount,
        sgstAmount,
        igstAmount,
        totalItemAmount,
      };
    });

    const gstCalculated = Number((cgstTotal + sgstTotal + igstTotal).toFixed(2));
    const calculatedTax = gstCalculated > 0 ? gstCalculated : (tax !== undefined ? tax : 0);
    const calculatedDiscount = discount || 0;

    // Discount Authorization Gate: >15% discount requires Admin role or Manager Approval Code
    if (subtotal > 0 && calculatedDiscount / subtotal > 0.15 && userRole !== "admin" && userRole !== "root") {
      const { managerApprovalCode } = (req.body || {}) as { managerApprovalCode?: string };
      if (!managerApprovalCode || managerApprovalCode.trim().length === 0) {
        return reply.code(403).send(errorResponse("Forbidden: Invoice discounts exceeding 15% require a valid Manager Approval Code"));
      }
    }

    const taxableAmount = Math.max(0, subtotal - calculatedDiscount);
    const totalAmount = Number((taxableAmount + calculatedTax).toFixed(2));

    if (totalAmount < 0) {
      return reply.code(400).send(errorResponse("Total amount cannot be negative"));
    }

    const invoice = await Invoice.create({
      invoiceNumber,
      organizationId: orgId || null,
      patientId,
      clinicId,
      doctorId,
      appointmentId: appointmentId || null,
      encounterId: encounterId || null,
      items: formattedItems,
      subtotal,
      taxableAmount,
      tax: calculatedTax,
      discount: calculatedDiscount,
      totalAmount,
      supplierGstin: supplierGstin || undefined,
      customerGstin: customerGstin || undefined,
      invoiceType: invoiceType || (customerGstin ? "B2B" : "B2C"),
      placeOfSupply: placeOfSupply || undefined,
      isInterstate: !!isInterstate,
      cgstTotal,
      sgstTotal,
      igstTotal,
      status: "unpaid",
      dueDate: (req.body as any)?.dueDate ? new Date((req.body as any).dueDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // Create Audit Log
    await AuditLog.create({
      userId,
      organizationId: orgId || null,
      action: "INVOICE_CREATE",
      targetId: invoice._id,
      targetModel: "Invoice",
      details: { invoiceNumber, totalAmount, patientId }
    });

    if (patient?.userId) {
      eventBus.publish({
        eventType: EVENT_TYPES.BILLING_INVOICE_GENERATED,
        category: "billing",
        targetUserId: patient.userId.toString(),
        title: "New Invoice Generated",
        message: `Invoice #${invoiceNumber} for $${totalAmount.toFixed(2)} has been generated.`,
        severity: "info",
        actionUrl: "/dashboard/billing",
        organizationId: orgId,
      });
    }

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
    const orgId = req.user?.organization_id;
    const { status, patientId, clinicId, page, limit } = req.query as any;

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
      filter.patientId = patient._id;
    } else if (userRole === "doctor") {
      filter.doctorId = userId;
    }

    if (patientId && userRole !== "patient") filter.patientId = patientId;

    if (clinicId) {
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) {
        return reply.code(clinicAccess.statusCode).send(errorResponse(clinicAccess.message));
      }
      filter.clinicId = clinicId;
    } else if (orgId && userRole !== "patient") {
      const clinicIds = await getRequestClinicIds(req);
      filter.clinicId = { $in: clinicIds };
    }

    if (status) filter.status = status;

    const totalCount = await Invoice.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const invoices = await Invoice.find(filter)
      .populate("clinicId", "name city address")
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
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
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid invoice ID"));
    }

    const invoice: any = await Invoice.findById(id)
      .populate("clinicId", "name city address phone email organizationId")
      .populate("doctorId", "name specialization qualification")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    const invoiceClinicId = invoice.clinicId?._id || invoice.clinicId;
    const clinicAccess = await checkClinicAccess(req, invoiceClinicId);
    if (!clinicAccess.allowed) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    // Role & Tenant authorization checks
    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient || invoice.patientId._id.toString() !== patient.id) {
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
    const { paymentMethod } = req.body as { 
      paymentMethod: "cash" | "card" | "upi" | "net-banking" | "insurance" | "online";
      paymentToken?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid invoice ID"));
    }

    const validMethods = ["cash", "card", "upi", "net-banking", "insurance", "online"];
    if (!paymentMethod || !validMethods.includes(paymentMethod)) {
      return reply.code(400).send(errorResponse("Invalid or missing payment method"));
    }

    const invoice = await Invoice.findById(id).populate("clinicId", "organizationId");
    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    if (invoice.status === "paid") {
      return reply.code(400).send(errorResponse("Invoice has already been paid"));
    }

    // Security check: Patients can pay their own online/UPI, staff can collect anything
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient || invoice.patientId.toString() !== patient.id) {
        return reply.code(403).send(errorResponse("Access denied: Cannot pay invoices for other accounts"));
      }
      if (paymentMethod !== "online" && paymentMethod !== "upi" && paymentMethod !== "card") {
        return reply.code(400).send(errorResponse("Patients can only pay online, via UPI, or via tokenized card"));
      }
    } else {
      const clinicAccess = await checkClinicAccess(req, (invoice.clinicId as any)?._id || invoice.clinicId);
      if (!clinicAccess.allowed) {
        return reply.code(404).send(errorResponse("Invoice not found"));
      }
    }

    const remainingToPay = Number((invoice.totalAmount - (invoice.amountPaid || 0)).toFixed(2));

    invoice.status = "paid";
    invoice.amountPaid = invoice.totalAmount;
    invoice.balanceDue = 0;
    invoice.paymentMethod = paymentMethod;
    invoice.paymentDate = new Date();

    if (!invoice.payments) invoice.payments = [] as any;
    if (remainingToPay > 0) {
      invoice.payments.push({
        amount: remainingToPay,
        paymentMethod,
        paidAt: new Date(),
        notes: "Full payment collected",
      });
    }

    await invoice.save();

    // Create Audit Log with tokenized ID reference
    await AuditLog.create({
      userId,
      action: "INVOICE_PAY",
      targetId: invoice._id,
      targetModel: "Invoice",
      details: { 
        invoiceNumber: invoice.invoiceNumber, 
        totalAmount: invoice.totalAmount, 
        paymentMethod,
      }
    });

    return reply.code(200).send(successResponse(invoice, "Invoice payment recorded successfully"));
  } catch (err) {
    console.error("collectPayment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Auto Charge Capture: Preview & Generate Invoice for Encounter ───
export async function getEncounterChargesPreview(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { encounterId } = req.params as { encounterId: string };
    if (!mongoose.Types.ObjectId.isValid(encounterId)) {
      return reply.code(400).send(errorResponse("Invalid encounter ID"));
    }

    const encounter = await Encounter.findById(encounterId).lean();
    if (!encounter) {
      return reply.code(404).send(errorResponse("Encounter not found"));
    }

    const access = await checkOperationalRecordAccess(req, encounter);
    if (!access.allowed) {
      return reply.code(access.statusCode).send(errorResponse(access.message));
    }

    const { compileEncounterCharges } = await import("../services/ChargeCaptureService.ts");
    const preview = await compileEncounterCharges(encounterId);

    return reply.code(200).send(successResponse(preview, "Encounter charges compiled successfully"));
  } catch (err: any) {
    console.error("getEncounterChargesPreview error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function autoGenerateInvoiceForEncounter(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { encounterId } = req.params as { encounterId: string };

    if (!mongoose.Types.ObjectId.isValid(encounterId)) {
      return reply.code(400).send(errorResponse("Invalid encounter ID"));
    }

    const encounter = await Encounter.findById(encounterId).lean();
    if (!encounter) {
      return reply.code(404).send(errorResponse("Encounter not found"));
    }

    const access = await checkOperationalRecordAccess(req, encounter);
    if (!access.allowed) {
      return reply.code(access.statusCode).send(errorResponse(access.message));
    }

    const { autoGenerateEncounterInvoice } = await import("../services/ChargeCaptureService.ts");
    const invoice = await autoGenerateEncounterInvoice(encounterId, userId);

    if (!invoice) {
      return reply.code(200).send(successResponse(null, "No additional billable charges for this encounter"));
    }

    return reply.code(201).send(successResponse(invoice, "Invoice auto-generated from encounter successfully"));
  } catch (err: any) {
    console.error("autoGenerateInvoiceForEncounter error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── Record Installment / Partial Payment ──────────────────────
export async function recordPartialPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const { amount, paymentMethod, referenceNumber, notes } = req.body as {
      amount: number;
      paymentMethod: string;
      referenceNumber?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid invoice ID"));
    }

    if (!amount || amount <= 0) {
      return reply.code(400).send(errorResponse("Payment amount must be greater than 0"));
    }

    const invoice: any = await Invoice.findById(id);
    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    const clinicAccess = await checkClinicAccess(req, (invoice.clinicId as any)?._id || invoice.clinicId);
    if (!clinicAccess.allowed) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    if (req.user!.role === "patient") {
      const patient = await Patient.findOne({ userId: req.user!.id });
      if (!patient || invoice.patientId.toString() !== patient._id.toString()) {
        return reply.code(403).send(errorResponse("Forbidden: invoice does not belong to you"));
      }
    }

    const validPaymentMethods = ["cash", "card", "upi", "net-banking", "insurance", "online"];
    if (!paymentMethod || !validPaymentMethods.includes(paymentMethod)) {
      return reply.code(400).send(errorResponse("Invalid or missing payment method"));
    }

    if (invoice.status === "paid") {
      return reply.code(400).send(errorResponse("Invoice has already been fully paid"));
    }

    const currentPaid = invoice.amountPaid || 0;
    const currentBalance = invoice.balanceDue !== undefined ? invoice.balanceDue : invoice.totalAmount - currentPaid;

    if (amount > currentBalance + 0.01) {
      return reply.code(400).send(errorResponse(`Payment amount ₹${amount} exceeds current balance due ₹${currentBalance}`));
    }

    const newAmountPaid = Number((currentPaid + amount).toFixed(2));
    const newBalanceDue = Math.max(0, Number((invoice.totalAmount - newAmountPaid).toFixed(2)));
    const newStatus = newBalanceDue <= 0 ? "paid" : "partially_paid";

    invoice.amountPaid = newAmountPaid;
    invoice.balanceDue = newBalanceDue;
    invoice.status = newStatus;
    invoice.paymentMethod = paymentMethod || "cash";
    invoice.paymentDate = new Date();

    if (!invoice.payments) invoice.payments = [];
    invoice.payments.push({
      amount,
      paymentMethod: paymentMethod || "cash",
      referenceNumber: referenceNumber?.trim(),
      paidAt: new Date(),
      notes: notes?.trim(),
    });

    await invoice.save();

    await AuditLog.create({
      userId,
      action: "INVOICE_PARTIAL_PAYMENT",
      targetId: invoice._id,
      targetModel: "Invoice",
      details: { amount, newBalanceDue, status: newStatus, referenceNumber }
    });

    return reply.code(200).send(
      successResponse(
        invoice,
        `Payment of ₹${amount} recorded! Remaining balance due: ₹${newBalanceDue}`
      )
    );
  } catch (err) {
    console.error("recordPartialPayment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
