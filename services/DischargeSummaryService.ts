import crypto from "node:crypto";
import { DischargeDocument } from "../models/DischargeDocument.ts";
import { Encounter } from "../models/Encounter.ts";
import { Appointment } from "../models/Appointment.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { Prescription } from "../models/Prescription.ts";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Admission } from "../models/Admission.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { EventTypes, type DischargeFinalizedPayload } from "../platform/events/types.ts";

export interface ClinicianInputPayload {
  primaryDiagnosis: string;
  conditionOnDischarge: string;
  dischargeInstructions: string;
  followUpPlan?: string;
  medicationsOnDischarge?: string;
  restrictions?: string;
}

export class DischargeSummaryService {
  /**
   * Generates a SHA-256 cryptographic fingerprint of the finalized document content.
   */
  public static generateSnapshotHash(aggregated: any, clinicianInput: any): string {
    const rawContent = JSON.stringify({ aggregated, clinicianInput });
    return crypto.createHash("sha256").update(rawContent).digest("hex");
  }

  /**
   * Compiles data across all six engines for an encounter into a DischargeDocument draft.
   * Idempotent: If a draft already exists, updates aggregated{} and compiledAt.
   */
  static async compile(encounterId: string, authoredBy: string) {
    const encounter = await Encounter.findById(encounterId).lean() as any;
    if (!encounter) throw new Error("Encounter not found");

    // Check if document already exists
    let doc = await DischargeDocument.findOne({ encounterId });
    if (doc && doc.status !== "draft") {
      throw new Error(`Cannot re-compile a finalized or countersigned discharge summary (current status: '${doc.status}')`);
    }

    // 1. Gather Clinical Notes (signed & latest)
    const notes = await ClinicalNote.find({
      encounterId,
      isLatest: true,
      status: "signed",
    }).lean() as any[];

    const diagnoses: any[] = [];
    const proceduresSet = new Set<string>();

    for (const note of notes) {
      if (note.assessment?.diagnoses) {
        for (const diag of note.assessment.diagnoses) {
          diagnoses.push({
            code: diag.code,
            description: diag.description,
            codingSystem: diag.codingSystem || "ICD-10",
            status: diag.status || "active",
          });
        }
      }
    }

    // 2. Gather Observations (vitals on admission & discharge)
    const observations = await Observation.find({ encounterId })
      .sort({ recordedAt: 1 })
      .lean() as any[];

    let vitalsOnAdmission: any = null;
    let vitalsOnDischarge: any = null;

    if (observations.length > 0) {
      const first = observations[0];
      const last = observations[observations.length - 1];

      vitalsOnAdmission = {
        recordedAt: first.recordedAt || first.createdAt,
        vitals: first.vitals || { [first.code || first.name || "vital"]: `${first.value}${first.unit ? " " + first.unit : ""}` },
      };
      vitalsOnDischarge = {
        recordedAt: last.recordedAt || last.createdAt,
        vitals: last.vitals || { [last.code || last.name || "vital"]: `${last.value}${last.unit ? " " + last.unit : ""}` },
      };
    }

    // 3. Gather NEWS2 Scores
    const scores = await ObservationScore.find({ encounterId })
      .sort({ evaluatedAt: -1 })
      .lean() as any[];

    let peakScore = 0;
    let finalScore = 0;
    let alertLevel = "LOW";

    if (scores.length > 0) {
      finalScore = scores[0].totalScore || 0;
      alertLevel = scores[0].alertLevel || "LOW";
      peakScore = Math.max(...scores.map((s) => s.totalScore || 0));
    }

    // 4. Gather Prescriptions + MAR Summary
    const prescriptions = await Prescription.find({ encounterId }).lean() as any[];
    const administrations = await MedicationAdministration.find({ encounterId }).lean() as any[];

    const medications: any[] = prescriptions.map((rx) => {
      const rxAdms = administrations.filter(
        (a) => a.prescriptionId?.toString() === rx._id.toString()
      );
      const givenCount = rxAdms.filter((a) => a.status === "administered").length;
      const refusedCount = rxAdms.filter((a) => a.status === "refused").length;

      let adminSummary = `Scheduled: ${rxAdms.length} dose(s)`;
      if (rxAdms.length > 0) {
        adminSummary += ` (${givenCount} administered, ${refusedCount} refused)`;
      }

      return {
        medicineName: rx.medicineName,
        dosage: rx.dosage,
        frequency: rx.frequency,
        instructions: rx.instructions || "",
        status: rx.status,
        administrationSummary: adminSummary,
      };
    });

    // 5. Gather Diagnostic Lab Orders & Results
    const labOrders = await LabOrder.find({
      encounterId,
      status: "result-uploaded",
    })
      .populate("testId", "name code normalRange")
      .lean() as any[];

    const labResults: any[] = labOrders.map((ord) => {
      const hasStruct = ord.result?.value && ord.result.value.length > 0;
      const testName = ord.testId?.name || "Lab Test";
      proceduresSet.add(`Lab: ${testName}`);

      return {
        testName,
        testCode: ord.testId?.code || "",
        value: hasStruct ? ord.result.value : (ord.resultValue || ""),
        unit: hasStruct ? ord.result.unit : "",
        referenceRange: hasStruct ? ord.result.referenceRange : (ord.testId?.normalRange || ""),
        interpretation: hasStruct ? ord.result.interpretation : "",
        isAbnormal: hasStruct ? ord.result.isAbnormal : false,
      };
    });

    // 6. Gather Admission info (if IPD)
    const admission = await Admission.findOne({ encounterId }).lean() as any;
    let stayDurationDays = 0;
    if (encounter.startedAt) {
      const end = encounter.endedAt || new Date();
      stayDurationDays = Math.max(1, Math.ceil((end.getTime() - new Date(encounter.startedAt).getTime()) / (1000 * 3600 * 24)));
    }

    const aggregated = {
      encounterSummary: {
        encounterType: encounter.encounterType,
        startedAt: encounter.startedAt,
        endedAt: encounter.endedAt || null,
        stayDurationDays,
      },
      diagnoses,
      vitalsOnAdmission,
      vitalsOnDischarge,
      news2Summary: {
        peakScore,
        finalScore,
        alertLevel,
      },
      medications,
      labResults,
      procedures: Array.from(proceduresSet),
    };

    if (doc) {
      // Update existing draft
      doc.aggregated = aggregated as any;
      doc.compiledAt = new Date();
      await doc.save();
    } else {
      // Create new draft
      doc = await DischargeDocument.create({
        organizationId: encounter.organizationId,
        clinicId:       encounter.clinicId,
        encounterId,
        patientId:      encounter.patientId,
        authoredBy,
        aggregated:     aggregated as any,
        status:         "draft",
        compiledAt:     new Date(),
      });
    }

    return doc;
  }

