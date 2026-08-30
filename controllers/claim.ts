import type { FastifyRequest, FastifyReply } from "fastify";
import { Claim } from "../models/Claim.ts";
import { Invoice } from "../models/Invoice.ts";
import { Patient } from "../models/Patient.ts";
import { paymentProvider } from "../services/payment/PaymentProvider.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, getRequestClinicIds, resolveTargetOrganizationId } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

// ─── POST /api/billing/claims ──────────────────────────────────────────
export async function createClaimController(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId = await resolveTargetOrganizationId(req);
    const {
      clinicId,
      patientId,
      invoiceId,
      payerName,
      policyNumber,
      preAuthCode,
      totalClaimAmount,
    } = req.body as {
      clinicId: string;
      patientId: string;
      invoiceId?: string;
      payerName: string;
      policyNumber: string;
      preAuthCode?: string;
      totalClaimAmount: number;
    };

    if (!clinicId || !patientId || !payerName || !policyNumber || totalClaimAmount === undefined) {
      return reply.code(400).send(errorResponse("clinicId, patientId, payerName, policyNumber, and totalClaimAmount are required"));
    }
    if (!mongoose.Types.ObjectId.isValid(clinicId) || !mongoose.Types.ObjectId.isValid(patientId) || (invoiceId && !mongoose.Types.ObjectId.isValid(invoiceId))) {
      return reply.code(400).send(errorResponse("Invalid clinic, patient, or invoice ID"));
    }
    if (!Number.isFinite(totalClaimAmount) || totalClaimAmount <= 0) {
      return reply.code(400).send(errorResponse("totalClaimAmount must be greater than zero"));
    }
    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    if (!orgId && clinicAccess.organizationId) {
      orgId = clinicAccess.organizationId;
    }
    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));

    const patient = await Patient.findById(patientId);
    if (!patient) return reply.code(404).send(errorResponse("Patient not found"));
    if (patient.organizationId && clinicAccess.organizationId && patient.organizationId.toString() !== clinicAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    if (invoiceId) {
      const invoice = await Invoice.findById(invoiceId).lean() as any;
      if (!invoice) return reply.code(404).send(errorResponse("Invoice not found"));
      const invoiceAccess = await checkOperationalRecordAccess(req, invoice);
      if (!invoiceAccess.allowed) return sendTenantError(reply, invoiceAccess);
      if (invoice.patientId.toString() !== patientId || invoice.clinicId.toString() !== clinicId) {
        return reply.code(400).send(errorResponse("Invoice does not match the claim patient and clinic"));
      }
    }

    const claimNumber = `CLM-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const claim = await Claim.create({
      claimNumber,
      organizationId: orgId,
      clinicId,
      patientId,
      invoiceId: invoiceId || null,
      payerName,
      policyNumber,
      preAuthCode: preAuthCode || "",
      totalClaimAmount,
      status: "submitted",
      submittedAt: new Date(),
    });

    return reply.code(201).send(successResponse(claim, "Insurance claim submitted successfully"));
  } catch (err) {
    console.error("createClaimController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/billing/claims/:id/adjudicate ──────────────────────────
export async function adjudicateClaimController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { status, approvedAmount, copayAmount, deductibleAmount, rejectionReason } = req.body as {
      status: "approved" | "rejected" | "settled" | "under_review";
      approvedAmount?: number;
      copayAmount?: number;
      deductibleAmount?: number;
      rejectionReason?: string;
    };

    if (!status || !["approved", "rejected", "settled", "under_review"].includes(status)) {
      return reply.code(400).send(errorResponse("Valid status (approved, rejected, settled, under_review) is required"));
    }

    const claim = await Claim.findById(id);
    if (!claim) return reply.code(404).send(errorResponse("Insurance claim not found"));
    const claimAccess = await checkOperationalRecordAccess(req, claim);
    if (!claimAccess.allowed) return sendTenantError(reply, claimAccess);
    if (! ["admin", "receptionist", "cashier", "root"].includes(req.user?.role || "")) {
      return reply.code(403).send(errorResponse("Only billing staff can adjudicate claims"));
    }
    const allowedTransitions: Record<string, string[]> = {
      submitted: ["under_review", "approved", "rejected"],
      under_review: ["approved", "rejected"],
      approved: ["settled"],
      rejected: [],
      settled: [],
    };
    if (!allowedTransitions[claim.status]?.includes(status)) {
      return reply.code(400).send(errorResponse(`Cannot transition claim from ${claim.status} to ${status}`));
    }
    for (const value of [approvedAmount, copayAmount, deductibleAmount]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > claim.totalClaimAmount)) {
        return reply.code(400).send(errorResponse("Claim adjudication amounts must be non-negative and no greater than the claim total"));
      }
    }

    claim.status = status;
    if (approvedAmount !== undefined) claim.approvedAmount = approvedAmount;
    if (copayAmount !== undefined) claim.copayAmount = copayAmount;
    if (deductibleAmount !== undefined) claim.deductibleAmount = deductibleAmount;
    if (rejectionReason !== undefined) claim.rejectionReason = rejectionReason;
    claim.adjudicatedAt = new Date();

    await claim.save();

    return reply.code(200).send(successResponse(claim, "Insurance claim adjudicated successfully"));
  } catch (err) {
    console.error("adjudicateClaimController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/billing/claims ───────────────────────────────────────────
export async function getClaimsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const { patientId, status } = req.query as { patientId?: string; status?: string };

    const filter: any = { deletedAt: null };
    if (orgId && req.user?.role !== "root") filter.organizationId = orgId;
    if (patientId) {
      if (!mongoose.Types.ObjectId.isValid(patientId)) return reply.code(400).send(errorResponse("Invalid patient ID"));
      if (req.user?.role === "patient") {
        const patient = await Patient.findOne({ userId: req.user.id }).select("_id").lean();
        if (!patient || patient._id.toString() !== patientId) return reply.code(404).send(successResponse([]));
      }
      filter.patientId = patientId;
    } else if (req.user?.role === "patient") {
      const patient = await Patient.findOne({ userId: req.user.id }).select("_id").lean();
      if (!patient) return reply.code(200).send(successResponse([]));
      filter.patientId = patient._id;
    }
    if (status) filter.status = status;

    const claims = await Claim.find(filter).sort({ createdAt: -1 }).lean();
    return reply.code(200).send(successResponse(claims));
  } catch (err) {
    console.error("getClaimsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/billing/payment-link ───────────────────────────────────
export async function createPaymentLinkController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { invoiceId, amount, customerEmail, description } = req.body as {
      invoiceId: string;
      amount: number;
      customerEmail?: string;
      description?: string;
    };

    if (!invoiceId || !amount) {
      return reply.code(400).send(errorResponse("invoiceId and amount are required"));
    }
    if (!mongoose.Types.ObjectId.isValid(invoiceId) || !Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send(errorResponse("Valid invoiceId and positive amount are required"));
    }
    const invoice = await Invoice.findById(invoiceId).lean() as any;
    if (!invoice) return reply.code(404).send(errorResponse("Invoice not found"));
    const invoiceAccess = await checkOperationalRecordAccess(req, invoice);
    if (!invoiceAccess.allowed) return sendTenantError(reply, invoiceAccess);
    if (req.user?.role === "patient") {
      const patient = await Patient.findOne({ userId: req.user.id }).select("_id").lean();
      if (!patient || invoice.patientId.toString() !== patient._id.toString()) return reply.code(404).send(errorResponse("Invoice not found"));
    } else if (!["admin", "receptionist", "cashier", "root"].includes(req.user?.role || "")) {
      return reply.code(403).send(errorResponse("Only the patient or billing staff can create payment links"));
    }
    const balanceDue = invoice.balanceDue ?? (invoice.totalAmount - (invoice.amountPaid || 0));
    if (amount > balanceDue + 0.01) return reply.code(400).send(errorResponse("Payment amount exceeds balance due"));

    const result = await paymentProvider.createPaymentLink({
      invoiceId,
      amount,
      customerEmail,
      description: description || `Medical Invoice #${invoiceId}`,
    });

    return reply.code(200).send(successResponse(result, "Online payment link generated successfully"));
  } catch (err) {
    console.error("createPaymentLinkController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
