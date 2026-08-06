import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { FhirR4ConverterService } from "../services/FhirR4ConverterService.ts";
import { errorResponse } from "../utilities/helpers.ts";
import { checkOperationalRecordAccess, checkPatientAccess } from "../utilities/tenant.ts";

async function denyIfOutOfScope(req: FastifyRequest, reply: FastifyReply, record: any) {
  const access = await checkOperationalRecordAccess(req, record);
  if (!access.allowed) {
    reply.code(access.statusCode).send(errorResponse(access.message));
    return true;
  }
  return false;
}

export async function getFhirPatientResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid FHIR Patient ID"));
    }

    const patient = await Patient.findById(id).populate("userId", "name email phone");
    if (!patient) {
      return reply.code(404).send(errorResponse("FHIR Patient resource not found"));
    }
    const patientAccess = await checkPatientAccess(req, id);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const fhirRes = FhirR4ConverterService.toFhirPatient(patient);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirPatientResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFhirObservationResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const rawId = id.startsWith("obs-") ? id.replace("obs-", "") : id;

    let encounter: any = null;
    if (mongoose.Types.ObjectId.isValid(rawId)) {
      encounter = await Encounter.findById(rawId);
      if (!encounter) {
        const { Observation } = await import("../models/Observation.ts");
        const obsDoc = await Observation.findById(rawId);
        if (obsDoc) {
          if (await denyIfOutOfScope(req, reply, obsDoc)) return;
            encounter = {
            id: obsDoc.id || obsDoc._id?.toString(),
            encounterId: obsDoc.encounterId?.toString() || obsDoc.encounterId,
            patientId: obsDoc.patientId,
            clinicId: obsDoc.clinicId,
            organizationId: obsDoc.organizationId,
            code: obsDoc.code === "SPO2" ? "59408-5" : undefined,
            createdAt: obsDoc.recordedAt || obsDoc.createdAt,
            vitals: obsDoc.vitals || {},
            value: obsDoc.value,
            unit: obsDoc.unit,
          };
        }
      }
    }

    if (!encounter) {
      return reply.code(404).send(errorResponse("FHIR Observation resource not found"));
    }
    if (await denyIfOutOfScope(req, reply, encounter)) return;

    const fhirRes = FhirR4ConverterService.toFhirObservation(encounter);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirObservationResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFhirDiagnosticReportResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid FHIR DiagnosticReport ID"));
    }

    const labOrder = await LabOrder.findById(id).populate("testId", "name code");
    if (!labOrder) {
      return reply.code(404).send(errorResponse("FHIR DiagnosticReport resource not found"));
    }
    if (await denyIfOutOfScope(req, reply, labOrder)) return;

    const fhirRes = FhirR4ConverterService.toFhirDiagnosticReport(labOrder);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirDiagnosticReportResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFhirEncounterResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid FHIR Encounter ID"));
    }

    const encounter = await Encounter.findById(id);
    if (!encounter) {
      return reply.code(404).send(errorResponse("FHIR Encounter resource not found"));
    }
    if (await denyIfOutOfScope(req, reply, encounter)) return;

    const fhirRes = FhirR4ConverterService.toFhirEncounter(encounter);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirEncounterResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFhirMedicationAdministrationResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid FHIR MedicationAdministration ID"));
    }

    const { MedicationAdministration } = await import("../models/MedicationAdministration.ts");
    const marDoc = await MedicationAdministration.findById(id);
    if (!marDoc) {
      return reply.code(404).send(errorResponse("FHIR MedicationAdministration resource not found"));
    }
    if (await denyIfOutOfScope(req, reply, marDoc)) return;

    const fhirRes = FhirR4ConverterService.toFhirMedicationAdministration(marDoc);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirMedicationAdministrationResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFhirCompositionResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    let doc: any = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      doc = await Encounter.findById(id);
      if (!doc) {
        const { DischargeDocument } = await import("../models/DischargeDocument.ts");
        doc = await DischargeDocument.findById(id);
      }
      if (!doc) {
        const { ClinicalNote } = await import("../models/ClinicalNote.ts");
        doc = await ClinicalNote.findById(id) || await ClinicalNote.findOne({ encounterId: id });
      }
    }

    if (!doc) {
      return reply.code(404).send(errorResponse("FHIR Composition resource not found"));
    }
    if (await denyIfOutOfScope(req, reply, doc)) return;

    const fhirRes = FhirR4ConverterService.toFhirComposition(doc);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirCompositionResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function exportFhirEncounterBundleResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid FHIR Encounter ID"));
    }

    const encounter = await Encounter.findById(id);
    if (!encounter) {
      return reply.code(404).send(errorResponse("FHIR Encounter resource not found"));
    }
    if (await denyIfOutOfScope(req, reply, encounter)) return;

    const { MedicationAdministration } = await import("../models/MedicationAdministration.ts");
    const { ClinicalNote } = await import("../models/ClinicalNote.ts");

    const organizationId = req.user?.organization_id;
    const scopeFilter = organizationId
      ? { patientId: encounter.patientId, organizationId }
      : { patientId: encounter.patientId };
    const patient = await Patient.findById(encounter.patientId).populate("userId", "name email phone");
    const labOrders = await LabOrder.find(scopeFilter).populate("testId", "name code");
    const mars = await MedicationAdministration.find(scopeFilter);
    const notes = await ClinicalNote.find(scopeFilter);

    const fhirBundle = FhirR4ConverterService.toFhirBundle(patient || { _id: encounter.patientId }, [encounter], labOrders, mars, notes);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirBundle);
  } catch (err) {
    console.error("exportFhirEncounterBundleResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFhirBundleResource(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId } = req.params as { patientId: string };
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return reply.code(400).send(errorResponse("Invalid Patient ID for FHIR Bundle"));
    }

    const { MedicationAdministration } = await import("../models/MedicationAdministration.ts");
    const { ClinicalNote } = await import("../models/ClinicalNote.ts");

    const patient = await Patient.findById(patientId).populate("userId", "name email phone");
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const organizationId = req.user?.organization_id;
    const scopeFilter = organizationId ? { patientId, organizationId } : { patientId };
    const encounters = await Encounter.find(scopeFilter);
    const labOrders = await LabOrder.find(scopeFilter).populate("testId", "name code");
    const mars = await MedicationAdministration.find(scopeFilter);
    const notes = await ClinicalNote.find(scopeFilter);

    const fhirBundle = FhirR4ConverterService.toFhirBundle(patient, encounters, labOrders, mars, notes);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirBundle);
  } catch (err) {
    console.error("getFhirBundleResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
