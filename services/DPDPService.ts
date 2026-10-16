/** Organization-scoped privacy controls; does not certify legal compliance. */
import { AuditLog } from "../models/AuditLog.ts";
import { DataBreachIncident, type BreachSeverity, type DataCategory } from "../models/DataBreachIncident.ts";
import { reportCriticalError } from "../utilities/telemetry.ts";
import { exportPatientData } from "./PatientDataExportService.ts";
import { requestPatientErasure } from "./PatientPrivacyService.ts";
import { getPatientConsents, updatePatientConsents } from "./PatientConsentService.ts";

export class DPDPService {
  static exportPatientData = exportPatientData;
  static executePatientErasure = requestPatientErasure;
  static getPatientConsents = getPatientConsents;
  static updatePatientConsents = updatePatientConsents;
  static async recordBreachIncident(
    data: {
      organizationId: string;
      title: string;
      description: string;
      severity: BreachSeverity;
      dataCategoriesExposed: DataCategory[];
      affectedSubjectsCount?: number;
      affectedPatientIds?: string[];
      rootCause?: string;
      remediationSteps?: string;
    },
    reporterId: string
  ) {
    const year = new Date().getFullYear();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const incidentId = `INC-DPDP-${year}-${randomSuffix}`;

    const incident = new DataBreachIncident({
      incidentId,
      organizationId: data.organizationId,
      reportedBy: reporterId,
      title: data.title,
      description: data.description,
      severity: data.severity,
      dataCategoriesExposed: data.dataCategoriesExposed,
      affectedSubjectsCount: data.affectedSubjectsCount || 0,
      affectedPatientIds: data.affectedPatientIds || [],
      rootCause: data.rootCause,
      remediationSteps: data.remediationSteps,
      status: "DETECTED",
      discoveredAt: new Date(),
      dpbiReportPayload: {
        statutoryStandard: "DPDPA_2023_SECTION_8_SUBSECTION_6",
        fiduciaryIncidentId: incidentId,
        organizationId: data.organizationId,
        reportedAt: new Date().toISOString(),
        natureOfBreach: data.title,
        severityLevel: data.severity,
        exposedDataCategories: data.dataCategoriesExposed,
        estimatedAffectedSubjects: data.affectedSubjectsCount || 0,
        containmentMeasures: data.remediationSteps || "Triage and containment in progress",
      },
    });

    await incident.save();

    // Critical or High severity triggers on-call pager immediately
    if (data.severity === "CRITICAL" || data.severity === "HIGH") {
      await reportCriticalError(
        `DPDP_SECURITY_BREACH_${data.severity}`,
        new Error(`Exposed categories: ${data.dataCategoriesExposed.join(", ")}. Est subjects: ${data.affectedSubjectsCount}`),
        {
          component: "DPDPCompliance",
          incidentId,
          locationId: data.organizationId,
        }
      );
    }

    await AuditLog.create({
      userId: reporterId,
      organizationId: data.organizationId,
      action: "DPDP_BREACH_LOGGED",
      targetId: incident._id,
      targetModel: "DataBreachIncident",
      category: "COMPLIANCE_DPDP",
      details: {
        incidentId,
        severity: data.severity,
        exposedCategories: data.dataCategoriesExposed,
        affectedCount: data.affectedSubjectsCount,
      },
    });

    return incident;
  }

  /**
   * Generates formatted statutory filing dossier for the Data Protection Board of India (DPBI)
   */
  static async generateDPBIReport(incidentId: string, organizationId: string) {
    if (!organizationId) throw new Error("Organization context required");
    const incident = await DataBreachIncident.findOne({ incidentId, organizationId }).populate("organizationId", "name slug email").lean();
    if (!incident) {
      throw new Error("Incident not found");
    }

    const org: any = incident.organizationId;

    return {
      header: {
        recipient: "Data Protection Board of India (DPBI)",
        filingType: "NOTICE_OF_PERSONAL_DATA_BREACH",
        governingSection: "Section 8(6), Digital Personal Data Protection Act, 2023",
        filingTimestamp: new Date().toISOString(),
      },
      dataFiduciary: {
        name: org?.name || "Ekavyu Facility",
        identifier: org?._id || incident.organizationId,
        contactEmail: org?.email || "compliance@ekavyu.health",
      },
      incidentDetails: {
        incidentTrackingNumber: incident.incidentId,
        timeOfDiscovery: incident.discoveredAt,
        timeOfContainment: incident.containedAt || "Pending full containment",
        assessedSeverity: incident.severity,
        natureOfIncident: incident.title,
        detailedDescription: incident.description,
        categoriesOfPersonalDataCompromised: incident.dataCategoriesExposed,
        numberOfAffectedDataSubjects: incident.affectedSubjectsCount,
        rootCauseIdentified: incident.rootCause || "Under forensic review",
        remediationAndMitigationMeasures: incident.remediationSteps || "Containment steps applied",
      },
      affectedSubjectNotificationPlan: {
        notifiedAt: incident.notifiedSubjectsAt || null,
        channelsUsed: ["WHATSAPP", "EMAIL", "SMS"],
        supportContact: "dpo@ekavyu.health",
      },
    };
  }
}
