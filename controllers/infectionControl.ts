import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { InfectionControl } from "../models/InfectionControl.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getInfectionIncidents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, ward, infectionType, riskLevel, status } = req.query as {
      clinicId?: string;
      ward?: string;
      infectionType?: string;
      riskLevel?: string;
      status?: string;
    };

    const query: any = {
      deletedAt: null,
    };

    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      query.clinicId = new mongoose.Types.ObjectId(clinicId);
    } else if (user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      query.organizationId = new mongoose.Types.ObjectId(orgId);
    }

    if (ward && ward !== "ALL") query.ward = ward;
    if (infectionType && infectionType !== "ALL") query.infectionType = infectionType;
    if (riskLevel && riskLevel !== "ALL") query.riskLevel = riskLevel;
    if (status && status !== "ALL") query.status = status;

    const incidents = await InfectionControl.find(query).sort({ detectionDate: -1 });

    // KPI Metrics calculation
    const totalActive = incidents.filter((i) => i.status === "confirmed_active" || i.status === "suspected").length;
    const activeIsolationCount = incidents.filter((i) => i.isolationStatus !== "none" && i.status !== "cleared").length;
    const criticalRiskCount = incidents.filter((i) => i.riskLevel === "critical" || i.riskLevel === "high").length;
    const sanitizationCompleted = incidents.filter((i) => i.environmentalSanitizationDone).length;
    
    const haiCount = incidents.filter((i) => i.infectionType.startsWith("HAI_")).length;
    const haiRatePercentage = incidents.length > 0 ? ((haiCount / incidents.length) * 100).toFixed(1) : "0.0";

    return reply.code(200).send(
      successResponse({
        incidents,
        metrics: {
          totalIncidents: incidents.length,
          totalActive,
          activeIsolationCount,
          criticalRiskCount,
          sanitizationCompleted,
          haiCount,
          haiRatePercentage: `${haiRatePercentage}%`,
        },
      })
    );
  } catch (err) {
    console.error("getInfectionIncidents error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching infection control incidents"));
  }
}

export async function createInfectionIncident(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      patientId,
      patientName,
      ward,
      pathogenName,
      infectionType,
      isolationStatus,
      riskLevel,
      antimicrobialRegimen,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!patientName?.trim() || !ward?.trim() || !pathogenName?.trim()) {
      return reply.code(400).send(errorResponse("patientName, ward, and pathogenName are required"));
    }

    const incident = await InfectionControl.create({
      organizationId: scope.organizationId || undefined,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      patientId: patientId && mongoose.Types.ObjectId.isValid(patientId) ? new mongoose.Types.ObjectId(patientId) : undefined,
      patientName: patientName.trim(),
      ward: ward.trim(),
      pathogenName: pathogenName.trim(),
      infectionType: infectionType || "HAI_CLABSI",
      isolationStatus: isolationStatus || "contact_isolation",
      riskLevel: riskLevel || "high",
      reportedBy: user!.id,
      status: "confirmed_active",
      antimicrobialRegimen: antimicrobialRegimen || "",
      notes: notes || "",
    });

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "INFECTION_INCIDENT_CREATE",
      targetId: incident._id,
      targetModel: "InfectionControl",
      details: { pathogenName: incident.pathogenName, infectionType: incident.infectionType, ward: incident.ward }
    });

    return reply.code(201).send(successResponse(incident, "Infection surveillance incident logged successfully"));
  } catch (err) {
    console.error("createInfectionIncident error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating infection incident"));
  }
}

export async function updateInfectionStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { status, isolationStatus, environmentalSanitizationDone, antimicrobialRegimen } = req.body as {
      status?: string;
      isolationStatus?: string;
      environmentalSanitizationDone?: boolean;
      antimicrobialRegimen?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid incident ID"));
    }

    const incident = await InfectionControl.findById(id);
    if (!incident || incident.deletedAt) {
      return reply.code(404).send(errorResponse("Infection control incident entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, incident);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (status) incident.status = status as any;
    if (isolationStatus) incident.isolationStatus = isolationStatus as any;
    if (typeof environmentalSanitizationDone === "boolean") incident.environmentalSanitizationDone = environmentalSanitizationDone;
    if (antimicrobialRegimen !== undefined) incident.antimicrobialRegimen = antimicrobialRegimen;

    await incident.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "INFECTION_INCIDENT_STATUS_UPDATE",
      targetId: incident._id,
      targetModel: "InfectionControl",
      details: { pathogenName: incident.pathogenName, status: incident.status, isolationStatus: incident.isolationStatus }
    });

    return reply.code(200).send(successResponse(incident, "Infection control incident updated successfully"));
  } catch (err) {
    console.error("updateInfectionStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating infection status"));
  }
}

export async function deleteInfectionIncident(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid incident ID"));
    }

    const incident = await InfectionControl.findById(id);
    if (!incident || incident.deletedAt) {
      return reply.code(404).send(errorResponse("Infection control incident entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, incident);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    incident.deletedAt = new Date();
    await incident.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "INFECTION_INCIDENT_DELETE",
      targetId: incident._id,
      targetModel: "InfectionControl",
      details: { pathogenName: incident.pathogenName }
    });

    return reply.code(200).send(successResponse(incident, "Infection control incident deleted successfully"));
  } catch (err) {
    console.error("deleteInfectionIncident error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting infection incident"));
  }
}
