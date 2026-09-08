/**
 * HealthOS DPDP (Digital Personal Data Protection Act 2023) Compliance Engine
 *
 * Implements:
 * 1. Data Portability / Machine-Readable Export (Section 11)
 * 2. Right to Erasure with NMC 3-Year Medical Retention Carve-Out (Section 12 & Section 17)
 * 3. Purpose-Based Consent Ledger & WhatsApp/AI Withdrawal (Section 6)
 * 4. Personal Data Breach Incident Management & DPBI Statutory Dossier (Section 8(6))
 */

import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { DPDPConsent, DPDP_PURPOSES, type DPDPPurpose } from "../models/DPDPConsent.ts";
import { DataBreachIncident, type BreachSeverity, type DataCategory } from "../models/DataBreachIncident.ts";
import { reportCriticalError } from "../utilities/telemetry.ts";

export class DPDPService {
  /**
   * 1. Data Portability & Access (DPDPA 2023 Section 11)
   * Aggregates all patient records into a structured, machine-readable JSON export.
   */
  static async exportPatientData(patientId: string, orgId?: string) {
    const patientFilter: any = { _id: patientId };
    if (orgId) patientFilter.organizationId = orgId;

    const patient = await Patient.findOne(patientFilter).lean();
    if (!patient) {
      throw new Error("Patient not found or unauthorized");
    }

    // Fetch medical and administrative records in parallel
    const [appointments, encounters, prescriptions, labOrders, invoices, consentDoc] = await Promise.all([
      Appointment.find({ patientId }).sort({ appointmentDate: -1 }).lean(),
      Encounter.find({ patientId }).sort({ createdAt: -1 }).lean(),
      Prescription.find({ patientId }).sort({ createdAt: -1 }).lean(),
      LabOrder.find({ patientId }).sort({ createdAt: -1 }).lean(),
      Invoice.find({ patientId }).sort({ createdAt: -1 }).lean(),
      DPDPConsent.findOne({ patientId }).lean(),
    ]);

    // Record audit event for compliance tracking
    await AuditLog.create({
      userId: (patient as any).userId || (patient as any)._id,
      organizationId: patient.organizationId,
      action: "DPDP_DATA_EXPORTED",
      targetId: (patient as any)._id,
      targetModel: "Patient",
      category: "COMPLIANCE_DPDP",
      details: {
        recordCounts: {
          appointments: appointments.length,
          encounters: encounters.length,
          prescriptions: prescriptions.length,
          labOrders: labOrders.length,
          invoices: invoices.length,
        },
      },
    });

    return {
      metadata: {
        format: "HEALTHOS_DPDP_EXPORT_V1",
        governingLaw: "Digital Personal Data Protection Act, 2023 (Section 11)",
        exportedAt: new Date().toISOString(),
        organizationId: patient.organizationId,
      },
      patientProfile: {
        id: (patient as any)._id,
        mrn: patient.mrn,
        name: patient.name,
        phone: patient.phone,
        email: patient.email,
        dob: patient.dob,
        gender: patient.gender,
        bloodGroup: patient.bloodGroup,
        address: patient.address,
        city: patient.city,
        state: patient.state,
        pincode: patient.pincode,
        allergies: patient.allergies,
        conditions: patient.conditions,
        abhaNumber: patient.abhaNumber,
        abhaAddress: patient.abhaAddress,
        dpdpStatus: patient.dpdpStatus || "ACTIVE",
      },
      clinicalRecords: {
        encounters: encounters.map((e: any) => ({
          id: e._id,
          encounterType: e.encounterType,
          status: e.status,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
        })),
        appointments: appointments.map((a: any) => ({
          id: a._id,
          appointmentTime: a.appointmentTime,
          status: a.status,
          type: a.type,
          chiefComplaint: a.chiefComplaint,
        })),
        prescriptions: prescriptions.map((p: any) => ({
          id: p._id,
          medicineName: p.medicineName,
          dosage: p.dosage,
          frequency: p.frequency,
          duration: p.duration,
          instructions: p.instructions,
          status: p.status,
          createdAt: p.createdAt,
        })),
        labOrders: labOrders.map((l: any) => ({
          id: l._id,
          status: l.status,
          tests: l.tests,
          results: l.results,
          createdAt: l.createdAt,
        })),
        invoices: invoices.map((i: any) => ({
          id: i._id,
          invoiceNumber: i.invoiceNumber,
          totalAmount: i.totalAmount,
          paymentStatus: i.paymentStatus,
          createdAt: i.createdAt,
        })),
      },
      consentLedger: consentDoc?.purposes || [],
    };
  }

