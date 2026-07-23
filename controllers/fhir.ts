import type { FastifyRequest, FastifyReply } from "fastify";
import { FHIRInteroperabilityService } from "../services/FHIRInteroperabilityService.ts";
import { errorResponse } from "../utilities/helpers.ts";

/**
 * GET /api/fhir/R4/Patient/:id
 * Exports FHIR R4 Patient JSON. Permission: VIEW_EHR
 */
export async function getFHIRPatientController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const fhir = await FHIRInteroperabilityService.toFHIRPatient(id);
    return reply.code(200).type("application/fhir+json").send(fhir);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/fhir/R4/Encounter/:id
 * Exports FHIR R4 Encounter JSON. Permission: VIEW_EHR
 */
export async function getFHIREncounterController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const fhir = await FHIRInteroperabilityService.toFHIREncounter(id);
    return reply.code(200).type("application/fhir+json").send(fhir);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/fhir/R4/Observation/:id
 * Exports FHIR R4 Observation JSON. Permission: VIEW_EHR
 */
export async function getFHIRObservationController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const fhir = await FHIRInteroperabilityService.toFHIRObservation(id);
    return reply.code(200).type("application/fhir+json").send(fhir);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/fhir/R4/DiagnosticReport/:id
 * Exports FHIR R4 DiagnosticReport JSON. Permission: VIEW_EHR
 */
export async function getFHIRDiagnosticReportController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const fhir = await FHIRInteroperabilityService.toFHIRDiagnosticReport(id);
    return reply.code(200).type("application/fhir+json").send(fhir);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/fhir/R4/MedicationAdministration/:id
 * Exports FHIR R4 MedicationAdministration JSON. Permission: VIEW_EHR
 */
export async function getFHIRMedicationAdministrationController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const fhir = await FHIRInteroperabilityService.toFHIRMedicationAdministration(id);
    return reply.code(200).type("application/fhir+json").send(fhir);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/fhir/R4/Composition/:id
 * Exports FHIR R4 Composition JSON (Discharge Summary). Permission: VIEW_EHR
 */
export async function getFHIRCompositionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const fhir = await FHIRInteroperabilityService.toFHIRComposition(id);
    return reply.code(200).type("application/fhir+json").send(fhir);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/fhir/R4/Encounter/:id/$export
 * Exports complete FHIR R4 document Bundle for an encounter. Permission: VIEW_EHR
 */
export async function exportFHIREncounterBundleController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const bundle = await FHIRInteroperabilityService.exportEncounterBundle(encounterId);
    return reply.code(200).type("application/fhir+json").send(bundle);
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}
