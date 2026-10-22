import type { FastifyInstance } from "fastify";
import { readCashierDrawer, postCashierDrawer, getCashierDrawerOperation } from "../controllers/cashierDrawer.ts";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, requirePlatformRoot, denyRoles } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { createInvoiceSchema, collectPaymentSchema, installmentSchema, consolidatedCheckoutSchema, productQuoteSchema } from "../schemas/billing.ts";
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
  quoteProductsController,
  getSubscriptionDetails,
  getOrganizationUsageMetrics,
  createCheckoutOrderController,
  validatePlanDowngradeController,
  directSwitchPlanController,
  verifyPaymentController,
  getCheckoutStatusController,
  abandonCheckoutController,
  razorpayWebhookController,
  cancelSubscriptionController,
  getSaaSInvoices,
  getPaymentAttempts,
  getBillingDetails,
  saveBillingDetails,
  adminGetPaymentReviews,
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
  const checkSaaSPermission = checkAnyPermission("MANAGE_ORGANIZATION");
  const manageSaaS = { preHandler: [authenticate, denyRoles("patient", "family_member", "guest"),
    async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      if (req.user?.impersonatedBy?.originalRole === "root" && req.user.organization_id) return;
      return checkSaaSPermission(req, reply);
    },
    async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      const scope = resolveAuthorizedOrganizationScope(req);
      if (!scope.allowed) return reply.code(scope.statusCode).send({ error: scope.message });
    }] };
  const rootAdminAuth = { preHandler: [authenticate, requirePlatformRoot()] };
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
  app.get("/api/billing/till/drawers", manageInvoices, readCashierDrawer(false, "billing"));
  app.get("/api/billing/till/drawers/history", manageInvoices, readCashierDrawer(true, "billing"));
  app.get("/api/billing/till/drawers/:id", manageInvoices, readCashierDrawer(false, "billing"));
  app.post("/api/billing/till/drawers/open", manageInvoices, postCashierDrawer("open", "billing"));
  app.post("/api/billing/till/drawers/:id/close", manageInvoices, postCashierDrawer("close", "billing"));
  app.post("/api/billing/till/drawers/:id/movements", manageInvoices, postCashierDrawer("movement", "billing"));
  app.get("/api/billing/till/drawer-operations/:key", manageInvoices, getCashierDrawerOperation("billing"));

  // ─── Commercial SaaS Plans & Subscriptions ─────────────────────
  // Public Plans Listing
  app.get("/api/billing/plans", getSaaSPlans);
  app.post("/api/billing/quote", { preHandler: [...manageSaaS.preHandler, denyRoles("patient", "family_member", "guest")], schema: productQuoteSchema }, quoteProductsController);

  // Authenticated Organization Subscription & Usage
  app.get("/api/billing/subscription", manageSaaS, getSubscriptionDetails);
  app.get("/api/billing/usage", manageSaaS, getOrganizationUsageMetrics);
  app.get("/api/billing/saas-invoices", manageSaaS, getSaaSInvoices);
  app.get("/api/billing/payment-attempts", manageSaaS, getPaymentAttempts);
  app.get("/api/billing/details", manageSaaS, getBillingDetails);
  app.put("/api/billing/details", manageSaaS, saveBillingDetails);

  // Razorpay Checkout, Verification & Cancellation
  app.post("/api/billing/checkout", manageSaaS, createCheckoutOrderController);
  app.post("/api/billing/validate-downgrade", manageSaaS, validatePlanDowngradeController);
  app.post("/api/billing/switch-plan", manageSaaS, directSwitchPlanController);
  app.post("/api/billing/verify-payment", manageSaaS, verifyPaymentController);
  app.get("/api/billing/checkout-status", manageSaaS, getCheckoutStatusController);
  app.post("/api/billing/checkout/abandon", manageSaaS, abandonCheckoutController);
  app.post("/api/billing/cancel", manageSaaS, cancelSubscriptionController);

  // Razorpay Webhook Endpoint (No Auth header, verified via HMAC signature)
  app.post("/api/billing/webhook", razorpayWebhookController);

  // ─── Platform Admin Subscription Console ───────────────────────
  app.get("/api/admin/billing/plans", rootAdminAuth, adminGetPlans);
  app.post("/api/admin/billing/plans", rootAdminAuth, adminUpsertPlan);
  app.get("/api/admin/billing/subscriptions", rootAdminAuth, adminGetSubscriptions);
  app.get("/api/admin/billing/payment-reviews", rootAdminAuth, adminGetPaymentReviews);
  app.post("/api/admin/billing/subscriptions/:id/extend-trial", rootAdminAuth, adminExtendTrial);
  app.post("/api/admin/billing/subscriptions/:id/activate", rootAdminAuth, adminActivateSubscription);
  app.post("/api/admin/billing/payments/:paymentId/refund", rootAdminAuth, adminRefundPayment);
  app.get("/api/admin/billing/razorpay-config", rootAdminAuth, adminGetRazorpayConfig);
  app.post("/api/admin/billing/razorpay-config", rootAdminAuth, adminSaveRazorpayConfig);

  // ─── Clinical / Patient Medical Invoices & Payment Collections ──
  app.post("/api/invoices", { ...manageInvoices, schema: createInvoiceSchema }, createInvoice);
  app.get("/api/invoices", viewInvoices, getInvoices);
  app.get("/api/invoices/patient/me", viewInvoices, getInvoices);
  app.get("/api/invoices/:id", viewInvoices, getInvoiceDetails);
  app.put("/api/invoices/:id/pay", { ...manageInvoices, schema: collectPaymentSchema }, collectPayment);
  app.post("/api/invoices/:id/payments", { ...manageInvoices, schema: installmentSchema }, recordPartialPayment);

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
  app.post("/api/billing/checkout/consolidate", { ...manageInvoices, schema: consolidatedCheckoutSchema }, processConsolidatedCheckout);

  // ─── Cashier Till Reconciliation & Shift Close (Z-Report) ────────
  app.get("/api/billing/till/summary", manageInvoices, getTillSummary);
  app.post("/api/billing/till/close", manageInvoices, closeTill);
  app.get("/api/billing/till/history", manageInvoices, getTillHistory);
}