  /**
   * 2. Right to Erasure with NMC 3-Year Carve-Out (DPDPA 2023 Section 12 & Section 17)
   *
   * Anonymizes PII immediately (names, phone, email, Aadhaar, contacts) while placing
   * clinical encounter notes and lab diagnostic results under a 3-year statutory retention hold
   * per Indian Medical Council (Professional Conduct, Etiquette and Ethics) Regulations 2002.
   */
  static async executePatientErasure(
    patientId: string,
    requestedBy: string,
    reason?: string,
    orgId?: string
  ) {
    const patientFilter: any = { _id: patientId };
    if (orgId) patientFilter.organizationId = orgId;

    const patient = await Patient.findOne(patientFilter);
    if (!patient) {
      throw new Error("Patient not found or unauthorized");
    }

    if (patient.dpdpStatus === "ANONYMIZED") {
      return {
        success: true,
        alreadyAnonymized: true,
        status: "ANONYMIZED",
        legalRetentionHoldUntil: patient.legalRetentionHoldUntil,
        message: "Patient personal identifiers have already been scrubbed under DPDP compliance.",
      };
    }

    // Determine the latest clinical activity timestamp for the 3-year NMC retention hold
    const latestAppointment = await Appointment.findOne({ patientId }).sort({ appointmentTime: -1 });
    const baseDate = latestAppointment?.appointmentTime || patient.updatedAt || new Date();
    const retentionHoldDate = new Date(baseDate);
    retentionHoldDate.setFullYear(retentionHoldDate.getFullYear() + 3); // 3 years per NMC Regulation 1.3

    const anonymizedId = patient._id.toString();
    const syntheticEmail = `anonymized_${anonymizedId}@deleted.local`;
    const redactedPhone = "0000000000";

    // 1. Scrub Patient PII
    patient.name = "[Anonymized Patient]";
    patient.phone = redactedPhone;
    patient.email = syntheticEmail;
    patient.address = "[Redacted under DPDP Section 12]";
    patient.city = "[Redacted]";
    patient.state = "[Redacted]";
    patient.pincode = "000000";
    (patient as any).emergencyContacts = [];
    (patient as any).insurancePolicies = [];
    patient.abdmHealthId = undefined;
    patient.abhaNumber = undefined;
    patient.abhaAddress = undefined;
    patient.abhaStatus = "deactivated";
    patient.personalVaultId = undefined;
    patient.dpdpStatus = "ANONYMIZED";
    patient.anonymizedAt = new Date();
    patient.legalRetentionHoldUntil = retentionHoldDate;
    patient.erasureRequestedAt = new Date();
    patient.erasureReason = reason || "Patient requested erasure under DPDP Section 12";

    await patient.save();

    // 2. Deactivate linked User portal account if exists
    if (patient.userId) {
      await User.updateOne(
        { _id: patient.userId },
        {
          isActive: false,
          name: "[Anonymized User]",
          email: syntheticEmail,
          phone: redactedPhone,
        }
      );
    }

    // 3. Revoke all DPDP and communication consents
    await DPDPConsent.updateOne(
      { patientId: patient._id },
      {
        $set: {
          "purposes.$[].status": "WITHDRAWN",
          "purposes.$[].updatedAt": new Date(),
        },
        $push: {
          history: {
            purpose: "COMMUNICATION_WHATSAPP",
            action: "WITHDRAWN",
            timestamp: new Date(),
            source: "CONSENT_WITHDRAWAL_REQUEST",
          },
        },
      }
    );

    // 4. Record statutory compliance audit
    await AuditLog.create({
      userId: requestedBy,
      organizationId: patient.organizationId,
      action: "DPDP_PII_ANONYMIZED",
      targetId: patient._id,
      targetModel: "Patient",
      category: "COMPLIANCE_DPDP",
      details: {
        reason: patient.erasureReason,
        legalRetentionHoldUntil: retentionHoldDate.toISOString(),
        statutoryJustification: "NMC 2002 Reg 1.3 (3-year clinical record hold) + DPDPA 2023 Sec 17(1)(b)",
      },
    });

    return {
      success: true,
      status: "ANONYMIZED",
      patientId: anonymizedId,
      piiRedacted: true,
      legalRetentionHoldUntil: retentionHoldDate,
      message: "Patient personal data anonymized. Clinical records held under 3-year statutory NMC retention.",
    };
  }

