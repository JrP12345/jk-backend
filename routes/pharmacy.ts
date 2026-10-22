import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { requirePharmacyStaff, requirePharmacyAction } from "../middleware/pharmacyGuard.ts";
import { getPharmacyCapabilities, getPharmacySettings, savePharmacySettings, getPharmacyRolePresets } from "../controllers/pharmacySettings.ts";
import { pharmacySettingsSchema } from "../schemas/pharmacySettings.ts";
import pharmacyPurchaseRoutes from "./pharmacyPurchases.ts";
import { postCounterInvoice, getCounterOperation, getCounterInvoice, listCounterInvoices, postCounterQuote, searchCounterProducts, searchCounterCustomers } from "../controllers/pharmacySales.ts";
import { postPharmacyCollection, payPharmacyInvoice, getPharmacyCollectionOperation, listPharmacyCollections } from "../controllers/pharmacyCollections.ts";
import { postPharmacyStockReceipt, getPharmacyStockReceipt } from "../controllers/pharmacyStockReceipts.ts";
import { listReturnInvoices, getReturnSource, quoteReturn, postReturn, getReturnOperation, getReturn } from "../controllers/pharmacyReturns.ts";
import { postPharmacySettlement, getPharmacySettlementOperation, getPharmacyRefundSource, getPharmacySupplierStatement, getPharmacyCustomerStatement, listPharmacySettlementParties, listPharmacyRefundInvoices } from "../controllers/pharmacySettlements.ts";
import { postOpeningBalance, getOpeningBalance, getOpeningBalanceOperation } from "../controllers/pharmacyOpeningBalances.ts";
import { assertMedicineBodyTypes } from "../utilities/medicineCatalogue.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { errorResponse } from "../utilities/helpers.ts";
import type { PharmacyAction } from "../utilities/pharmacyPermissions.ts";
import { readCashierDrawer, postCashierDrawer, getCashierDrawerOperation } from "../controllers/cashierDrawer.ts";
import { getPharmacyReportCatalogue, getPharmacyReport } from "../controllers/pharmacyReports.ts";
import { postPharmacyImport, getPharmacyImport, listPharmacyImports } from "../controllers/pharmacyImports.ts";
import { createMedicineSchema, updateMedicineSchema, medicineListSchema, dispensePrescriptionSchema, stockAdjustmentSchema } from "../schemas/clinical.ts";
import { getPharmacyTaxProfile, savePharmacyTaxProfile, reviewMedicineTax } from "../controllers/pharmacyTax.ts";
import { pharmacyTaxProfileSchema, medicineTaxReviewSchema } from "../schemas/pharmacyTax.ts";
import { getPharmacyProfessionalReview, savePharmacyProfessionalReview, reviewMedicineDispensing } from "../controllers/pharmacyDispensing.ts";
import { pharmacyProfessionalReviewSchema, pharmacyDispensingReviewSchema } from "../schemas/pharmacyDispensing.ts";
import {
  createMedicine,
  getMedicines,
  updateMedicine,
  deleteMedicine,
  dispensePrescription,
  getPendingPrescriptionsController,
  createMedicineBatch,
  getMedicineBatches,
  getExpiringMedicinesController,
  adjustStock,
  getStockMovements,
  getDispenseOperationController,
} from "../controllers/medicine.ts";

