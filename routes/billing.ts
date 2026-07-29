import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import { createInvoiceSchema, collectPaymentSchema } from "../schemas/billing.ts";
import {
  createInvoice,
  getInvoices,
  getInvoiceDetails,
  collectPayment,
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
  adminRefundPayment,
  adminGetRazorpayConfig,
  adminSaveRazorpayConfig,
} from "../controllers/billing.ts";

export default async function billingRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const rootAdminAuth = { preHandler: [authenticate, authorize("root")] };

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
  app.post("/api/admin/billing/payments/:paymentId/refund", rootAdminAuth, adminRefundPayment);
  app.get("/api/admin/billing/razorpay-config", rootAdminAuth, adminGetRazorpayConfig);
  app.post("/api/admin/billing/razorpay-config", rootAdminAuth, adminSaveRazorpayConfig);

  // ─── Clinical / Patient Medical Invoices & Payment Collections ──
  app.post("/api/invoices", { ...auth, schema: createInvoiceSchema }, createInvoice);
  app.get("/api/invoices", auth, getInvoices);
  app.get("/api/invoices/:id", auth, getInvoiceDetails);
  app.put("/api/invoices/:id/pay", { ...auth, schema: collectPaymentSchema }, collectPayment);

  // Online Payment Link Generation (for Patient Medical Invoices)
  app.post("/api/billing/payment-link", auth, createPaymentLinkController);

  // Medical Insurance Claims & Adjudication
  app.post("/api/billing/claims", auth, createClaimController);
  app.get("/api/billing/claims", auth, getClaimsController);
  app.post("/api/billing/claims/:id/adjudicate", auth, adjudicateClaimController);
}
