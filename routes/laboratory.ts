import type { FastifyInstance } from "fastify";
import { authenticate, authorize, checkPermission } from "../middleware/auth.ts";
import {
  createLabTestSchema,
  createLabOrderSchema,
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
} from "../controllers/laboratory.ts";

export default async function laboratoryRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const adminOnly = { preHandler: [authenticate, authorize("admin")] };
  const manageOrders = { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] };
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };

  // Turnaround Time (TAT) Analytics
  app.get("/api/lab/tat-metrics", auth, getLabTatMetrics);

  // Lab Test Catalog CRUD
  app.post("/api/lab-tests", { ...adminOnly, schema: createLabTestSchema }, createLabTest);
  app.get("/api/lab-tests", auth, getLabTests);
  app.put("/api/lab-tests/:id", adminOnly, updateLabTest);
  app.delete("/api/lab-tests/:id", adminOnly, deleteLabTest);

  // Canonical direct lab-order API
  app.post("/api/lab-orders", { ...auth, schema: createLabOrderSchema }, createLabOrder);
  app.get("/api/lab-orders", auth, getLabOrders);
  app.put("/api/lab-orders/:id/sample", auth, collectSample);
  app.put("/api/lab-orders/:id/status", auth, updateLabOrderStatus);
  app.put("/api/lab-orders/:id/result", { ...auth, schema: uploadLabResultSchema }, uploadLabResult);

  // Encounter Diagnostic Orders Lifecycle API
  app.post("/api/encounters/:id/orders", manageOrders, placeOrderController);
  app.get("/api/encounters/:id/orders", viewEhr, getEncounterOrdersController);
  app.put("/api/orders/:id/collect", manageOrders, collectSampleOrderController);
  app.put("/api/orders/:id/process", manageOrders, markProcessingController);
  app.put("/api/orders/:id/result", manageOrders, recordResultController);
  app.put("/api/orders/:id/cancel", manageOrders, cancelOrderController);
}
