import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, checkPermission, denyRoles } from "../middleware/auth.ts";
import {
  collectLabSampleSchema,
  createLabTestSchema,
  createLabOrderSchema,
  labOrdersQuerySchema,
  labTatMetricsSchema,
  labTestsQuerySchema,
  objectIdParamSchema,
  patientLabComparisonSchema,
  updateLabOrderStatusSchema,
  uploadLabResultSchema,
} from "../schemas/clinical.ts";
import {
  createLabTest,
  getLabTests,
  updateLabTest,
  deleteLabTest,
  createLabOrder,
  getLabOrders,
  collectSample,
  updateLabOrderStatus,
  uploadLabResult,
  placeOrderController,
  getEncounterOrdersController,
  collectSampleOrderController,
  markProcessingController,
  recordResultController,
  cancelOrderController,
  getLabTatMetrics,
  getPatientLabComparison,
} from "../controllers/laboratory.ts";

export default async function laboratoryRoutes(app: FastifyInstance) {
  const staffOnly = denyRoles("patient", "family_member", "guest");
  const viewLabCatalog = { preHandler: [authenticate, checkAnyPermission("VIEW_EHR", "MANAGE_ORDERS", "MANAGE_LAB_TESTS")] };
  const manageLabCatalog = { preHandler: [authenticate, staffOnly, checkPermission("MANAGE_LAB_TESTS")] };
  const viewOrders = { preHandler: [authenticate, checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_EHR", "MANAGE_ORDERS")] };
  const viewLabAnalytics = { preHandler: [authenticate, staffOnly, checkAnyPermission("VIEW_ANALYTICS", "MANAGE_ORDERS", "MANAGE_LAB_TESTS")] };
  const manageOrders = { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] };
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };

  // In-Cabin Diagnostic Historical Comparison & Reports
  app.get("/api/lab/patient/:patientId/comparison", { ...viewOrders, schema: patientLabComparisonSchema }, getPatientLabComparison);

  // Turnaround Time (TAT) Analytics
  app.get("/api/lab/tat-metrics", { ...viewLabAnalytics, schema: labTatMetricsSchema }, getLabTatMetrics);

  // Lab Test Catalog CRUD
  app.post("/api/lab-tests", { ...manageLabCatalog, schema: createLabTestSchema }, createLabTest);
  app.get("/api/lab-tests", { ...viewLabCatalog, schema: labTestsQuerySchema }, getLabTests);
  app.put("/api/lab-tests/:id", { ...manageLabCatalog, schema: objectIdParamSchema }, updateLabTest);
  app.delete("/api/lab-tests/:id", { ...manageLabCatalog, schema: objectIdParamSchema }, deleteLabTest);

  // Canonical direct lab-order API
  app.post("/api/lab-orders", { ...manageOrders, schema: createLabOrderSchema }, createLabOrder);
  app.get("/api/lab-orders", { ...viewOrders, schema: labOrdersQuerySchema }, getLabOrders);
  app.put("/api/lab-orders/:id/sample", { ...manageOrders, schema: collectLabSampleSchema }, collectSample);
  app.put("/api/lab-orders/:id/status", { ...manageOrders, schema: updateLabOrderStatusSchema }, updateLabOrderStatus);
  app.put("/api/lab-orders/:id/result", { ...manageOrders, schema: uploadLabResultSchema }, uploadLabResult);

  // Encounter Diagnostic Orders Lifecycle API
  app.post("/api/encounters/:id/orders", manageOrders, placeOrderController);
  app.get("/api/encounters/:id/orders", viewEhr, getEncounterOrdersController);
  app.put("/api/orders/:id/collect", manageOrders, collectSampleOrderController);
  app.put("/api/orders/:id/process", manageOrders, markProcessingController);
  app.put("/api/orders/:id/result", manageOrders, recordResultController);
  app.put("/api/orders/:id/cancel", manageOrders, cancelOrderController);
}
