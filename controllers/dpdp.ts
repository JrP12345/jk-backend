import type { FastifyRequest, FastifyReply } from "fastify";
import { Patient } from "../models/Patient.ts";
import { DataBreachIncident } from "../models/DataBreachIncident.ts";
import { DPDPService } from "../services/DPDPService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

/**
 * Resolves the target patient ID from the authenticated user context.
 * If user is a patient, finds their linked Patient document.
 * If staff/admin, reads from query or route params.
 */
async function resolvePatientId(req: FastifyRequest): Promise<{ patientId: string; orgId?: string }> {
  const userRole = req.user?.role;
  const scope = resolveAuthorizedOrganizationScope(req);
  const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;

  if (userRole === "patient") {
    const patient = await Patient.findOne({ userId: req.user!.id });
    if (!patient) {
      throw new Error("Patient profile not found for authenticated account");
    }
    return { patientId: patient._id.toString(), orgId: patient.organizationId?.toString() };
  }

  // Staff access: check query or body
  const query = req.query as { patientId?: string };
  const body = req.body as { patientId?: string };
  const patientId = query?.patientId || body?.patientId;

  if (!patientId) {
    throw new Error("patientId parameter is required for staff access");
  }

  return { patientId, orgId };
}

// ─── 1. Data Portability Export (Section 11) ──────────────────────────────
export async function exportPatientData(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, orgId } = await resolvePatientId(req);
    const dataDossier = await DPDPService.exportPatientData(patientId, orgId);
    return reply.code(200).send(successResponse(dataDossier, "Patient data exported successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to export patient data"));
  }
}

// ─── 2. Right to Erasure with NMC Carve-Out (Section 12 & 17) ──────────────
export async function requestPatientErasure(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, orgId } = await resolvePatientId(req);
    const { reason } = (req.body as { reason?: string }) || {};

    const result = await DPDPService.executePatientErasure(
      patientId,
      req.user!.id,
      reason,
      orgId
    );

    return reply.code(200).send(successResponse(result, "Erasure request processed under NMC retention rules"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to process erasure request"));
  }
}

// ─── 3. Purpose Consent Ledger (Section 6) ────────────────────────────────
export async function getPatientConsents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, orgId } = await resolvePatientId(req);
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization context required"));
    }

    const consent = await DPDPService.getPatientConsents(patientId, orgId);
    return reply.code(200).send(successResponse(consent));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to fetch consents"));
  }
}

export async function updatePatientConsents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, orgId } = await resolvePatientId(req);
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization context required"));
    }

    const { updates } = req.body as { updates: any[] };
    if (!Array.isArray(updates) || updates.length === 0) {
      return reply.code(400).send(errorResponse("updates array is required"));
    }

    const auditContext = {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] as string,
      source: req.user?.role === "patient" ? "PATIENT_PORTAL" : "CLINIC_DESK",
    };

    const updated = await DPDPService.updatePatientConsents(patientId, orgId, updates, auditContext);
    return reply.code(200).send(successResponse(updated, "Consent updated successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to update consents"));
  }
}

// ─── 4. Data Breach Incident Governance (Section 8(6)) ─────────────────────
export async function recordBreachIncident(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId && req.user?.role !== "root") {
      return reply.code(403).send(errorResponse("Organization context required"));
    }

    const body = req.body as any;
    if (!body.title || !body.description || !body.severity || !body.dataCategoriesExposed) {
      return reply.code(400).send(errorResponse("Missing required breach incident fields"));
    }

    const incident = await DPDPService.recordBreachIncident(
      {
        ...body,
        organizationId: orgId || body.organizationId,
      },
      req.user!.id
    );

    return reply.code(201).send(successResponse(incident, "Breach incident logged successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to log breach incident"));
  }
}

export async function getBreachIncidents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && req.user?.role !== "root") return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const filter: any = {};
    if (orgId && req.user?.role !== "root") {
      filter.organizationId = orgId;
    }

    const incidents = await DataBreachIncident.find(filter).sort({ createdAt: -1 }).lean();
    return reply.code(200).send(successResponse(incidents));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function generateIncidentDPBIReport(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { incidentId } = req.params as { incidentId: string };
    const report = await DPDPService.generateDPBIReport(incidentId);
    return reply.code(200).send(successResponse(report, "DPBI statutory dossier generated"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to generate DPBI report"));
  }
}