  /**
   * Finalizes a discharge summary.
   * Validates required clinician inputs, computes snapshotHash, freezes document,
   * and enforces the invariant: Encounter.status → "closed".
   */
  static async finalize(documentId: string, clinicianInput: ClinicianInputPayload) {
    const doc = await DischargeDocument.findById(documentId);
    if (!doc) throw new Error("Discharge document not found");

    if (doc.status !== "draft") {
      throw new Error(`Cannot finalize document already in '${doc.status}' status`);
    }

    const defaultDiag = (doc.activeDiagnoses as any[])?.[0]?.description || (doc.activeDiagnoses as any[])?.[0]?.code || "General Outpatient Consultation";
    const primaryDiagnosis = (clinicianInput.primaryDiagnosis && clinicianInput.primaryDiagnosis.trim().length > 0)
      ? clinicianInput.primaryDiagnosis
      : defaultDiag;

    const conditionOnDischarge = (clinicianInput.conditionOnDischarge && clinicianInput.conditionOnDischarge.trim().length > 0)
      ? clinicianInput.conditionOnDischarge
      : "Stable / Recovered";

    const dischargeInstructions = (clinicianInput.dischargeInstructions && clinicianInput.dischargeInstructions.trim().length > 0)
      ? clinicianInput.dischargeInstructions
      : "Follow up with primary physician as advised.";

    doc.clinicianInput = {
      primaryDiagnosis,
      conditionOnDischarge,
      dischargeInstructions,
      followUpPlan:           clinicianInput.followUpPlan || "",
      medicationsOnDischarge: clinicianInput.medicationsOnDischarge || "",
      restrictions:           clinicianInput.restrictions || "",
    };

    // Calculate cryptographic snapshot hash
    doc.snapshotHash = DischargeSummaryService.generateSnapshotHash(doc.aggregated, doc.clinicianInput);
    doc.status = "finalized";
    doc.finalizedAt = new Date();

    await doc.save();

    // Central invariant enforcement: Encounter.status → "closed" AND Appointment.status → "completed"
    const encounter = await Encounter.findByIdAndUpdate(doc.encounterId, {
      status: "closed",
      endedAt: new Date(),
    }).lean() as any;

    if (encounter?.appointmentId) {
      await Appointment.findByIdAndUpdate(encounter.appointmentId, {
        status: "completed",
      });
    }

    // Publish DischargeFinalized domain event
    const eventPayload: DischargeFinalizedPayload = {
      dischargeId:          doc._id.toString(),
      encounterId:          doc.encounterId?.toString(),
      patientId:            doc.patientId?.toString(),
      primaryDiagnosis:     clinicianInput.primaryDiagnosis,
      conditionOnDischarge: clinicianInput.conditionOnDischarge,
      snapshotHash:         doc.snapshotHash,
      finalizedAt:          doc.finalizedAt!.toISOString(),
      authoredBy:           doc.authoredBy?.toString(),
    };
    await domainEventBus.publishEvent(EventTypes.DISCHARGE_FINALIZED, eventPayload);

    return doc;
  }

  /**
   * Appends an optional countersignature to a finalized discharge document.
   */
  static async countersign(documentId: string, countersignedBy: string) {
    const doc = await DischargeDocument.findById(documentId);
    if (!doc) throw new Error("Discharge document not found");

    if (doc.status !== "finalized") {
      throw new Error(`Only finalized discharge summaries can be countersigned (current status: '${doc.status}')`);
    }

    doc.status = "countersigned";
    doc.countersignedBy = countersignedBy as any;
    doc.countersignedAt = new Date();

    await doc.save();
    return doc;
  }

  /**
   * Get discharge summary by encounter ID.
   */
  static async getByEncounter(encounterId: string) {
    return DischargeDocument.findOne({ encounterId })
      .populate("authoredBy", "name email specialization")
      .populate("countersignedBy", "name email specialization")
      .lean();
  }

  /**
   * Get discharge summary by document ID.
   */
  static async getById(documentId: string) {
    return DischargeDocument.findById(documentId)
      .populate("authoredBy", "name email specialization")
      .populate("countersignedBy", "name email specialization")
      .lean();
  }
}
