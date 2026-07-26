import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
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

export default async function billingRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // Medical Invoices & Payment Collections
  app.post("/api/invoices", { ...auth, schema: createInvoiceSchema }, createInvoice);
  app.get("/api/invoices", auth, getInvoices);
  app.get("/api/invoices/:id", auth, getInvoiceDetails);
  app.put("/api/invoices/:id/pay", { ...auth, schema: collectPaymentSchema }, collectPayment);

  // Online Payment Link Generation
  app.post("/api/billing/payment-link", auth, createPaymentLinkController);

  // Medical Insurance Claims & Adjudication
  app.post("/api/billing/claims", auth, createClaimController);
  app.get("/api/billing/claims", auth, getClaimsController);
  app.post("/api/billing/claims/:id/adjudicate", auth, adjudicateClaimController);
}
