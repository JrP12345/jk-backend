import type { FastifyInstance } from "fastify";
import { authenticate, authorize, checkAnyPermission, checkAnyPermissionOrRoles } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { createInvoiceSchema, collectPaymentSchema } from "../schemas/billing.ts";
import {
  createInvoice,
  getInvoices,
  getInvoiceDetails,
  collectPayment,
  getEncounterChargesPreview,
  autoGenerateInvoiceForEncounter,
  recordPartialPayment,
  getConsolidatedCheckoutPreview,
  processConsolidatedCheckout,
} from "../controllers/invoice.ts";
import {
  createClaimController,
  adjudicateClaimController,
  getClaimsController,
  createPaymentLinkController,
} from "../controllers/claim.ts";
import {
  getSaaSPlans,
  getSubscriptionDetails,
  getOrganizationUsageMetrics,
  createCheckoutOrderController,
  verifyPaymentController,
  razorpayWebhookController,
  cancelSubscriptionController,
  getSaaSInvoices,
  adminGetPlans,
  adminUpsertPlan,
  adminGetSubscriptions,
  adminExtendTrial,
  adminActivateSubscription,
  adminRefundPayment,
  adminGetRazorpayConfig,
  adminSaveRazorpayConfig,
} from "../controllers/billing.ts";
import {
  getTillSummary,
  closeTill,
  getTillHistory,
} from "../controllers/cashierShift.ts";

export default async function billingRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const rootAdminAuth = { preHandler: [authenticate, authorize("root")] };
  const viewInvoices = {
    preHandler: [authenticate, requireModule("billing"), checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_BILLING", "MANAGE_BILLING")],
  };
  const manageInvoices = {
    preHandler: [authenticate, requireModule("billing"), checkAnyPermission("MANAGE_BILLING")],
  };
  const encounterBilling = {
    preHandler: [
      authenticate,
      requireModule("billing"),
      requireModule("consultations"),
      checkAnyPermission("MANAGE_BILLING"),
    ],
  };

  // ─── Commercial SaaS Plans & Subscriptions ─────────────────────
  // Public Plans Listing
  app.get("/api/billing/plans", getSaaSPlans);

  // Authenticated Organization Subscription & Usage
  app.get("/api/billing/subscription", auth, getSubscriptionDetails);
  app.get("/api/billing/usage", auth, getOrganizationUsageMetrics);
  app.get("/api/billing/saas-invoices", auth, getSaaSInvoices);

  // Razorpay Checkout, Verification & Cancellation
  app.post("/api/billing/checkout", auth, createCheckoutOrderController);
  app.post("/api/billing/verify-payment", auth, verifyPaymentController);
  app.post("/api/billing/cancel", auth, cancelSubscriptionController);

  // Razorpay Webhook Endpoint (No Auth header, verified via HMAC signature)
  app.post("/api/billing/webhook", razorpayWebhookController);

  // ─── Platform Admin Subscription Console ───────────────────────
  app.get("/api/admin/billing/plans", rootAdminAuth, adminGetPlans);
  app.post("/api/admin/billing/plans", rootAdminAuth, adminUpsertPlan);
  app.get("/api/admin/billing/subscriptions", rootAdminAuth, adminGetSubscriptions);
  app.post("/api/admin/billing/subscriptions/:id/extend-trial", rootAdminAuth, adminExtendTrial);
  app.post("/api/admin/billing/subscriptions/:id/activate", rootAdminAuth, adminActivateSubscription);
  app.post("/api/admin/billing/payments/:paymentId/refund", rootAdminAuth, adminRefundPayment);
  app.get("/api/admin/billing/razorpay-config", rootAdminAuth, adminGetRazorpayConfig);
  app.post("/api/admin/billing/razorpay-config", rootAdminAuth, adminSaveRazorpayConfig);

  // ─── Clinical / Patient Medical Invoices & Payment Collections ──
  app.post("/api/invoices", { ...manageInvoices, schema: createInvoiceSchema }, createInvoice);
  app.get("/api/invoices", viewInvoices, getInvoices);
  app.get("/api/invoices/:id", viewInvoices, getInvoiceDetails);
  app.put("/api/invoices/:id/pay", { ...manageInvoices, schema: collectPaymentSchema }, collectPayment);
  app.post("/api/invoices/:id/payments", manageInvoices, recordPartialPayment);

  // Auto Charge Capture from Encounter
  app.get("/api/encounters/:encounterId/charges-preview", encounterBilling, getEncounterChargesPreview);
  app.post("/api/encounters/:encounterId/auto-invoice", encounterBilling, autoGenerateInvoiceForEncounter);

  // Online Payment Link Generation (for Patient Medical Invoices)
  app.post("/api/billing/payment-link", manageInvoices, createPaymentLinkController);

  // Medical Insurance Claims & Adjudication
  app.post("/api/billing/claims", manageInvoices, createClaimController);
  app.get("/api/billing/claims", viewInvoices, getClaimsController);
  app.post("/api/billing/claims/:id/adjudicate", manageInvoices, adjudicateClaimController);

  // ─── 1-Click Consolidated Outpatient Checkout ────────────────────
  app.get("/api/billing/checkout/preview/:appointmentId", manageInvoices, getConsolidatedCheckoutPreview);
  app.post("/api/billing/checkout/consolidate", manageInvoices, processConsolidatedCheckout);

  // ─── Cashier Till Reconciliation & Shift Close (Z-Report) ────────
  app.get("/api/billing/till/summary", manageInvoices, getTillSummary);
  app.post("/api/billing/till/close", manageInvoices, closeTill);
  app.get("/api/billing/till/history", manageInvoices, getTillHistory);
}
