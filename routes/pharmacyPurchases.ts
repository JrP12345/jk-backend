import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { requirePharmacyStaff, requirePharmacyAction } from "../middleware/pharmacyGuard.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { listPharmacyParties, listPharmacyPurchases, listPharmacyPurchaseProducts, readPharmacyParty, readPharmacyPurchase, writePharmacyParty, writePharmacyPurchase, postPurchase, receivePurchase, recoverPurchase, listPurchaseReceipts } from "../controllers/pharmacyPurchases.ts";
import { readSupplierReturnSource, previewSupplierReturn, postSupplierReturn, recoverSupplierReturn } from "../controllers/pharmacyPurchaseReturns.ts";
export default async function pharmacyPurchaseRoutes(app: FastifyInstance) {
  const view = { preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy"), requirePharmacyAction("viewPurchases")] };
  const manage = { preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy"), requirePharmacyAction("managePurchases")] };
  app.get("/api/pharmacy/parties", view, listPharmacyParties);
  app.get("/api/pharmacy/parties/:id", view, readPharmacyParty);
  app.post("/api/pharmacy/parties", manage, writePharmacyParty);
  app.put("/api/pharmacy/parties/:id", manage, writePharmacyParty);
  app.get("/api/pharmacy/purchases", view, listPharmacyPurchases);
  app.get("/api/pharmacy/purchase-products", view, listPharmacyPurchaseProducts);
  app.get("/api/pharmacy/purchases/:id", view, readPharmacyPurchase);
  app.post("/api/pharmacy/purchases", manage, writePharmacyPurchase);
  app.put("/api/pharmacy/purchases/:id", manage, writePharmacyPurchase);
  app.post("/api/pharmacy/purchases/:id/post", manage, postPurchase);
  app.post("/api/pharmacy/purchases/:id/receipts", { preHandler: [...manage.preHandler, requirePharmacyAction("receiveStock")] }, receivePurchase);
  app.get("/api/pharmacy/purchases/:id/receipts", view, listPurchaseReceipts);
  app.get("/api/pharmacy/purchases/:id/operations/:kind/:key", view, recoverPurchase);
  app.get("/api/pharmacy/purchases/:id/return-source", view, readSupplierReturnSource);
  const returns = { preHandler: [...view.preHandler, requirePharmacyAction("processReturn")] };
  app.post("/api/pharmacy/purchases/:id/returns/quote", returns, previewSupplierReturn);
  app.post("/api/pharmacy/purchases/:id/returns", returns, postSupplierReturn);
  app.get("/api/pharmacy/purchase-return-operations/:key", view, recoverSupplierReturn);
}
