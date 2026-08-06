import mongoose from "mongoose";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";
import { Prescription } from "../models/Prescription.ts";
import { WorkflowEngine } from "../platform/workflow/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../platform/workflow/types.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { EventTypes, type MedicationAdministeredPayload } from "../platform/events/types.ts";

/**
 * Declarative workflow definition for Medication Administration lifecycle.
 */
export const marWorkflowDefinition: WorkflowDefinition<string> = {
  name: "MedicationAdministrationWorkflow",
  initial: "scheduled",
  terminal: ["administered", "refused", "held", "missed"],
  transitions: {
    scheduled: ["administered", "refused", "held", "missed"],
    administered: [],
    refused: [],
    held: [],
    missed: [],
  },
};

export const marWorkflowEngine = new WorkflowEngine(marWorkflowDefinition);

export interface ScheduleAdministrationPayload {
  organizationId: string;
  clinicId: string;
  encounterId: string;
  prescriptionId: string;
  patientId: string;
  route: "oral" | "iv" | "im" | "topical" | "inhaled" | "sublingual" | "rectal" | "other";
  scheduledTime: Date;
  recordedBy: string;  // User ID of the nurse/doctor creating the schedule entry
  notes?: string;
  observationId?: string;
}

export interface RecordAdministrationPayload {
  administeredBy: string;
  recordedBy: string;
  doseGiven?: string;
  administeredTime?: Date;
  notes?: string;
  observationId?: string;
}

export interface RecordRefusalPayload {
  recordedBy: string;
  refusalReason: string;
  notes?: string;
}

export interface HoldAdministrationPayload {
  recordedBy: string;
  holdReason: string;
  notes?: string;
}

export class MARService {
  /**
   * Helper to emit a serialized MedicationAdministered domain event to domainEventBus.
   */
  private static async emitEvent(doc: any): Promise<void> {
    const payload: MedicationAdministeredPayload = {
      administrationId: doc._id.toString(),
      prescriptionId:   doc.prescriptionId?.toString(),
      encounterId:      doc.encounterId?.toString(),
      patientId:        doc.patientId?.toString(),
      medicineName:     doc.medicineName,
      prescribedDose:   doc.prescribedDose,
      doseGiven:        doc.doseGiven || doc.prescribedDose,
      route:            doc.route,
      status:           doc.status,
      administeredBy:   doc.administeredBy?.toString(),
      recordedBy:       doc.recordedBy?.toString(),
    };
    await domainEventBus.publishEvent(EventTypes.MEDICATION_ADMINISTERED, payload);
  }

  /**
   * Schedule a new dose administration entry from a prescription.
   * Creates a 'scheduled' MAR document.
   */
  static async scheduleAdministration(payload: ScheduleAdministrationPayload) {
    let prescription: any = null;
    if (mongoose.Types.ObjectId.isValid(payload.prescriptionId)) {
      prescription = await Prescription.findById(payload.prescriptionId).lean();
    }
    if (!prescription) {
      throw new Error("Prescription not found");
    }
    if (prescription.encounterId?.toString() !== payload.encounterId || prescription.patientId?.toString() !== payload.patientId || prescription.clinicId?.toString() !== payload.clinicId) {
      throw new Error("Prescription does not belong to the selected encounter");
    }
    if (prescription.organizationId?.toString() !== payload.organizationId) {
      throw new Error("Prescription does not belong to the active organization");
    }

    const prescriptionId = prescription._id.toString();

    const doc = await MedicationAdministration.create({
      organizationId:  payload.organizationId,
      clinicId:        payload.clinicId,
      encounterId:     payload.encounterId,
      prescriptionId:  prescriptionId,
      patientId:       payload.patientId,
      medicineName:    prescription.medicineName,  // denormalized at creation time
      prescribedDose:  prescription.dosage,        // captured at scheduling time
      route:           payload.route as "oral" | "iv" | "im" | "topical" | "inhaled" | "sublingual" | "rectal" | "other",
      scheduledTime:   payload.scheduledTime,
      recordedBy:      payload.recordedBy,
      notes:           payload.notes || "",
      ...(payload.observationId ? { observationId: payload.observationId } : {}),
    });

    return doc;
  }

