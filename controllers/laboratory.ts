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
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, getRequestClinicIds, getRequestOrganizationId, isRootRequest, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

async function requireControllerPermission(
  req: FastifyRequest,
  reply: FastifyReply,
  message: string,
  ...permissions: string[]
) {
  if (await requestHasAnyPermission(req, ...permissions)) {
    return true;
  }

  reply.code(403).send(errorResponse(message));
  return false;
}

// ─── LabTest (Catalog) CRUD Handlers ─────────────────────────────

export async function createLabTest(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!(await requireControllerPermission(req, reply, "Forbidden: lab catalog management permission is required", "MANAGE_LAB_TESTS"))) {
      return;
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

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    // Check if code is unique within this clinic
    const existing = await LabTest.findOne({ clinicId, code: code.trim() });
    if (existing) {
      return reply.code(400).send(errorResponse(`A lab test with code ${code} already exists in this clinic`));
    }

    const test = await LabTest.create({
      organizationId: clinicAccess.organizationId,
      clinicId,
      name,
      code: code.trim(),
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
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      query.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) query.clinicId = { $in: clinicIds };
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
    if (!(await requireControllerPermission(req, reply, "Forbidden: lab catalog management permission is required", "MANAGE_LAB_TESTS"))) {
      return;
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

    const clinicAccess = await checkClinicAccess(req, test.clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

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
 * GET /api/lab/tat-metrics
 * Turnaround Time (TAT) Analytics for Diagnostic Orders & Panels
 */
export async function getLabTatMetrics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId } = req.query as { clinicId?: string };

    const filter: any = { status: "result-uploaded" };
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      filter.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) filter.clinicId = { $in: clinicIds };
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
    const avgTotalTatHours = totalCompleted > 0 ? Number((totalTatMinutes / totalCompleted / 60).toFixed(1)) : 0;
    const avgStatTatMinutes = statCount > 0 ? Math.round(statTatMinutes / statCount) : 0;
    const avgRoutineTatHours = routineCount > 0 ? Number((routineTatMinutes / routineCount / 60).toFixed(1)) : 0;
    const tatCompliancePercent = totalCompleted > 0 ? Math.round((metTargetCount / totalCompleted) * 100) : 0;

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
    if (!(await requireControllerPermission(req, reply, "Forbidden: lab catalog management permission is required", "MANAGE_LAB_TESTS"))) {
      return;
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid lab test ID"));
    }

    const test = await LabTest.findById(id);
    if (!test) {
      return reply.code(404).send(errorResponse("Lab test not found"));
    }

    const clinicAccess = await checkClinicAccess(req, test.clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

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
    const userId = req.user!.id;

    if (!(await requireControllerPermission(req, reply, "Forbidden: diagnostic order management permission is required", "MANAGE_ORDERS"))) {
      return;
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

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    // Verify patient
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (patient.organizationId && clinicAccess.organizationId && patient.organizationId.toString() !== clinicAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (!patient.organizationId && clinicAccess.organizationId) {
      patient.organizationId = new mongoose.Types.ObjectId(clinicAccess.organizationId);
      await patient.save();
    }

    // Verify lab test
    const test = await LabTest.findById(testId);
    if (!test) {
      return reply.code(404).send(errorResponse("Lab test not found in catalog"));
    }
    if (test.clinicId.toString() !== clinicId) {
      return reply.code(404).send(errorResponse("Lab test not found in clinic catalog"));
    }

    const labOrder = await withTransaction(async (session) => {
      let invoice: any = null;
      let createdOrder: any = null;
      try {
        const year = new Date().getFullYear();
        const count = await Invoice.countDocuments({}, session ? { session } : undefined);
        const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

        invoice = await createWithSession(Invoice, {
          invoiceNumber,
          patientId,
          clinicId,
          organizationId: clinicAccess.organizationId || undefined,
          doctorId,
          items: [{
            description: `Laboratory Diagnostic Test: ${test.name} (${test.code})`,
            amount: test.price,
            quantity: 1
          }],
          subtotal: test.price,
          tax: 0,
          discount: 0,
          totalAmount: test.price,
          status: "unpaid"
        }, session);

        createdOrder = await createWithSession(LabOrder, {
          organizationId: clinicAccess.organizationId || undefined,
          clinicId,
          patientId,
          doctorId,
          orderedBy: doctorId,
          testId,
          status: "ordered"
        }, session);

        await createWithSession(AuditLog, {
          userId,
          organizationId: clinicAccess.organizationId || undefined,
          action: "LAB_ORDER_CREATE",
          targetId: createdOrder._id,
          targetModel: "LabOrder",
          details: { testCode: test.code, testName: test.name, invoiceNumber: invoice.invoiceNumber }
        }, session);

        return createdOrder;
      } catch (error) {
        // The transaction handles rollback on replica-set deployments. Keep
        // the standalone development fallback from leaving an orphan invoice.
        if (!session) {
          if (createdOrder?._id) await LabOrder.findByIdAndDelete(createdOrder._id);
          if (invoice?._id) await Invoice.findByIdAndDelete(invoice._id);
        }
        throw error;
      }
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
      if (clinicId) {
        if (!mongoose.Types.ObjectId.isValid(clinicId)) {
          return reply.code(400).send(errorResponse("Invalid clinic ID"));
        }
        const clinicAccess = await checkClinicAccess(req, clinicId);
        if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
        query.clinicId = clinicId;
      } else {
        const clinicIds = await getRequestClinicIds(req);
        if (clinicIds) query.clinicId = { $in: clinicIds };
      }
      if (patientId) {
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
          return reply.code(400).send(errorResponse("Invalid patientId"));
        }
        const patientAccess = await checkPatientAccess(req, patientId);
        if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);
        query.patientId = patientId;
      }
    }

    if (status) query.status = status;

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const [totalCount, rawOrders] = await Promise.all([
      LabOrder.countDocuments(query),
      LabOrder.find(query)
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name phone email" }
        })
        .populate("doctorId", "name specialization")
        .populate("testId", "name code department sampleType normalRange")
        .sort({ orderDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);
    const orders = rawOrders.map((o: any) => ({ ...o, id: o._id.toString() }));

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(orders));
  } catch (err) {
    console.error("getLabOrders error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function collectSample(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;

    if (!(await requireControllerPermission(req, reply, "Forbidden: diagnostic order management permission is required", "MANAGE_ORDERS"))) {
      return;
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }

    const order = await LabOrder.findById(id).populate("testId", "name code");
    if (!order) {
      return reply.code(404).send(errorResponse("Lab order not found"));
    }
    const orderAccess = await checkOperationalRecordAccess(req, order);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);

    if (order.status !== "ordered") {
      return reply.code(400).send(errorResponse(`Cannot collect sample for order currently in ${order.status} state`));
    }

    order.status = "sample-collected";
    order.collectedBy = new mongoose.Types.ObjectId(userId);
    order.sampleCollectedAt = new Date();
    await order.save();

    // Create Audit Log
    await AuditLog.create({
      userId,
      organizationId: order.organizationId || (order.clinicId as any)?.organizationId || (req as any).user?.organizationId,
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
    const userId = req.user!.id;

    if (!(await requireControllerPermission(req, reply, "Forbidden: diagnostic order management permission is required", "MANAGE_ORDERS"))) {
      return;
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
    const orderAccess = await checkOperationalRecordAccess(req, order);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);

    if (!["ordered", "sample-collected", "processing"].includes(order.status)) {
      return reply.code(400).send(errorResponse(`Cannot upload result for order in ${order.status} state.`));
    }

    order.status = "result-uploaded";
    order.resultedBy = new mongoose.Types.ObjectId(userId);
    if (!order.sampleCollectedAt) order.sampleCollectedAt = new Date();
    if (!order.processingStartedAt) order.processingStartedAt = new Date();
    order.resultedAt = new Date();
    order.resultValue = resultValue;
    order.resultNotes = resultNotes || "";
    order.attachmentUrl = attachmentUrl || "";
    order.completedDate = new Date();

    await order.save();

    await syncLabOrderToAppointment(order, resultValue, resultNotes);

    // Create Audit Log
    await AuditLog.create({
      userId,
      organizationId: order.organizationId || (order.clinicId as any)?.organizationId || (req as any).user?.organizationId,
      action: "LAB_RESULT_UPLOAD",
      targetId: order._id,
      targetModel: "LabOrder",
      details: { testName: (order.testId as any).name, testCode: (order.testId as any).code, resultRecorded: true }
    });

    return reply.code(200).send(successResponse(order, "Lab test results successfully saved and finalized"));
  } catch (err) {
    console.error("uploadLabResult error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export function evaluatePanicCriticalValue(testName: string, val: string): { isPanic: boolean; reason: string } {
  const cleanName = (testName || "").toLowerCase();
  const cleanVal = (val || "").trim().toLowerCase();
  const num = parseFloat(cleanVal);

  if (cleanName.includes("troponin") && (cleanVal.includes("pos") || cleanVal.includes("reactive") || num > 0.04)) {
    return { isPanic: true, reason: "Troponin positive / elevated (Rule out Acute Myocardial Infarction)" };
  }
  if (cleanName.includes("ecg") && (cleanVal.includes("st elevation") || cleanVal.includes("st depression") || cleanVal.includes("infarct") || cleanVal.includes("vtach"))) {
    return { isPanic: true, reason: "ECG showing acute ischemia or malignant arrhythmia" };
  }
  if ((cleanName.includes("potassium") || cleanName.includes("serum k")) && !isNaN(num)) {
    if (num < 2.8) return { isPanic: true, reason: `Severe Hypokalemia (K+ ${num} mEq/L < 2.8) - Cardiac Arrest Risk` };
    if (num > 6.2) return { isPanic: true, reason: `Severe Hyperkalemia (K+ ${num} mEq/L > 6.2) - Fatal Arrhythmia Risk` };
  }
  if ((cleanName.includes("glucose") || cleanName.includes("sugar") || cleanName.includes("rbs") || cleanName.includes("fbs")) && !isNaN(num)) {
    if (num < 50) return { isPanic: true, reason: `Severe Hypoglycemia (${num} mg/dL < 50) - Impending Coma Risk` };
    if (num > 400) return { isPanic: true, reason: `Hyperglycemic Crisis / DKA Warning (${num} mg/dL > 400)` };
  }
  if (cleanName.includes("platelet") && !isNaN(num)) {
    if (num < 30000 || (num < 30 && num > 0)) return { isPanic: true, reason: `Critical Thrombocytopenia (${num} < 30,000 /uL) - Spontaneous Bleeding Risk` };
  }
  if ((cleanName.includes("hemoglobin") || cleanName.includes("hb ")) && !isNaN(num)) {
    if (num < 6.5) return { isPanic: true, reason: `Critical Anemia (Hb ${num} g/dL < 6.5) - Decompensation Risk` };
  }
  if (cleanVal.includes("critical") || cleanVal.includes("panic")) {
    return { isPanic: true, reason: `Panic/Critical Laboratory Value Reported: ${val}` };
  }

  return { isPanic: false, reason: "" };
}

async function syncLabOrderToAppointment(order: any, resultVal?: string, notes?: string) {
  try {
    if (!order.appointmentId) return;
    const { Appointment } = await import("../models/Appointment.ts");
    const appt = await Appointment.findById(order.appointmentId);
    if (!appt) return;

    const testDoc = order.testId as any;
    const testName = testDoc?.name || "Diagnostic Test";
    const val = resultVal || order.resultValue || order.result?.value || "Completed";
    const refRange = testDoc?.normalRange || order.result?.referenceRange || "Standard Reference";

    const panicCheck = evaluatePanicCriticalValue(testName, val);
    const isAbnormal = Boolean(
      panicCheck.isPanic ||
      order.result?.isAbnormal ||
      (notes && notes.toLowerCase().includes("abnormal")) ||
      (val && (val.toLowerCase().includes("high") || val.toLowerCase().includes("critical") || val.toLowerCase().includes("positive")))
    );

    if (panicCheck.isPanic) {
      if (!order.result) order.result = {};
      order.result.interpretation = "critical";
      order.result.isAbnormal = true;
      appt.hasPanicAlert = true;
      appt.panicAlertDetails = panicCheck.reason;
    }

    if (!Array.isArray(appt.investigationResults)) {
      (appt as any).investigationResults = [];
    }

    const existingIdx = appt.investigationResults.findIndex(
      (r: any) => r.labOrderId?.toString() === order._id.toString() || r.testName?.toLowerCase() === testName.toLowerCase()
    );

    const resultEntry = {
      testId: testDoc?._id || undefined,
      testName,
      value: val,
      unit: order.result?.unit || "",
      referenceRange: refRange,
      isAbnormal,
      resultNotes: notes || order.resultNotes || (panicCheck.isPanic ? `CRITICAL PANIC: ${panicCheck.reason}` : ""),
      attachmentUrl: order.attachmentUrl || order.result?.attachmentUrl || "",
      resultedAt: new Date(),
      labOrderId: order._id,
    };

    if (existingIdx >= 0) {
      appt.investigationResults[existingIdx] = resultEntry as any;
    } else {
      appt.investigationResults.push(resultEntry as any);
    }
    await appt.save();

    const { broadcastClinicalRealtime, broadcastRealtimeNotification, broadcastQueueUpdate } = await import("../notifications/websocket.ts");

    if (panicCheck.isPanic) {
      const panicAlert = {
        type: "CLINICAL_PANIC_ALERT" as const,
        data: {
          clinicId: order.clinicId.toString(),
          appointmentId: appt._id.toString(),
          tokenNumber: appt.tokenNumber,
          testName,
          resultValue: val,
          panicReason: panicCheck.reason,
        },
        message: `🚨 CRITICAL PANIC ALERT for Token #${appt.tokenNumber} (${testName}): ${panicCheck.reason}`,
        timestamp: new Date().toISOString(),
      };

      // 1. Broadcast panic alert to authenticated clinical staff channel
      broadcastClinicalRealtime(order.clinicId.toString(), panicAlert);

      // 2. Direct real-time alert to ordering doctor
      if (appt.doctorId) {
        broadcastRealtimeNotification(appt.doctorId.toString(), panicAlert);
      }
    }

    const labResultAlert = {
      type: "LAB_RESULTS_READY" as const,
      data: {
        clinicId: order.clinicId.toString(),
        appointmentId: appt._id.toString(),
        tokenNumber: appt.tokenNumber,
        testName,
        resultValue: val,
        isAbnormal,
        isPanic: panicCheck.isPanic,
        referenceRange: refRange,
      },
      message: `Lab results ready for Token #${appt.tokenNumber}: ${testName}`,
      timestamp: new Date().toISOString(),
    };

    // 1. Broadcast to authenticated clinical staff channel
    broadcastClinicalRealtime(order.clinicId.toString(), labResultAlert);

    // 2. Direct alert to ordering doctor
    if (appt.doctorId) {
      broadcastRealtimeNotification(appt.doctorId.toString(), labResultAlert);
    }

    // 3. Sanitized status update for public waiting-room TV (token number only, zero PHI/lab data)
    broadcastQueueUpdate(order.clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: order.clinicId.toString(),
        appointmentId: appt._id.toString(),
        tokenNumber: appt.tokenNumber,
      },
      message: `Status updated for Token #${appt.tokenNumber}`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("syncLabOrderToAppointment notice:", err);
  }
}

/**
 * Direct lab order status update endpoint. Enforces the validated lifecycle
 * transitions matching OrdersService.
 */
export async function updateLabOrderStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!(await requireControllerPermission(req, reply, "Forbidden: diagnostic order management permission is required", "MANAGE_ORDERS"))) {
      return;
    }

    const { id } = req.params as { id: string };
    const { status, cancellationReason } = (req.body as { status?: string; cancellationReason?: string }) || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return reply.code(400).send(errorResponse("Invalid lab order ID"));
    if (!["ordered", "sample-collected", "processing", "result-uploaded", "cancelled"].includes(status || "")) {
      return reply.code(400).send(errorResponse("Invalid laboratory order status"));
    }

    const order = await LabOrder.findById(id).populate("testId", "name code");
    if (!order) return reply.code(404).send(errorResponse("Lab order not found"));
    const orderAccess = await checkOperationalRecordAccess(req, order);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);

    const transitions: Record<string, string[]> = {
      ordered: ["sample-collected", "cancelled"],
      "sample-collected": ["processing", "cancelled"],
      processing: ["result-uploaded", "cancelled"],
      "result-uploaded": [],
      cancelled: [],
    };
    if (!(transitions[order.status] || []).includes(status!)) {
      return reply.code(400).send(errorResponse(`Cannot transition order from ${order.status} to ${status}`));
    }

    const userId = new mongoose.Types.ObjectId(req.user!.id);
    if (status === "sample-collected") {
      order.collectedBy = userId;
      order.sampleCollectedAt = new Date();
    } else if (status === "processing") {
      order.processingStartedAt = new Date();
    } else if (status === "result-uploaded") {
      order.resultedBy = userId;
      order.resultedAt = new Date();
      order.completedDate = order.resultedAt;
    } else if (status === "cancelled") {
      if (!cancellationReason?.trim()) return reply.code(400).send(errorResponse("cancellationReason is required"));
      order.cancellationReason = cancellationReason.trim();
    }
    order.status = status as any;
    await order.save();

    if (status === "result-uploaded") {
      await syncLabOrderToAppointment(order);
    }

    await AuditLog.create({
      userId: req.user!.id,
      organizationId: order.organizationId || (orderAccess as any).organizationId,
      action: "LAB_ORDER_STATUS_UPDATE",
      targetId: order._id,
      targetModel: "LabOrder",
      details: { status, cancellationReason: status === "cancelled" ? order.cancellationReason : undefined },
    });
    return reply.code(200).send(successResponse(order, "Laboratory order status updated"));
  } catch (err) {
    console.error("updateLabOrderStatus error:", err);
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return sendTenantError(reply, scope);
    const orgId = scope.organizationId;
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
        const encounterAccess = await checkOperationalRecordAccess(req, encounter);
        if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
        if (!clinicId) clinicId = encounter.clinicId?.toString();
        if (!patientId) patientId = encounter.patientId?.toString();
      }
    }

    if (!testId || !clinicId || !patientId) {
      return reply.code(400).send(errorResponse("testId, clinicId, and patientId are required"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed && !(patientAccess.statusCode === 404 && req.user?.role !== "patient")) {
      return sendTenantError(reply, patientAccess);
    }

    const { order, test } = await OrdersService.placeOrder({
      organizationId: (clinicAccess.organizationId || orgId || "") as string,
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
      organizationId: order.organizationId || orgId,
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
    if (!mongoose.Types.ObjectId.isValid(encounterId)) {
      return reply.code(400).send(errorResponse("Invalid encounter ID"));
    }
    const encounter = await Encounter.findById(encounterId).lean() as any;
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
    const encounterAccess = await checkOperationalRecordAccess(req, encounter);
    if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
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
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }
    const existingOrder = await LabOrder.findById(orderId).lean() as any;
    if (!existingOrder) return reply.code(404).send(errorResponse("Lab order not found"));
    const orderAccess = await checkOperationalRecordAccess(req, existingOrder);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);
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
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }
    const existingOrder = await LabOrder.findById(orderId).lean() as any;
    if (!existingOrder) return reply.code(404).send(errorResponse("Lab order not found"));
    const orderAccess = await checkOperationalRecordAccess(req, existingOrder);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);
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
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }
    const existingOrder = await LabOrder.findById(orderId).lean() as any;
    if (!existingOrder) return reply.code(404).send(errorResponse("Lab order not found"));
    const orderAccess = await checkOperationalRecordAccess(req, existingOrder);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);
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

    if (interpretation === "critical" || (abnormalSignal && abnormalSignal.interpretation === "critical")) {
      await AuditLog.create({
        userId,
        organizationId: order.organizationId || getRequestOrganizationId(req),
        action: "LAB_CRITICAL_VALUE_ALERT",
        targetId: order._id,
        targetModel: "LabOrder",
        details: { orderId, value, interpretation: "critical" }
      });
    }

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

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return reply.code(400).send(errorResponse("Invalid lab order ID"));
    }
    const existingOrder = await LabOrder.findById(orderId).lean() as any;
    if (!existingOrder) return reply.code(404).send(errorResponse("Lab order not found"));
    const orderAccess = await checkOperationalRecordAccess(req, existingOrder);
    if (!orderAccess.allowed) return sendTenantError(reply, orderAccess);

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

