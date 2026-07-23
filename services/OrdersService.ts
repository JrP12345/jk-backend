import mongoose from "mongoose";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { Encounter } from "../models/Encounter.ts";
import { WorkflowEngine } from "../platform/workflow/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../platform/workflow/types.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { EventTypes, type OrderPlacedPayload, type ResultUploadedPayload } from "../platform/events/types.ts";

/**
 * Declarative workflow definition for Diagnostic Orders lifecycle.
 */
export const ordersWorkflowDefinition: WorkflowDefinition<string> = {
  name: "DiagnosticOrdersWorkflow",
  initial: "ordered",
  terminal: ["result-uploaded", "cancelled"],
  transitions: {
    ordered:           ["sample-collected", "processing", "result-uploaded", "cancelled"],
    "sample-collected":["processing", "result-uploaded", "cancelled"],
    processing:        ["result-uploaded", "cancelled"],
    "result-uploaded": [],
    cancelled:         [],
  },
};

export const ordersWorkflowEngine = new WorkflowEngine(ordersWorkflowDefinition);

export interface PlaceOrderPayload {
  organizationId: string;
  clinicId: string;
  encounterId?: string;
  patientId: string;
  testId: string;
  orderedBy: string;
  priority?: "routine" | "urgent" | "stat";
  clinicalReason?: string;
}

export interface RecordResultPayload {
  resultedBy: string;
  value: string;
  unit?: string;
  referenceRange?: string;
  interpretation?: "normal" | "low" | "high" | "critical" | "indeterminate";
  isAbnormal?: boolean;
  notes?: string;
  attachmentUrl?: string;
}

export interface AbnormalResultSignal {
  orderId: string;
  testName: string;
  testCode: string;
  value: string;
  unit: string;
  referenceRange: string;
  interpretation: string;
  patientId: string;
  encounterId?: string;
}

export class OrdersService {
  /**
   * Place a new diagnostic order anchored to an Encounter.
   */
  static async placeOrder(payload: PlaceOrderPayload) {
    let test: any = null;
    if (mongoose.Types.ObjectId.isValid(payload.testId)) {
      test = await LabTest.findById(payload.testId).lean();
    }
    if (!test) {
      test = await LabTest.findOne({
        $or: [
          { code: new RegExp(`^${payload.testId}$`, "i") },
          { name: new RegExp(payload.testId, "i") },
        ],
      }).lean();
    }
    if (!test) {
      test = await LabTest.create({
        organizationId: payload.organizationId,
        clinicId: payload.clinicId,
        name: payload.testId,
        code: payload.testId.toUpperCase().replace(/\s+/g, "_"),
        department: "Laboratory",
        sampleType: "Blood",
        normalRange: "Normal",
        price: 50,
      });
    }

    const testId = test._id.toString();

    if (payload.encounterId) {
      const encounter = await Encounter.findById(payload.encounterId).lean();
      if (!encounter) throw new Error("Encounter not found");
    }

    const order = await LabOrder.create({
      organizationId:  payload.organizationId,
      clinicId:        payload.clinicId,
      encounterId:     payload.encounterId || null,
      patientId:       payload.patientId,
      testId:          testId,
      orderedBy:       payload.orderedBy,
      doctorId:        payload.orderedBy, // legacy field sync
      priority:        payload.priority || "routine",
      clinicalReason:  payload.clinicalReason || "",
      status:          "ordered",
    });

    // Publish OrderPlaced domain event
    const eventPayload: OrderPlacedPayload = {
      orderId:     order._id.toString(),
      encounterId: payload.encounterId,
      patientId:   payload.patientId,
      testId:      payload.testId,
      priority:    order.priority,
      orderedBy:   payload.orderedBy,
    };
    await domainEventBus.publishEvent(EventTypes.ORDER_PLACED, eventPayload);

    return { order, test };
  }

  /**
   * Record sample collection. Transitions: ordered → sample-collected.
   */
  static async collectSample(orderId: string, collectedBy: string) {
    const order = await LabOrder.findById(orderId);
    if (!order) throw new Error("Lab order not found");

    ordersWorkflowEngine.validateTransition(order.status, "sample-collected");

    order.status = "sample-collected";
    order.collectedBy = collectedBy as any;
    order.sampleCollectedAt = new Date();
    await order.save();
    return order;
  }

  /**
   * Mark order as processing. Transitions: sample-collected → processing.
   */
  static async markProcessing(orderId: string) {
    const order = await LabOrder.findById(orderId);
    if (!order) throw new Error("Lab order not found");

    ordersWorkflowEngine.validateTransition(order.status, "processing");

    order.status = "processing";
    order.processingStartedAt = new Date();
    await order.save();
    return order;
  }

