import { claimMutation, mutationKey } from "../services/IdempotentMutationService.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { checkLocationAccess, checkOperationalRecordAccess, getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";

const INDIA_BILLING_ONLY = "Manual billing and GST calculations are not configured for this organization's country";

async function canUseIndianBilling(locationId: string): Promise<boolean> {
  const location = await Location.findById(locationId).select("organizationId").lean();
  const organization = location?.organizationId
    ? await Organization.findById(location.organizationId).select("countryCode currency").lean()
    : null;
  return !!organization && (!organization.countryCode || organization.countryCode === "IN") && (!organization.currency || organization.currency === "INR");
}

export async function createInvoice(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    let orgId = scope.organizationId;

    const {
      patientId, locationId, doctorId, appointmentId, encounterId, items, tax, discount,
      supplierGstin, customerGstin, invoiceType, placeOfSupply, isInterstate
    } = req.body as {
      patientId: string;
      locationId: string;
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

    if (!patientId || !locationId || !doctorId || !items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(errorResponse("patientId, locationId, doctorId, and items are required"));
    }

    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) {
      return reply.code(locationAccess.statusCode).send(errorResponse(locationAccess.message));
    }
    if (!orgId && locationAccess.organizationId) orgId = locationAccess.organizationId;
    if (!(await canUseIndianBilling(locationId))) return reply.code(409).send(errorResponse(INDIA_BILLING_ONLY));

    // Verify patient profile
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    if (req.user?.role !== "root" && orgId && patient.organizationId && patient.organizationId.toString() !== orgId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const { generateLocationInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
    const invoiceNumber = await generateLocationInvoiceNumber(locationId || "GLOBAL");

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
      locationId,
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
      await eventBus.publishDurable({
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && userRole !== "patient" && userRole !== "family_member") {
      return reply.code(scope.statusCode).send(errorResponse(scope.message));
    }
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const { status, patientId, locationId, appointmentId, page, limit } = req.query as any;

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};

    if (userRole === "patient" || userRole === "family_member") {
      const patient = await Patient.findOne({ userId });
      if (userRole === "patient") {
        if (!patient) return reply.code(200).send(successResponse([]));
        filter.patientId = patient._id;
      } else {
        const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
        const rels = await FamilyRelationship.find({ userId, status: "active" }).select("patientId").lean();
        const familyPatientIds: any[] = rels.map((r: any) => r.patientId).filter(Boolean);
        if (patient) familyPatientIds.push(patient._id);
        filter.patientId = { $in: familyPatientIds };
      }
    } else if (userRole === "doctor") {
      filter.doctorId = userId;
    }

    if (patientId && userRole !== "patient" && userRole !== "family_member") filter.patientId = patientId;

    if (locationId) {
      const locationAccess = await checkLocationAccess(req, locationId);
      if (!locationAccess.allowed) {
        return reply.code(locationAccess.statusCode).send(errorResponse(locationAccess.message));
      }
      filter.locationId = locationId;
    } else if (orgId && userRole !== "patient" && userRole !== "family_member") {
      const locationIds = userRole === "root"
        ? (await Location.find({ organizationId: orgId, isActive: { $ne: false } }).select("_id").lean()).map((location: any) => location._id)
        : await getRequestLocationIds(req);
      filter.locationId = { $in: locationIds };
    }

    if (status) filter.status = status;
    if (appointmentId) {
      if (!mongoose.Types.ObjectId.isValid(appointmentId)) return reply.code(400).send(errorResponse("Invalid appointment ID"));
      const { Encounter } = await import("../models/Encounter.ts");
      const encounters = await Encounter.find({ appointmentId, organizationId: orgId }).select("_id").lean();
      filter.$and = [{ $or: [{ appointmentId }, { encounterId: { $in: encounters.map(encounter => encounter._id) } }] }];
    }

    const [totalCount, rawInvoices] = await Promise.all([
      Invoice.countDocuments(filter),
      Invoice.find(filter)
        .populate("locationId", "name city address")
        .populate("doctorId", "name specialization")
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name email phone" }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);
    const appointmentIds = rawInvoices.map((inv: any) => inv.appointmentId).filter(Boolean);
    const pendingRefunds = appointmentIds.length ? await Appointment.find({ _id: { $in: appointmentIds },
      paymentStatus: "refund_pending", status: "cancelled" }).select("_id locationId patientId").lean() : [];
    const pendingById = new Map(pendingRefunds.map((visit: any) => [visit._id.toString(), visit]));
    const invoices = rawInvoices.map((inv: any) => {
      const pending = pendingById.get(String(inv.appointmentId));
      return { ...inv, id: inv._id.toString(), refundPending: Boolean(pending
        && String(pending.locationId) === String(inv.locationId?._id || inv.locationId)
        && String(pending.patientId) === String(inv.patientId?._id || inv.patientId)) };
    });

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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && userRole !== "patient" && userRole !== "family_member") {
      return reply.code(scope.statusCode).send(errorResponse(scope.message));
    }
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid invoice ID"));
    }

    const invoice: any = await Invoice.findById(id)
      .populate("locationId", "name city address phone email organizationId")
      .populate("doctorId", "name specialization qualification")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    const invoiceLocationId = invoice.locationId?._id || invoice.locationId;
    const locationAccess = await checkLocationAccess(req, invoiceLocationId);
    if (!locationAccess.allowed) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    // Role & Tenant authorization checks
    if (userRole === "patient" || userRole === "family_member") {
      const invoicePatientIdStr = invoice.patientId?._id?.toString() || invoice.patientId?.toString();
      const patient = await Patient.findOne({ userId });
      let isAllowed = Boolean(patient && invoicePatientIdStr === patient._id.toString());
      if (!isAllowed && userRole === "family_member") {
        const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
        const hasRel = await FamilyRelationship.exists({
          userId,
          patientId: invoicePatientIdStr,
          status: "active",
        });
        isAllowed = Boolean(hasRel);
      }
      if (!isAllowed) {
        return reply.code(403).send(errorResponse("Access denied: This invoice does not belong to you"));
      }
    } else if (userRole === "doctor" && invoice.doctorId?._id?.toString() !== userId && invoice.doctorId?.toString() !== userId) {
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

    const invoice = await Invoice.findById(id).populate("locationId", "organizationId");
    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    if (invoice.status === "paid") {
      return reply.code(400).send(errorResponse("Invoice has already been paid"));
    }

    // Security check: Patients can pay their own online/UPI, staff can collect anything
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && userRole !== "patient") {
      return reply.code(scope.statusCode).send(errorResponse(scope.message));
    }
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient || invoice.patientId.toString() !== patient.id) {
        return reply.code(403).send(errorResponse("Access denied: Cannot pay invoices for other accounts"));
      }
      if (paymentMethod !== "online" && paymentMethod !== "upi" && paymentMethod !== "card") {
        return reply.code(400).send(errorResponse("Patients can only pay online, via UPI, or via tokenized card"));
      }
    } else {
      const locationAccess = await checkLocationAccess(req, (invoice.locationId as any)?._id || invoice.locationId);
      if (!locationAccess.allowed) {
        return reply.code(404).send(errorResponse("Invoice not found"));
      }
    }

    if (paymentMethod === "upi" && (invoice.currency && invoice.currency !== "INR" || !(await canUseIndianBilling(String((invoice.locationId as any)?._id || invoice.locationId))))) {
      return reply.code(409).send(errorResponse("UPI collection is only configured for INR locations"));
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

    if (!(await canUseIndianBilling(encounter.locationId.toString()))) {
      return reply.code(409).send(errorResponse(INDIA_BILLING_ONLY));
    }

    const { customConsultFee, customConsultationFee } = (req.query as any) || {};
    const parsedFee = customConsultFee !== undefined ? Number(customConsultFee) : (customConsultationFee !== undefined ? Number(customConsultationFee) : undefined);
    const { compileEncounterCharges } = await import("../services/ChargeCaptureService.ts");
    const preview = await compileEncounterCharges(encounterId, parsedFee);

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
    const { customConsultFee, customConsultationFee } = (req.body as any) || {};
    const parsedFee = customConsultFee !== undefined ? Number(customConsultFee) : (customConsultationFee !== undefined ? Number(customConsultationFee) : undefined);

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

    if (!(await canUseIndianBilling(encounter.locationId.toString()))) {
      return reply.code(409).send(errorResponse(INDIA_BILLING_ONLY));
    }

    const { autoGenerateEncounterInvoice } = await import("../services/ChargeCaptureService.ts");
    const invoice = await autoGenerateEncounterInvoice(encounterId, userId, parsedFee);

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

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
      return reply.code(400).send(errorResponse("Payment amount must be greater than 0"));
    }

    const invoice: any = await Invoice.findById(id);
    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found"));
    }

    const locationAccess = await checkLocationAccess(req, (invoice.locationId as any)?._id || invoice.locationId);
    if (!locationAccess.allowed) {
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
    if (paymentMethod === "upi" && (invoice.currency && invoice.currency !== "INR" || !(await canUseIndianBilling(String(invoice.locationId))))) {
      return reply.code(409).send(errorResponse("UPI collection is only configured for INR locations"));
    }

    const key = mutationKey(req);
    const { updatedInvoice, newBalanceDue } = await withTransaction(async (session) => {
      const option = session ? { session } : undefined;
      const invoice: any = await Invoice.findById(id, null, option);
      if (!invoice) {
        throw new Error("NOT_FOUND:Invoice not found");
      }

      const locationAccess = await checkLocationAccess(req, (invoice.locationId as any)?._id || invoice.locationId);
      if (!locationAccess.allowed) {
        throw new Error("NOT_FOUND:Invoice not found");
      }

      if (req.user!.role === "patient") {
        const patient = await Patient.findOne({ userId: req.user!.id }, null, option);
        if (!patient || invoice.patientId.toString() !== patient._id.toString()) {
          throw new Error("FORBIDDEN:Forbidden: invoice does not belong to you");
        }
      }

      const operation = await claimMutation('installment:' + invoice.organizationId + ':' + id, key, req.body);
      if (operation.replay) return { updatedInvoice: invoice, newBalanceDue: invoice.balanceDue };
      if (["refunded", "cancelled"].includes(invoice.status)) throw Object.assign(new Error("Invoice cannot accept payments"), { statusCode: 409 });
      if (invoice.status === "paid") {
        throw new Error("ALREADY_PAID:Invoice has already been fully paid");
      }

      const currentPaid = invoice.amountPaid || 0;
      const currentBalance = invoice.balanceDue !== undefined ? invoice.balanceDue : invoice.totalAmount - currentPaid;

      if (amount > currentBalance + 0.01) {
        throw new Error(`OVERPAYMENT:Payment amount ₹${amount} exceeds current balance due ₹${currentBalance}`);
      }

      const newAmountPaid = Number((currentPaid + amount).toFixed(2));
      const calculatedBalance = Math.max(0, Number((invoice.totalAmount - newAmountPaid).toFixed(2)));
      const newStatus = calculatedBalance <= 0 ? "paid" : "partially_paid";

      invoice.amountPaid = newAmountPaid;
      invoice.balanceDue = calculatedBalance;
      invoice.status = newStatus;
      invoice.paymentMethod = paymentMethod || "cash";
      invoice.paymentDate = new Date();

      if (!invoice.payments) invoice.payments = [];
      invoice.payments.push({
        operationKey: key,
        amount,
        paymentMethod: paymentMethod || "cash",
        referenceNumber: referenceNumber?.trim(),
        paidAt: new Date(),
        notes: notes?.trim(),
      });

      await invoice.save(option);

      // Keep the existing visit projection consistent with canonical invoices.
      // Include encounter invoices so post-consultation fees are not collected twice.
      const { Encounter } = await import("../models/Encounter.ts");
      const { Appointment } = await import("../models/Appointment.ts");
      const encounter = invoice.encounterId ? await Encounter.findById(invoice.encounterId, null, option) : null;
      const linkedAppointmentId = invoice.appointmentId || encounter?.appointmentId;
      if (linkedAppointmentId) {
        const linkedEncounters = await Encounter.find({ appointmentId: linkedAppointmentId, organizationId: invoice.organizationId }, null, option).select("_id").lean();
        const visitInvoices = await Invoice.find({ organizationId: invoice.organizationId, deletedAt: null, status: { $nin: ["cancelled", "refunded"] },
          $or: [{ appointmentId: linkedAppointmentId }, { encounterId: { $in: linkedEncounters.map(value => value._id) } }],
        }, null, option).lean();
        const outstanding = visitInvoices.reduce((sum, value) => sum + Math.max(0, value.totalAmount - (value.amountPaid || 0)), 0);
        const totalPaid = visitInvoices.reduce((sum, value) => sum + (value.amountPaid || 0), 0);
        await Appointment.updateOne({ _id: linkedAppointmentId, organizationId: invoice.organizationId }, {
          $set: { paymentStatus: outstanding <= 0 ? "paid" : totalPaid > 0 ? "partially_paid" : "unpaid" },
        }, option);
        if (outstanding <= 0) await Appointment.updateOne({ _id: linkedAppointmentId, organizationId: invoice.organizationId, status: "pending_payment" }, { $set: { status: "confirmed" } }, option);
      }

      await createWithSession(AuditLog, {
        userId,
        action: "INVOICE_PARTIAL_PAYMENT",
        targetId: invoice._id,
        targetModel: "Invoice",
        details: { amount, newBalanceDue: calculatedBalance, status: newStatus, referenceNumber }
      }, session);

      operation.receipt.resultId = invoice._id;
      await operation.receipt.save(option);
      return { updatedInvoice: invoice, newBalanceDue: calculatedBalance };
    });

    return reply.code(200).send(
      successResponse(
        updatedInvoice,
        `Payment of ₹${amount} recorded! Remaining balance due: ₹${newBalanceDue}`
      )
    );
  } catch (err: any) {
    if (err.statusCode) return reply.code(err.statusCode).send(errorResponse(err.message));
    const msg = err.message || "";
    if (msg.startsWith("NOT_FOUND:")) {
      return reply.code(404).send(errorResponse(msg.replace("NOT_FOUND:", "")));
    }
    if (msg.startsWith("FORBIDDEN:")) {
      return reply.code(403).send(errorResponse(msg.replace("FORBIDDEN:", "")));
    }
    if (msg.startsWith("ALREADY_PAID:") || msg.startsWith("OVERPAYMENT:")) {
      return reply.code(400).send(errorResponse(msg.split(":")[1]));
    }
    console.error("recordPartialPayment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Consolidated OPD Checkout: Preview & Settlement ──────────
export async function getConsolidatedCheckoutPreview(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };

    if (!appointmentId || !mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const { Appointment } = await import("../models/Appointment.ts");
    const appointment = await Appointment.findById(appointmentId).lean();
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const access = await checkOperationalRecordAccess(req, appointment);
    if (!access.allowed) {
      return reply.code(access.statusCode).send(errorResponse(access.message));
    }

    if (!(await canUseIndianBilling(appointment.locationId.toString()))) {
      return reply.code(409).send(errorResponse(INDIA_BILLING_ONLY));
    }

    const { customConsultFee, customConsultationFee } = (req.query as any) || {};
    const parsedFee = customConsultFee !== undefined ? Number(customConsultFee) : (customConsultationFee !== undefined ? Number(customConsultationFee) : undefined);
    const { compileAppointmentCharges } = await import("../services/ChargeCaptureService.ts");
    const compiled = await compileAppointmentCharges(appointmentId, parsedFee);

    return reply.code(200).send(
      successResponse(
        {
          appointment: compiled.appointment,
          items: compiled.items,
          subtotal: compiled.subtotal,
          cgstTotal: compiled.cgstTotal,
          sgstTotal: compiled.sgstTotal,
          igstTotal: compiled.igstTotal,
          totalAmount: compiled.totalAmount,
          existingInvoice: compiled.existingInvoice,
          feeType: compiled.feeType,
          consultationFee: compiled.consultationFee,
          isFeeEditable: compiled.isFeeEditable,
          isAlreadyPaid: (appointment as any).paymentStatus === "paid",
        },
        "Consolidated checkout preview compiled successfully"
      )
    );
  } catch (err: any) {
    console.error("getConsolidatedCheckoutPreview error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function processConsolidatedCheckout(req: FastifyRequest, reply: FastifyReply) {
  try {
    const body = req.body as any;
    const key = mutationKey(req);
    const { appointmentId, paymentMethod = "cash", amountPaid, discount = 0, referenceNumber, notes } = body;
    const fee = body.customConsultFee ?? body.customConsultationFee;
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) return reply.code(400).send(errorResponse("Valid appointmentId is required"));
    for (const value of [amountPaid, discount, fee]) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9)) return reply.code(400).send(errorResponse("Amounts must be finite nonnegative numbers"));
    }
    if (!["cash", "card", "upi", "net-banking", "insurance", "online"].includes(paymentMethod)) return reply.code(400).send(errorResponse("Invalid payment method"));
    const original = await Appointment.findById(appointmentId);
    if (!original) return reply.code(404).send(errorResponse("Appointment not found"));
    const access = await checkOperationalRecordAccess(req, original);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    if (!(await canUseIndianBilling(String(original.locationId)))) return reply.code(409).send(errorResponse(INDIA_BILLING_ONLY));
    const invoice = await withTransaction(async () => {
      // Serialize all checkout requests for this visit, including distinct keys.
      const appointment = await Appointment.findOneAndUpdate({ _id: appointmentId, organizationId: original.organizationId }, { $inc: { __v: 1 } }, { returnDocument: "after" });
      if (!appointment) throw Object.assign(new Error("Appointment not found"), { statusCode: 404 });
      const operation = await claimMutation('checkout:' + original.organizationId + ':' + appointmentId, key, body);
      if (operation.replay) return Invoice.findById(operation.receipt.resultId);
      let invoice: any = appointment.invoiceId ? await Invoice.findById(appointment.invoiceId) : await Invoice.findOne({ appointmentId: appointment._id, organizationId: appointment.organizationId, deletedAt: null });
      if (invoice && (invoice.amountPaid > 0 || ["paid", "refunded", "cancelled"].includes(invoice.status))) throw Object.assign(new Error("Existing payments cannot be rewritten. Use the installment or adjustment workflow."), { statusCode: 409 });
      if (fee !== undefined) { appointment.customConsultationFee = fee; appointment.paymentAmount = fee; await appointment.save(); }
      const { compileAppointmentCharges } = await import("../services/ChargeCaptureService.ts");
      const { generateLocationInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
      const compiled = await compileAppointmentCharges(appointmentId, fee);
      const tax = compiled.cgstTotal + compiled.sgstTotal + compiled.igstTotal;
      if (![compiled.subtotal, tax].every(value => Number.isFinite(value) && value >= 0) || compiled.items.some(item => ![item.amount, item.quantity, item.gstRate].every(value => Number.isFinite(value) && value >= 0))) throw Object.assign(new Error("Invalid configured charges; review the service catalog"), { statusCode: 409 });
      if (discount > compiled.subtotal + tax) throw Object.assign(new Error("Discount exceeds invoice total"), { statusCode: 400 });
      const total = Number((compiled.subtotal + tax - discount).toFixed(2));
      const paid = amountPaid ?? total;
      if (paid > total) throw Object.assign(new Error("Payment exceeds balance due"), { statusCode: 400 });
      const balance = Number((total - paid).toFixed(2));
      const items = compiled.items.map(item => {
        const base = item.amount * item.quantity;
        const cgstAmount = Number((base * item.gstRate / 200).toFixed(2));
        const sgstAmount = cgstAmount;
        return { ...item, cgstAmount, sgstAmount, igstAmount: 0, totalItemAmount: Number((base + cgstAmount + sgstAmount).toFixed(2)) };
      });
      if (!invoice) invoice = new Invoice({ invoiceNumber: await generateLocationInvoiceNumber(String(appointment.locationId)), generationKey: 'appointment:' + appointmentId,
        organizationId: appointment.organizationId, locationId: appointment.locationId, patientId: appointment.patientId, doctorId: appointment.doctorId, appointmentId: appointment._id });
      Object.assign(invoice, { items, subtotal: compiled.subtotal, taxableAmount: compiled.subtotal, tax, cgstTotal: compiled.cgstTotal, sgstTotal: compiled.sgstTotal, igstTotal: compiled.igstTotal,
        discount, totalAmount: total, amountPaid: paid, balanceDue: balance, status: balance === 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid", paymentMethod, paymentDate: paid > 0 ? new Date() : undefined });
      if (paid > 0) invoice.payments.push({ amount: paid, operationKey: key, paymentMethod, referenceNumber, notes, paidAt: new Date() });
      await invoice.save();
      appointment.invoiceId = invoice._id;
      appointment.paymentAmount = total;
      appointment.paymentStatus = balance === 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
      await appointment.save();
      await AuditLog.create({ organizationId: appointment.organizationId, userId: req.user!.id, category: "BILLING", action: "CONSOLIDATED_OPD_CHECKOUT", targetId: invoice._id, targetModel: "Invoice", details: { appointmentId, amountPaid: paid, grandTotal: total, operationKey: key } });
      operation.receipt.resultId = invoice._id;
      await operation.receipt.save();
      return invoice;
    });
    const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
    if (!invoice) throw Object.assign(new Error("Recorded checkout needs reconciliation"), { statusCode: 409 });
    broadcastQueueUpdate(String(original.locationId), { type: "QUEUE_UPDATED", data: { appointmentId, invoiceId: invoice._id }, timestamp: new Date().toISOString() });
    return reply.code(200).send(successResponse(invoice, "Checkout recorded"));
  } catch (error: any) {
    return reply.code(error.statusCode || 500).send(errorResponse(error.statusCode ? error.message : "Checkout could not be completed"));
  }
}