export default async function pharmacyRoutes(app: FastifyInstance) {
  await app.register(pharmacyPurchaseRoutes);
  const validateMedicineTypes = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    try { assertMedicineBodyTypes(req.body); }
    catch (error) { return reply.code(error instanceof CommandError ? error.statusCode : 400).send(errorResponse(error instanceof Error ? error.message : "Invalid medicine fields")); }
  };
  const action = (permission: PharmacyAction) => ({ preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy"), requirePharmacyAction(permission)] });
  const imports = { preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy")] };
  app.post("/api/pharmacy/imports/inspect", imports, postPharmacyImport("inspect"));
  app.post("/api/pharmacy/imports/preview", imports, postPharmacyImport("preview"));
  app.get("/api/pharmacy/imports", imports, listPharmacyImports);
  app.get("/api/pharmacy/imports/:id", imports, getPharmacyImport());
  app.get("/api/pharmacy/imports/:id/export", imports, getPharmacyImport(true));
  app.post("/api/pharmacy/imports/:id/commit", imports, postPharmacyImport("commit"));
  const settings = { preHandler: [authenticate, requirePharmacyStaff, requirePharmacyAction("manageSettings")] };
  const transfers = action("transferStock");
  const { pharmacyTransferController } = await import("../controllers/pharmacyTransfers.ts");
  app.get("/api/pharmacy/transfer-products", transfers, pharmacyTransferController("products"));
  app.get("/api/pharmacy/transfer-source-lots", transfers, pharmacyTransferController("lots"));
  app.get("/api/pharmacy/transfers", transfers, pharmacyTransferController("list"));
  app.get("/api/pharmacy/transfers/:id", transfers, pharmacyTransferController("read"));
  app.get("/api/pharmacy/transfer-operations/:key", transfers, pharmacyTransferController("recover"));
  app.post("/api/pharmacy/transfers", transfers, pharmacyTransferController("create"));
  for (const stage of ["approve", "dispatch", "receive", "resolve", "cancel"] as const) app.post(`/api/pharmacy/transfers/:id/${stage}`, transfers, pharmacyTransferController(stage));
  app.get("/api/pharmacy/reports", action("viewReports"), getPharmacyReportCatalogue);
  app.get("/api/pharmacy/reports/:kind", action("viewReports"), getPharmacyReport());
  app.get("/api/pharmacy/reports/:kind/export", action("viewReports"), getPharmacyReport(true));
  app.get("/api/pharmacy/stock-alerts/:kind", action("viewStock"), getPharmacyReport(false, true));
  app.get("/api/pharmacy/till", action("viewTill"), readCashierDrawer());
  app.get("/api/pharmacy/till/history", action("viewTill"), readCashierDrawer(true));
  app.get("/api/pharmacy/till/:id", action("viewTill"), readCashierDrawer());
  app.post("/api/pharmacy/till/open", action("openTill"), postCashierDrawer("open"));
  app.post("/api/pharmacy/till/:id/close", action("closeTill"), postCashierDrawer("close"));
  app.post("/api/pharmacy/till/:id/movements", action("moveTillCash"), postCashierDrawer("movement"));
  app.get("/api/pharmacy/till-operations/:key", action("viewTill"), getCashierDrawerOperation());
  app.post("/api/pharmacy/sales", action("sell"), postCounterInvoice);
  app.post("/api/pharmacy/sales/quote", action("sell"), postCounterQuote);
  app.get("/api/pharmacy/sales/products", action("sell"), searchCounterProducts);
  app.get("/api/pharmacy/sales/customers", action("sell"), searchCounterCustomers);
  app.get("/api/pharmacy/sale-operations/:key", action("viewSales"), getCounterOperation);
  app.get("/api/pharmacy/invoices", action("viewSales"), listCounterInvoices);
  app.get("/api/pharmacy/invoices/:id", action("viewSales"), getCounterInvoice);
  app.post("/api/pharmacy/invoices/:id/collections", action("collect"), postPharmacyCollection);
  app.post("/api/pharmacy/invoices/:id/pay", action("collect"), payPharmacyInvoice);
  app.get("/api/pharmacy/invoices/:id/collections", action("viewSales"), listPharmacyCollections);
  app.get("/api/pharmacy/collection-operations/:key", action("viewSales"), getPharmacyCollectionOperation);
  app.get("/api/pharmacy/return-invoices", action("viewReturns"), listReturnInvoices);
  app.get("/api/pharmacy/invoices/:id/return-source", action("viewReturns"), getReturnSource);
  app.post("/api/pharmacy/invoices/:id/returns/quote", action("processReturn"), quoteReturn);
  app.post("/api/pharmacy/invoices/:id/returns", { preHandler: [...action("processReturn").preHandler, requirePharmacyAction("approveReturn")] }, postReturn);
  app.get("/api/pharmacy/return-operations/:key", action("viewReturns"), getReturnOperation);
  app.get("/api/pharmacy/returns/:id", action("viewReturns"), getReturn);
  app.post("/api/pharmacy/settlements/:kind", action("settle"), postPharmacySettlement);
  app.get("/api/pharmacy/cash-operations/:key", action("viewSettlements"), getPharmacySettlementOperation);
  app.get("/api/pharmacy/settlement-parties", action("viewSettlements"), listPharmacySettlementParties);
  app.get("/api/pharmacy/refund-invoices", action("viewReturns"), listPharmacyRefundInvoices);
  app.get("/api/pharmacy/invoices/:id/refund-source", action("viewReturns"), getPharmacyRefundSource);
  app.get("/api/pharmacy/suppliers/:id/statement", action("viewPurchases"), getPharmacySupplierStatement);
  app.get("/api/pharmacy/customers/:id/statement", action("viewReturns"), getPharmacyCustomerStatement);
  app.post("/api/pharmacy/opening-balances", action("openingBalances"), postOpeningBalance);
  app.get("/api/pharmacy/opening-balances/:id", action("viewSettlements"), getOpeningBalance);
  app.get("/api/pharmacy/opening-balance-operations/:key", action("viewSettlements"), getOpeningBalanceOperation);
  app.get("/api/pharmacy/locations/:locationId/capabilities", { preHandler: [authenticate, requirePharmacyStaff] }, getPharmacyCapabilities);
  app.get("/api/pharmacy/locations/:locationId/settings", settings, getPharmacySettings);
  app.patch("/api/pharmacy/locations/:locationId/settings", { ...settings, schema: pharmacySettingsSchema }, savePharmacySettings);
  app.get("/api/pharmacy/role-presets", { preHandler: [authenticate, requirePharmacyStaff, checkPermission("ADMINISTRATIVE_GOVERNANCE")] }, getPharmacyRolePresets);
  const configurePharmacyTax = { preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy"), checkPermission("MANAGE_ORGANIZATION")] };
  app.get("/api/pharmacy/locations/:locationId/tax-profile", configurePharmacyTax, getPharmacyTaxProfile);
  app.put("/api/pharmacy/locations/:locationId/tax-profile", { ...configurePharmacyTax, schema: pharmacyTaxProfileSchema }, savePharmacyTaxProfile);
  app.put("/api/pharmacy/medicines/:id/tax-classification", { ...configurePharmacyTax, schema: medicineTaxReviewSchema }, reviewMedicineTax);
  app.put("/api/pharmacy/locations/:locationId/professionals/:userId/:profession", { ...configurePharmacyTax, schema: pharmacyProfessionalReviewSchema }, savePharmacyProfessionalReview);
  app.get("/api/pharmacy/locations/:locationId/professionals/:userId/:profession", configurePharmacyTax, getPharmacyProfessionalReview);
  app.put("/api/pharmacy/medicines/:id/dispensing-classification", { ...configurePharmacyTax, schema: pharmacyDispensingReviewSchema }, reviewMedicineDispensing);

  app.post("/api/medicines", { ...action("manageCatalog"), preValidation: validateMedicineTypes, schema: createMedicineSchema }, createMedicine);
  app.get("/api/medicines", { ...action("viewStock"), schema: medicineListSchema }, getMedicines);
  app.put("/api/medicines/:id", { ...action("manageCatalog"), preValidation: validateMedicineTypes, schema: updateMedicineSchema }, updateMedicine);
  app.delete("/api/medicines/:id", action("manageCatalog"), deleteMedicine);
  app.post("/api/pharmacy/dispense", { ...action("dispense"), schema: dispensePrescriptionSchema }, dispensePrescription);
  app.get("/api/pharmacy/dispense-operations/:key", action("recoverDispense"), getDispenseOperationController);
  app.get("/api/pharmacy/pending-prescriptions", action("viewRxQueue"), getPendingPrescriptionsController);
  app.get("/api/pharmacy/prescriptions/pending", action("viewRxQueue"), getPendingPrescriptionsController);
  app.post("/api/pharmacy/adjust-stock", { ...action("adjustStock"), schema: stockAdjustmentSchema }, adjustStock);
  app.get("/api/pharmacy/medicines/:id/stock-movements", action("readMovements"), getStockMovements);

  // Multi-Batch & Expiration Tracking
  app.post("/api/pharmacy/batches", action("receiveStock"), createMedicineBatch);
  app.post("/api/pharmacy/stock-receipts", action("receiveStock"), postPharmacyStockReceipt);
  app.get("/api/pharmacy/stock-receipts/:key", action("readMovements"), getPharmacyStockReceipt);
  app.get("/api/pharmacy/medicines/:id/batches", action("viewStock"), getMedicineBatches);
  app.get("/api/pharmacy/expiring", action("viewStock"), getExpiringMedicinesController);
}