  /**
   * Record a diagnostic result. Transitions: processing → result-uploaded.
   * Returns an AbnormalResultSignal when isAbnormal = true (CDS integration hook).
   * Publishes ResultUploaded domain event onto domainEventBus.
   */
  static async recordResult(
    orderId: string,
    payload: RecordResultPayload
  ): Promise<{ order: any; abnormalSignal: AbnormalResultSignal | null }> {
    if (!payload.value || payload.value.trim().length === 0) {
      throw new Error("Result value is required");
    }

    const order = await LabOrder.findById(orderId).populate("testId", "name code normalRange") as any;
    if (!order) throw new Error("Lab order not found");

    ordersWorkflowEngine.validateTransition(order.status, "result-uploaded");

    const isAbnormal =
      payload.isAbnormal !== undefined
        ? payload.isAbnormal
        : ["low", "high", "critical"].includes(payload.interpretation || "");

    order.status = "result-uploaded";
    order.resultedBy = payload.resultedBy as any;
    order.resultedAt = new Date();
    order.completedDate = new Date(); // legacy alias
    if (!order.sampleCollectedAt) order.sampleCollectedAt = new Date();
    if (!order.processingStartedAt) order.processingStartedAt = new Date();

    order.result = {
      value:          payload.value,
      unit:           payload.unit || "",
      referenceRange: payload.referenceRange || order.testId?.normalRange || "",
      interpretation: payload.interpretation || "",
      isAbnormal,
      notes:          payload.notes || "",
      attachmentUrl:  payload.attachmentUrl || "",
    };

    order.resultValue = payload.value;
    order.resultNotes = payload.notes || "";
    if (payload.attachmentUrl) order.attachmentUrl = payload.attachmentUrl;

    await order.save();

    let abnormalSignal: AbnormalResultSignal | null = null;
    if (isAbnormal) {
      abnormalSignal = {
        orderId:        order._id.toString(),
        testName:       order.testId?.name || "Unknown Test",
        testCode:       order.testId?.code || "",
        value:          payload.value,
        unit:           payload.unit || "",
        referenceRange: payload.referenceRange || order.testId?.normalRange || "",
        interpretation: payload.interpretation || "",
        patientId:      order.patientId?.toString(),
        encounterId:    order.encounterId?.toString(),
      };
    }

    // Publish ResultUploaded domain event
    const eventPayload: ResultUploadedPayload = {
      orderId:        order._id.toString(),
      encounterId:    order.encounterId?.toString(),
      patientId:      order.patientId?.toString(),
      testCode:       order.testId?.code || "",
      testName:       order.testId?.name || "Lab Test",
      value:          payload.value,
      unit:           payload.unit || "",
      referenceRange: payload.referenceRange || "",
      interpretation: payload.interpretation || "",
      isAbnormal,
      resultedBy:     payload.resultedBy,
    };
    await domainEventBus.publishEvent(EventTypes.RESULT_UPLOADED, eventPayload);

    return { order, abnormalSignal };
  }

  /**
   * Cancel an order. Transitions: any non-terminal state → cancelled.
   * cancellationReason is mandatory.
   */
  static async cancelOrder(orderId: string, reason: string) {
    if (!reason || reason.trim().length === 0) {
      throw new Error("cancellationReason is required when cancelling an order");
    }

    const order = await LabOrder.findById(orderId);
    if (!order) throw new Error("Lab order not found");

    ordersWorkflowEngine.validateTransition(order.status, "cancelled");

    order.status = "cancelled";
    order.cancellationReason = reason;
    await order.save();
    return order;
  }

  /**
   * Retrieve all orders for an encounter, sorted chronologically.
   */
  static async getOrdersByEncounter(encounterId: string) {
    return LabOrder.find({ encounterId })
      .populate("testId", "name code department sampleType normalRange price")
      .populate("orderedBy", "name email")
      .populate("collectedBy", "name email")
      .populate("resultedBy", "name email")
      .sort({ orderDate: 1 })
      .lean();
  }

  /**
   * Retrieve all orders for a patient across all encounters.
   */
  static async getOrdersByPatient(patientId: string) {
    return LabOrder.find({ patientId })
      .populate("testId", "name code department normalRange")
      .populate("orderedBy", "name email")
      .populate("encounterId", "encounterType status startedAt")
      .sort({ orderDate: -1 })
      .lean();
  }
}