  /**
   * 3. Granular DPDP Purpose-Based Consent Ledger (DPDPA 2023 Section 6)
   */
  static async getPatientConsents(patientId: string, orgId: string) {
    let consent = await DPDPConsent.findOne({ patientId, organizationId: orgId });

    if (!consent) {
      // Initialize with default granted purposes on first query
      consent = await DPDPConsent.create({
        patientId,
        organizationId: orgId,
        purposes: DPDP_PURPOSES.map((purpose) => ({
          purpose,
          status: "GRANTED",
          updatedAt: new Date(),
        })),
        history: [
          {
            purpose: "COMMUNICATION_WHATSAPP",
            action: "GRANTED",
            timestamp: new Date(),
            source: "PATIENT_PORTAL",
          },
        ],
      });
    }

    return consent;
  }

  static async updatePatientConsents(
    patientId: string,
    orgId: string,
    updates: { purpose: DPDPPurpose; status: "GRANTED" | "WITHDRAWN" }[],
    auditContext: { ipAddress?: string; userAgent?: string; source?: string } = {}
  ) {
    let consent = await DPDPConsent.findOne({ patientId, organizationId: orgId });
    if (!consent) {
      consent = new DPDPConsent({
        patientId,
        organizationId: orgId,
        purposes: [],
        history: [],
      });
    }

    for (const update of updates) {
      const existingPurpose = consent.purposes.find((p) => p.purpose === update.purpose);
      if (existingPurpose) {
        existingPurpose.status = update.status;
        existingPurpose.updatedAt = new Date();
      } else {
        consent.purposes.push({
          purpose: update.purpose,
          status: update.status,
          updatedAt: new Date(),
        });
      }

      consent.history.push({
        purpose: update.purpose,
        action: update.status,
        timestamp: new Date(),
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
        source: (auditContext.source as any) || "PATIENT_PORTAL",
      });

      // Synchronize downstream operational flags
      if (update.purpose === "COMMUNICATION_WHATSAPP") {
        await Patient.updateOne(
          { _id: patientId },
          { optOutWhatsApp: update.status === "WITHDRAWN" }
        );
      }
    }

    await consent.save();

    await AuditLog.create({
      userId: patientId,
      organizationId: orgId,
      action: "DPDP_CONSENT_UPDATED",
      targetId: patientId,
      targetModel: "DPDPConsent",
      category: "COMPLIANCE_DPDP",
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
      details: { updates },
    });

    return consent;
  }

  /**
   * 4. Personal Data Breach Governance (DPDPA 2023 Section 8(6))
   */
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
        `[DPDP Security Breach] ${data.severity}: ${data.title}`,
        new Error(`Exposed categories: ${data.dataCategoriesExposed.join(", ")}. Est subjects: ${data.affectedSubjectsCount}`),
        {
          component: "DPDPCompliance",
          incidentId,
          clinicId: data.organizationId,
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
  static async generateDPBIReport(incidentId: string) {
    const incident = await DataBreachIncident.findOne({ incidentId }).populate("organizationId", "name slug email").lean();
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
        name: org?.name || "HealthOS Facility",
        identifier: org?._id || incident.organizationId,
        contactEmail: org?.email || "compliance@ananta.health",
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
        supportContact: "dpo@ananta.health",
      },
    };
  }
}
