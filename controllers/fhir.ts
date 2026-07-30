import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { FhirR4ConverterService } from "../services/FhirR4ConverterService.ts";
import { errorResponse } from "../utilities/helpers.ts";

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
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid FHIR Observation ID"));
    }

    const encounter = await Encounter.findById(id);
    if (!encounter) {
      return reply.code(404).send(errorResponse("FHIR Observation resource not found"));
    }

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

    const fhirRes = FhirR4ConverterService.toFhirDiagnosticReport(labOrder);
    reply.header("Content-Type", "application/fhir+json");
    return reply.code(200).send(fhirRes);
  } catch (err) {
    console.error("getFhirDiagnosticReportResource error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