/**
 * In-Cabin Lab Investigation Report Viewer & 1-Click Comparison:
 * Aggregates all diagnostic test results across past encounters and lab orders for a patient.
 * Groups by test name, computes chronological trends, delta differences, and abnormal flags.
 */
export async function getPatientLabComparison(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId } = req.params as { patientId: string };
    const { testName: filterTestName } = (req.query || {}) as { testName?: string };

    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId)) {
      return reply.code(400).send(errorResponse("Invalid patientId"));
    }

    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);

    const patient = await Patient.findById(patientId).select("name dob gender phone").lean();
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    // 1. Fetch finalized Lab Orders
    const labOrders = await LabOrder.find({
      patientId,
      status: "result-uploaded",
      deletedAt: null,
    })
      .populate("testId", "name code department sampleType normalRange")
      .populate("doctorId", "name specialization")
      .sort({ resultedAt: -1, orderDate: -1 })
      .lean();

    // 2. Fetch completed Appointment investigationResults
    const { Appointment } = await import("../models/Appointment.ts");
    const appts = await Appointment.find({
      patientId,
      "investigationResults.0": { $exists: true },
    })
      .populate("doctorId", "name specialization")
      .select("appointmentTime doctorId investigationResults tokenNumber")
      .sort({ appointmentTime: -1 })
      .lean();

    interface DataPoint {
      id: string;
      source: "lab_order" | "appointment_result";
      date: string;
      value: string;
      numericValue: number | null;
      unit: string;
      referenceRange: string;
      isAbnormal: boolean;
      notes: string;
      attachmentUrl: string;
      doctorName: string;
      orderId?: string;
      appointmentId?: string;
      tokenNumber?: number;
    }

    const testMap: Record<string, { testName: string; department?: string; sampleType?: string; readings: DataPoint[] }> = {};

    const extractNumber = (str?: string | null): number | null => {
      if (!str) return null;
      const match = String(str).match(/[-+]?[0-9]*\.?[0-9]+/);
      return match ? parseFloat(match[0]) : null;
    };

    // Ingest Lab Orders
    for (const order of labOrders) {
      const t = order.testId as any;
      const name = t?.name || "Diagnostic Investigation";
      if (filterTestName && !name.toLowerCase().includes(filterTestName.toLowerCase())) continue;

      if (!testMap[name]) {
        testMap[name] = {
          testName: name,
          department: t?.department || "Laboratory",
          sampleType: t?.sampleType || "Blood",
          readings: [],
        };
      }

      const val = order.resultValue || order.result?.value || "";
      const dateStr = (order.resultedAt || order.completedDate || order.orderDate || (order as any).createdAt).toISOString();
      const numVal = extractNumber(val);

      testMap[name].readings.push({
        id: order._id.toString(),
        source: "lab_order",
        date: dateStr,
        value: val,
        numericValue: numVal,
        unit: order.result?.unit || "",
        referenceRange: order.result?.referenceRange || t?.normalRange || "",
        isAbnormal: Boolean(order.result?.isAbnormal || (val && (val.toLowerCase().includes("high") || val.toLowerCase().includes("critical") || val.toLowerCase().includes("positive")))),
        notes: order.resultNotes || order.result?.notes || "",
        attachmentUrl: order.attachmentUrl || order.result?.attachmentUrl || "",
        doctorName: (order.doctorId as any)?.name || "Ordering Physician",
        orderId: order._id.toString(),
        appointmentId: order.appointmentId?.toString(),
      });
    }

    // Ingest Appointment Investigation Results
    for (const appt of appts) {
      if (!Array.isArray(appt.investigationResults)) continue;
      for (const res of appt.investigationResults) {
        const name = res.testName || "Diagnostic Investigation";
        if (filterTestName && !name.toLowerCase().includes(filterTestName.toLowerCase())) continue;

        if (!testMap[name]) {
          testMap[name] = {
            testName: name,
            readings: [],
          };
        }

        // Skip if this labOrderId was already ingested from labOrders
        if (res.labOrderId && testMap[name].readings.some((r) => r.orderId === res.labOrderId?.toString())) {
          continue;
        }

        const dateStr = (res.resultedAt || appt.appointmentTime || new Date()).toISOString();
        const numVal = extractNumber(res.value);

        testMap[name].readings.push({
          id: (res as any)._id ? (res as any)._id.toString() : `${appt._id}_${name}`,
          source: "appointment_result",
          date: dateStr,
          value: res.value || "",
          numericValue: numVal,
          unit: res.unit || "",
          referenceRange: res.referenceRange || "",
          isAbnormal: Boolean(res.isAbnormal),
          notes: res.resultNotes || "",
          attachmentUrl: (res as any).attachmentUrl || "",
          doctorName: (appt.doctorId as any)?.name || "Physician",
          appointmentId: appt._id.toString(),
          tokenNumber: appt.tokenNumber,
        });
      }
    }

    // Calculate delta and trends for each test group
    const comparisonResults: Record<string, any> = {};

    for (const [key, group] of Object.entries(testMap)) {
      group.readings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      if (group.readings.length === 0) continue;

      const latest = group.readings[0];
      const previous = group.readings.length > 1 ? group.readings[1] : null;

      let delta: number | null = null;
      let percentChange: number | null = null;
      let trend: "improved" | "worsened" | "stable" | "changed" = "stable";

      if (previous && latest.numericValue !== null && previous.numericValue !== null && previous.numericValue !== undefined) {
        delta = Number((latest.numericValue - previous.numericValue).toFixed(2));
        if (previous.numericValue !== 0) {
          percentChange = Number(((delta / previous.numericValue) * 100).toFixed(1));
        }

        if (previous.isAbnormal && !latest.isAbnormal) {
          trend = "improved";
        } else if (!previous.isAbnormal && latest.isAbnormal) {
          trend = "worsened";
        } else if (delta === 0) {
          trend = "stable";
        } else {
          trend = "changed";
        }
      } else if (previous) {
        if (previous.isAbnormal && !latest.isAbnormal) trend = "improved";
        else if (!previous.isAbnormal && latest.isAbnormal) trend = "worsened";
      }

      comparisonResults[key] = {
        testName: group.testName,
        department: group.department,
        sampleType: group.sampleType,
        totalReadings: group.readings.length,
        latest,
        previous,
        delta,
        percentChange,
        trend,
        history: group.readings,
      };
    }

    return reply.code(200).send(
      successResponse({
        patientId: patient._id.toString(),
        patientName: patient.name || "Patient",
        gender: patient.gender,
        totalTestsTracked: Object.keys(comparisonResults).length,
        tests: comparisonResults,
      })
    );
  } catch (err) {
    console.error("getPatientLabComparison error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
