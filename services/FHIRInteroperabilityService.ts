import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Observation } from "../models/Observation.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";
import { DischargeDocument } from "../models/DischargeDocument.ts";

import { PatientMapper } from "../platform/interoperability/mappers/PatientMapper.ts";
import { EncounterMapper } from "../platform/interoperability/mappers/EncounterMapper.ts";
import { ObservationMapper } from "../platform/interoperability/mappers/ObservationMapper.ts";
import { DiagnosticReportMapper } from "../platform/interoperability/mappers/DiagnosticReportMapper.ts";
import { MedicationAdministrationMapper } from "../platform/interoperability/mappers/MedicationAdministrationMapper.ts";
import { CompositionMapper } from "../platform/interoperability/mappers/CompositionMapper.ts";
import { BundleAssembler } from "../platform/interoperability/mappers/BundleAssembler.ts";

import type {
  FHIRPatient,
  FHIREncounter,
  FHIRObservation,
  FHIRDiagnosticReport,
  FHIRMedicationAdministration,
  FHIRComposition,
  FHIRBundle,
  FHIRResource,
} from "../platform/interoperability/types.ts";

/**
 * FHIRInteroperabilityService — anti-corruption adaptation layer mapping
 * internal MongoDB aggregates into standardized FHIR R4 JSON resources.
 *
 * Invariant: One-directional export ONLY (Internal Domain → FHIR Mapper → FHIR DTO).
 * Never mutates or influences internal domain models.
 */
export class FHIRInteroperabilityService {
  static async toFHIRPatient(patientId: string): Promise<FHIRPatient> {
    const patient = await Patient.findById(patientId).populate("userId", "name phone email").lean();
    if (!patient) throw new Error("Patient not found");
    return PatientMapper.toFHIR(patient);
  }

  static async toFHIREncounter(encounterId: string): Promise<FHIREncounter> {
    const encounter = await Encounter.findById(encounterId).lean();
    if (!encounter) throw new Error("Encounter not found");
    return EncounterMapper.toFHIR(encounter);
  }

  static async toFHIRObservation(observationId: string): Promise<FHIRObservation> {
    const obs = await Observation.findById(observationId).lean();
    if (!obs) throw new Error("Observation not found");
    return ObservationMapper.toFHIR(obs);
  }

  static async toFHIRDiagnosticReport(labOrderId: string): Promise<FHIRDiagnosticReport> {
    const order = await LabOrder.findById(labOrderId).populate("testId", "name code department").lean();
    if (!order) throw new Error("Lab order not found");
    return DiagnosticReportMapper.toFHIR(order);
  }

  static async toFHIRMedicationAdministration(marId: string): Promise<FHIRMedicationAdministration> {
    const mar = await MedicationAdministration.findById(marId).lean();
    if (!mar) throw new Error("Medication administration not found");
    return MedicationAdministrationMapper.toFHIR(mar);
  }

  static async toFHIRComposition(dischargeId: string): Promise<FHIRComposition> {
    const doc = await DischargeDocument.findById(dischargeId).populate("authoredBy", "name").lean();
    if (!doc) throw new Error("Discharge summary document not found");
    return CompositionMapper.toFHIR(doc);
  }

  /**
   * Assembles a complete FHIR R4 document Bundle for an encounter, containing:
   * Patient, Encounter, Composition, Observations, DiagnosticReports, and MedicationAdministrations.
   * Maintains strict referential integrity across resources.
   */
  static async exportEncounterBundle(encounterId: string): Promise<FHIRBundle> {
    const encounterDoc = await Encounter.findById(encounterId).lean();
    if (!encounterDoc) throw new Error("Encounter not found");

    const patientId = encounterDoc.patientId?.toString();
    const patientDoc = await Patient.findById(patientId).populate("userId", "name phone email").lean();
    if (!patientDoc) throw new Error("Patient not found");

    const resources: FHIRResource[] = [];

    // 1. Patient Resource
    const fhirPatient = PatientMapper.toFHIR(patientDoc);
    resources.push(fhirPatient);

    // 2. Encounter Resource
    const fhirEncounter = EncounterMapper.toFHIR(encounterDoc);
    resources.push(fhirEncounter);

    // 3. Discharge Composition (if present)
    const dischargeDoc = await DischargeDocument.findOne({ encounterId }).populate("authoredBy", "name").lean();
    if (dischargeDoc) {
      resources.push(CompositionMapper.toFHIR(dischargeDoc));
    }

    // 4. Observations (Vitals)
    const observations = await Observation.find({ encounterId }).lean();
    for (const obs of observations) {
      resources.push(ObservationMapper.toFHIR(obs));
    }

    // 5. Diagnostic Lab Reports
    const labOrders = await LabOrder.find({ encounterId }).populate("testId", "name code department").lean();
    for (const lab of labOrders) {
      resources.push(DiagnosticReportMapper.toFHIR(lab));
    }

    // 6. Medication Administrations
    const marEntries = await MedicationAdministration.find({ encounterId }).lean();
    for (const mar of marEntries) {
      resources.push(MedicationAdministrationMapper.toFHIR(mar));
    }

    return BundleAssembler.createDocumentBundle(resources);
  }
}
