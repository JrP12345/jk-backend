import type { FastifyRequest, FastifyReply } from "fastify";
import { Claim } from "../models/Claim.ts";
import { Invoice } from "../models/Invoice.ts";
import { Patient } from "../models/Patient.ts";
import { paymentProvider } from "../services/payment/PaymentProvider.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import crypto from "node:crypto";

// ─── POST /api/billing/claims ──────────────────────────────────────────
export async function createClaimController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
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

    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));
    if (!clinicId || !patientId || !payerName || !policyNumber || !totalClaimAmount) {
      return reply.code(400).send(errorResponse("clinicId, patientId, payerName, policyNumber, and totalClaimAmount are required"));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) return reply.code(404).send(errorResponse("Patient not found"));

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

    const filter: any = {};
    if (orgId && req.user?.role !== "root") filter.organizationId = orgId;
    if (patientId) filter.patientId = patientId;
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