  /**
   * Record a dose as administered. Transitions: scheduled → administered.
   */
  static async recordAdministration(administrationId: string, payload: RecordAdministrationPayload) {
    const doc = await MedicationAdministration.findById(administrationId);
    if (!doc) throw new Error("Medication administration record not found");

    marWorkflowEngine.validateTransition(doc.status, "administered");

    doc.status = "administered";
    doc.administeredBy = payload.administeredBy as any;
    doc.recordedBy = payload.recordedBy as any;
    doc.doseGiven = payload.doseGiven || (doc as any).prescribedDose;
    doc.administeredTime = payload.administeredTime || new Date();
    if (payload.notes) doc.notes = payload.notes;
    if (payload.observationId) doc.observationId = payload.observationId as any;

    await doc.save();
    await MARService.emitEvent(doc);
    return doc;
  }

  /**
   * Record patient refusal. Transitions: scheduled → refused.
   * refusalReason is required for accountability.
   */
  static async recordRefusal(administrationId: string, payload: RecordRefusalPayload) {
    if (!payload.refusalReason || payload.refusalReason.trim().length === 0) {
      throw new Error("refusalReason is required when recording a patient refusal");
    }

    const doc = await MedicationAdministration.findById(administrationId);
    if (!doc) throw new Error("Medication administration record not found");

    marWorkflowEngine.validateTransition(doc.status, "refused");

    doc.status = "refused";
    doc.recordedBy = payload.recordedBy as any;
    doc.refusalReason = payload.refusalReason;
    if (payload.notes) doc.notes = payload.notes;

    await doc.save();
    await MARService.emitEvent(doc);
    return doc;
  }

  /**
   * Hold a scheduled dose. Transitions: scheduled → held.
   * holdReason is required for clinical accountability.
   */
  static async holdAdministration(administrationId: string, payload: HoldAdministrationPayload) {
    if (!payload.holdReason || payload.holdReason.trim().length === 0) {
      throw new Error("holdReason is required when holding a scheduled administration");
    }

    const doc = await MedicationAdministration.findById(administrationId);
    if (!doc) throw new Error("Medication administration record not found");

    marWorkflowEngine.validateTransition(doc.status, "held");

    doc.status = "held";
    doc.recordedBy = payload.recordedBy as any;
    doc.holdReason = payload.holdReason;
    if (payload.notes) doc.notes = payload.notes;

    await doc.save();
    await MARService.emitEvent(doc);
    return doc;
  }

  /**
   * Mark a scheduled administration as missed (scheduled time elapsed).
   * Transitions: scheduled → missed.
   */
  static async markMissed(administrationId: string) {
    const doc = await MedicationAdministration.findById(administrationId);
    if (!doc) throw new Error("Medication administration record not found");

    marWorkflowEngine.validateTransition(doc.status, "missed");

    doc.status = "missed";
    await doc.save();
    await MARService.emitEvent(doc);
    return doc;
  }

  /**
   * Retrieve the complete MAR for an encounter, sorted chronologically.
   * Groups entries by prescription for clinical review.
   */
  static async getMAR(encounterId: string) {
    const entries = await MedicationAdministration.find({ encounterId })
      .populate("administeredBy", "name email")
      .populate("recordedBy", "name email")
      .populate("observationId", "code name value unit")
      .sort({ scheduledTime: 1 })
      .lean();

    // Group by prescriptionId for structured MAR display
    const grouped: Record<string, any[]> = {};
    for (const entry of entries as any[]) {
      const key = entry.prescriptionId?.toString() || "ungrouped";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(entry);
    }

    return { entries, grouped };
  }

  /**
   * Retrieve all MAR entries for a single prescription.
   */
  static async getMARByPrescription(prescriptionId: string) {
    return MedicationAdministration.find({ prescriptionId })
      .populate("administeredBy", "name email")
      .populate("recordedBy", "name email")
      .sort({ scheduledTime: 1 })
      .lean();
  }
}
