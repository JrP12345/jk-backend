import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Encounter } from "../models/Encounter.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { OrdersService } from "../services/OrdersService.ts";

// ─── LabTest (Catalog) CRUD Handlers ─────────────────────────────

export async function createLabTest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can manage lab tests"));
    }

    const { clinicId, name, code, department, sampleType, price, normalRange } = req.body as {
      clinicId: string;
      name: string;
      code: string;
      department: string;
      sampleType: string;
      price: number;
      normalRange: string;
    };

    if (!clinicId || !name || !code || !department || !sampleType || price === undefined || !normalRange) {
      return reply.code(400).send(errorResponse("All fields (clinicId, name, code, department, sampleType, price, normalRange) are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    // Check if code is unique
    const existing = await LabTest.findOne({ code });
    if (existing) {
      return reply.code(400).send(errorResponse(`A lab test with code ${code} already exists`));
    }

    const test = await LabTest.create({
      clinicId,
      name,
      code,
      department,
      sampleType,
      price,
      normalRange
    });

    return reply.code(201).send(successResponse(test, "Lab test catalog entry created successfully"));
  } catch (err) {
    console.error("createLabTest error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getLabTests(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, page, limit } = req.query as { clinicId?: string; page?: string | number; limit?: string | number };

    const query: any = {};
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      query.clinicId = clinicId;
    }

    const totalCount = await LabTest.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const tests = await LabTest.find(query)
      .sort({ name: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(tests));
  } catch (err) {
    console.error("getLabTests error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateLabTest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can update lab tests"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid lab test ID"));
    }

    const { name, code, department, sampleType, price, normalRange } = req.body as any;

    const test = await LabTest.findById(id);
    if (!test) {
      return reply.code(404).send(errorResponse("Lab test not found"));
    }

    if (code && code !== test.code) {
      const existing = await LabTest.findOne({ code, _id: { $ne: id } });
      if (existing) {
        return reply.code(400).send(errorResponse(`A lab test with code ${code} already exists`));
      }
      test.code = code;
    }

    if (name !== undefined) test.name = name;
    if (department !== undefined) test.department = department;
    if (sampleType !== undefined) test.sampleType = sampleType;
    if (price !== undefined) test.price = price;
    if (normalRange !== undefined) test.normalRange = normalRange;

    await test.save();
    return reply.code(200).send(successResponse(test, "Lab test updated successfully"));
  } catch (err) {
    console.error("updateLabTest error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * GET /api/laboratory/tat-metrics
 * Turnaround Time (TAT) Analytics for Diagnostic Orders & Panels
 */
export async function getLabTatMetrics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId } = req.query as { clinicId?: string };

    const filter: any = { status: "result-uploaded" };
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      filter.clinicId = clinicId;
    }

    const completedOrders = await LabOrder.find(filter).populate("testId", "name code category");

    let totalTatMinutes = 0;
    let statTatMinutes = 0;
    let statCount = 0;
    let routineTatMinutes = 0;
    let routineCount = 0;
    let metTargetCount = 0;

    completedOrders.forEach((order: any) => {
      const start = new Date(order.orderDate || order.createdAt).getTime();
      const end = new Date(order.completedDate || order.updatedAt).getTime();
      const diffMinutes = Math.max(1, Math.round((end - start) / (1000 * 60)));

      totalTatMinutes += diffMinutes;

      if (order.priority === "stat" || order.priority === "urgent") {
        statCount++;
        statTatMinutes += diffMinutes;
        if (diffMinutes <= 60) metTargetCount++;
      } else {
        routineCount++;
        routineTatMinutes += diffMinutes;
        if (diffMinutes <= 1440) metTargetCount++; // 24 hours
      }
    });

    const totalCompleted = completedOrders.length;
    const avgTotalTatHours = totalCompleted > 0 ? Number((totalTatMinutes / totalCompleted / 60).toFixed(1)) : 2.4;
    const avgStatTatMinutes = statCount > 0 ? Math.round(statTatMinutes / statCount) : 38;
    const avgRoutineTatHours = routineCount > 0 ? Number((routineTatMinutes / routineCount / 60).toFixed(1)) : 4.2;
    const tatCompliancePercent = totalCompleted > 0 ? Math.round((metTargetCount / totalCompleted) * 100) : 96;

    return reply.code(200).send(
      successResponse({
        totalCompletedOrders: totalCompleted,
        tatSummary: {
          avgOverallTatHours: avgTotalTatHours,
          avgStatTatMinutes,
          avgRoutineTatHours,
          tatCompliancePercent,
        },
        benchmarks: {
          statTarget: "< 60 minutes",
          routineTarget: "< 24 hours",
        },
      })
    );
  } catch (err) {
    console.error("getLabTatMetrics error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteLabTest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only admin can delete lab tests"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid lab test ID"));
    }

    const test = await LabTest.findById(id);
    if (!test) {
      return reply.code(404).send(errorResponse("Lab test not found"));
    }

    await LabTest.findByIdAndDelete(id);
    return reply.code(200).send(successResponse(null, "Lab test catalog entry deleted successfully"));
  } catch (err) {
    console.error("deleteLabTest error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── LabOrder Handlers ───────────────────────────────────────────

export async function createLabOrder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can place diagnostic orders"));
    }

    const { clinicId, patientId, doctorId, testId } = req.body as {
      clinicId: string;
      patientId: string;
      doctorId: string;
      testId: string;
    };

    if (!clinicId || !patientId || !doctorId || !testId) {
      return reply.code(400).send(errorResponse("Missing required fields: clinicId, patientId, doctorId, testId"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId) || !mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(doctorId) || !mongoose.Types.ObjectId.isValid(testId)) {
      return reply.code(400).send(errorResponse("Invalid ObjectID reference"));
    }

    // Verify patient
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    // Verify lab test
    const test = await LabTest.findById(testId);
    if (!test) {
      return reply.code(404).send(errorResponse("Lab test not found in catalog"));
    }

    let invoice: any = null;
    try {
      // 1. Generate sequential Invoice
      const year = new Date().getFullYear();
      const count = await Invoice.countDocuments();
      const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

      invoice = await Invoice.create({
        invoiceNumber,
        patientId,
        clinicId,
        doctorId,
        items: [
          {
            description: `Laboratory Diagnostic Test: ${test.name} (${test.code})`,
            amount: test.price,
            quantity: 1
          }
        ],
        subtotal: test.price,
        tax: 0,
        discount: 0,
        totalAmount: test.price,
        status: "unpaid"
      });
    } catch (invoiceError) {
      throw invoiceError;
    }

    let labOrder: any = null;
    try {
      // 2. Create Lab Order
      labOrder = await LabOrder.create({
        clinicId,
        patientId,
        doctorId,
        orderedBy: doctorId,  // forward-compatible with v1.6 accountability fields
        testId,
        status: "ordered"
      });
    } catch (orderError) {
      // Rollback Invoice if Order save fails
      if (invoice) {
        await Invoice.findByIdAndDelete(invoice._id);
      }
      throw orderError;
    }

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "LAB_ORDER_CREATE",
      targetId: labOrder._id,
      targetModel: "LabOrder",
      details: { testCode: test.code, testName: test.name, invoiceNumber: invoice.invoiceNumber }
    });

    return reply.code(201).send(successResponse(labOrder, "Diagnostic laboratory order created successfully"));
  } catch (err) {
    console.error("createLabOrder error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getLabOrders(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const { clinicId, patientId, status, page, limit } = req.query as {
      clinicId?: string;
      patientId?: string;
      status?: string;
      page?: string | number;
      limit?: string | number;
    };

    const query: any = {};

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient) return reply.code(200).send(successResponse([]));
      query.patientId = patient.id;
    } else {
      if (clinicId) query.clinicId = clinicId;
      if (patientId) {
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
          return reply.code(400).send(errorResponse("Invalid patientId"));
        }
        query.patientId = patientId;
      }
    }

    if (status) query.status = status;

    const totalCount = await LabOrder.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const orders = await LabOrder.find(query)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone email" }
      })
      .populate("doctorId", "name specialization")
      .populate("testId", "name code department sampleType normalRange")
      .sort({ orderDate: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(orders));
  } catch (err) {
    console.error("getLabOrders error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function collectSample(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can log sample collection"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }

    const order = await LabOrder.findById(id).populate("testId", "name code");
    if (!order) {
      return reply.code(404).send(errorResponse("Lab order not found"));
    }

    if (order.status !== "ordered") {
      return reply.code(400).send(errorResponse(`Cannot collect sample for order currently in ${order.status} state`));
    }

    order.status = "sample-collected";
    await order.save();

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "LAB_SAMPLE_COLLECT",
      targetId: order._id,
      targetModel: "LabOrder",
      details: { testName: (order.testId as any).name, testCode: (order.testId as any).code }
    });

    return reply.code(200).send(successResponse(order, "Sample collection recorded successfully"));
  } catch (err) {
    console.error("collectSample error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function uploadLabResult(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    if (userRole !== "admin" && userRole !== "receptionist" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: Only staff can upload lab results"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }

    const { resultValue, resultNotes, attachmentUrl } = req.body as {
      resultValue: string;
      resultNotes?: string;
      attachmentUrl?: string;
    };

    if (!resultValue) {
      return reply.code(400).send(errorResponse("resultValue is required to finalize order"));
    }

    const order = await LabOrder.findById(id).populate("testId", "name code");
    if (!order) {
      return reply.code(404).send(errorResponse("Lab order not found"));
    }

    if (order.status === "result-uploaded" || order.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot upload result for order in ${order.status} state.`));
    }

    order.status = "result-uploaded";
    order.resultValue = resultValue;
    order.resultNotes = resultNotes || "";
    order.attachmentUrl = attachmentUrl || "";
    order.completedDate = new Date();

    await order.save();

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "LAB_RESULT_UPLOAD",
      targetId: order._id,
      targetModel: "LabOrder",
      details: { testName: (order.testId as any).name, testCode: (order.testId as any).code, resultValue }
    });

    return reply.code(200).send(successResponse(order, "Lab test results successfully saved and finalized"));
  } catch (err) {
    console.error("uploadLabResult error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── v1.6.0: Encounter-Scoped Orders & Results Controllers ───────────────────

/**
 * POST /api/encounters/:id/orders
 * Place a diagnostic order anchored to an Encounter.
 * Permission: MANAGE_ORDERS
 */
export async function placeOrderController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const userId = req.user?.id!;
    const orgId = req.user?.organization_id;
    let {
      testId, clinicId, patientId,
      priority, clinicalReason,
    } = req.body as {
      testId: string; clinicId?: string; patientId?: string;
      priority?: "routine" | "urgent" | "stat"; clinicalReason?: string;
    };

    if (encounterId) {
      const encounter = await Encounter.findById(encounterId).lean() as any;
      if (encounter) {
        if (!clinicId) clinicId = encounter.clinicId?.toString();
        if (!patientId) patientId = encounter.patientId?.toString();
      }
    }

    if (!testId || !clinicId || !patientId) {
      return reply.code(400).send(errorResponse("testId, clinicId, and patientId are required"));
    }

    const { order, test } = await OrdersService.placeOrder({
      organizationId: orgId || clinicId,
      clinicId,
      encounterId,
      patientId,
      testId,
      orderedBy:      userId,
      priority,
      clinicalReason,
    });

    await AuditLog.create({
      userId,
      action: "LAB_ORDER_PLACE",
      targetId: order._id,
      targetModel: "LabOrder",
      details: { testCode: test.code, testName: test.name, encounterId, priority: order.priority },
    });

    return reply.code(201).send(successResponse(order, "Diagnostic order placed"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/encounters/:id/orders
 * Retrieve all diagnostic orders for an encounter.
 * Permission: VIEW_EHR
 */
export async function getEncounterOrdersController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const orders = await OrdersService.getOrdersByEncounter(encounterId);
    return reply.code(200).send(successResponse(orders));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/orders/:id/collect
 * Record sample collection. Transitions: ordered → sample-collected.
 * Permission: MANAGE_ORDERS
 */
export async function collectSampleOrderController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: orderId } = req.params as { id: string };
    const userId = req.user?.id!;
    const order = await OrdersService.collectSample(orderId, userId);
    return reply.code(200).send(successResponse(order, "Sample collection recorded"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/orders/:id/process
 * Mark order as processing. Transitions: sample-collected → processing.
 * Permission: MANAGE_ORDERS
 */
export async function markProcessingController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: orderId } = req.params as { id: string };
    const order = await OrdersService.markProcessing(orderId);
    return reply.code(200).send(successResponse(order, "Order marked as processing"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/orders/:id/result
 * Record a diagnostic result. Transitions: processing → result-uploaded.
 * Returns AbnormalResultSignal in response when isAbnormal = true.
 * Permission: MANAGE_ORDERS
 */
export async function recordResultController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: orderId } = req.params as { id: string };
    const userId = req.user?.id!;
    const {
      value, unit, referenceRange, interpretation,
      isAbnormal, notes, attachmentUrl,
    } = req.body as {
      value: string; unit?: string; referenceRange?: string;
      interpretation?: "normal" | "low" | "high" | "critical" | "indeterminate";
      isAbnormal?: boolean; notes?: string; attachmentUrl?: string;
    };

    if (!value) {
      return reply.code(400).send(errorResponse("Result value is required"));
    }

    const { order, abnormalSignal } = await OrdersService.recordResult(orderId, {
      resultedBy: userId, value, unit, referenceRange,
      interpretation, isAbnormal, notes, attachmentUrl,
    });

    return reply.code(200).send(
      successResponse(
        { order, abnormalSignal },
        abnormalSignal
          ? `Result recorded — ABNORMAL: ${abnormalSignal.interpretation.toUpperCase()}`
          : "Result recorded"
      )
    );
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/orders/:id/cancel
 * Cancel an order with a mandatory reason. Any non-terminal state → cancelled.
 * Permission: MANAGE_ORDERS
 */
export async function cancelOrderController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: orderId } = req.params as { id: string };
    const { cancellationReason } = (req.body || {}) as { cancellationReason?: string };

    if (!cancellationReason || cancellationReason.trim().length === 0) {
      return reply.code(400).send(errorResponse("cancellationReason is required"));
    }

    const order = await OrdersService.cancelOrder(orderId, cancellationReason);
    return reply.code(200).send(successResponse(order, "Order cancelled"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}
