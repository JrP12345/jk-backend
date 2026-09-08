import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Appointment } from "../models/Appointment.ts";
import { Prescription } from "../models/Prescription.ts";
import { Clinic } from "../models/Clinic.ts";
import { Encounter } from "../models/Encounter.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { DPDPConsent } from "../models/DPDPConsent.ts";
import { DataBreachIncident } from "../models/DataBreachIncident.ts";
import { DPDPService } from "../services/DPDPService.ts";

describe("DPDP 2023 Compliance & Data Breach Governance Suite", () => {
  let orgId: mongoose.Types.ObjectId;
  let testStaffUser: any;
  let testPatientUser: any;
  let testPatient: any;
  let testClinic: any;
  let testEncounter: any;

  beforeEach(async () => {
    // 1. Create Organization
    const org = await Organization.create({
      name: "Apollo Clinic Bangalore",
      city: "Bangalore",
      email: "compliance@apolloclinic.test",
      phone: "9876543210",
      plan: "enterprise",
    });
    orgId = org._id as mongoose.Types.ObjectId;

    // 2. Create Clinic
    testClinic = await Clinic.create({
      organizationId: orgId,
      name: "Apollo Clinic Indiranagar",
      city: "Bangalore",
    });

    // 3. Create Staff User
    testStaffUser = await User.create({
      name: "Dr. Arvind Rao",
      email: `doctor-${Date.now()}-${Math.random().toString(36).substring(7)}@clinic.test`,
      password: "DummyPassword123!",
      role: "doctor",
    });

    // 4. Create Patient Portal User
    testPatientUser = await User.create({
      name: "Rahul Sharma",
      email: `rahul-${Date.now()}-${Math.random().toString(36).substring(7)}@test.com`,
      phone: "9123456780",
      password: "DummyPassword123!",
      role: "patient",
      isActive: true,
    });

    // 5. Create Patient Record
    testPatient = await Patient.create({
      userId: testPatientUser._id,
      name: "Rahul Sharma",
      phone: "9123456780",
      email: testPatientUser.email,
      organizationId: orgId,
      mrn: `MRN-${Date.now()}`,
      dob: new Date("1992-05-15"),
      gender: "male",
      address: "123 MG Road, Indiranagar",
      city: "Bangalore",
      state: "Karnataka",
      pincode: "560038",
      emergencyContacts: [{ name: "Priya Sharma", relationship: "Spouse", phone: "9876543211" }],
      allergies: ["Penicillin"],
      conditions: ["Hypertension"],
      abhaNumber: "12-3456-7890-1234",
      abhaAddress: "rahul.sharma@abdm",
      optOutWhatsApp: false,
      dpdpStatus: "ACTIVE",
    });

    // 6. Create Clinical Encounter
    testEncounter = await Encounter.create({
      organizationId: orgId,
      clinicId: testClinic._id,
      patientId: testPatient._id,
      doctorId: testStaffUser._id,
      encounterType: "opd",
      status: "completed",
    });

    // 7. Create Clinical Records (Appointment & Prescription)
    await Appointment.create({
      patientId: testPatient._id,
      organizationId: orgId,
      clinicId: testClinic._id,
      doctorId: testStaffUser._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      tokenNumber: 1,
      status: "completed",
      reasonForVisit: "routine_checkup",
      notes: "High blood pressure checkup",
    });

    await Prescription.create({
      patientId: testPatient._id,
      organizationId: orgId,
      clinicId: testClinic._id,
      encounterId: testEncounter._id,
      doctorId: testStaffUser._id,
      medicineName: "Amlodipine 5mg",
      dosage: "1-0-0",
      frequency: "daily",
      duration: "30 days",
      instructions: "Take after food",
    });
  });

  it("1. should export complete patient history in machine-readable JSON (Section 11 Data Portability)", async () => {
    const exportResult = await DPDPService.exportPatientData(testPatient._id.toString(), orgId.toString());

    expect(exportResult).toBeDefined();
    expect(exportResult.metadata.format).toBe("HEALTHOS_DPDP_EXPORT_V1");
    expect(exportResult.patientProfile.name).toBe("Rahul Sharma");
    expect(exportResult.patientProfile.phone).toBe("9123456780");
    expect(exportResult.patientProfile.allergies).toContain("Penicillin");

    // Verify clinical records are bundled
    expect(exportResult.clinicalRecords.appointments.length).toBe(1);
    expect(exportResult.clinicalRecords.prescriptions.length).toBe(1);
    expect(exportResult.clinicalRecords.prescriptions[0].medicineName).toBe("Amlodipine 5mg");

    // Verify audit log
    const audit = await AuditLog.findOne({
      targetId: testPatient._id,
      action: "DPDP_DATA_EXPORTED",
    });
    expect(audit).toBeDefined();
    expect(audit?.category).toBe("COMPLIANCE_DPDP");
  });

  it("2. should anonymize patient PII immediately while maintaining 3-year NMC legal hold (Section 12 & 17)", async () => {
    const erasureResult = await DPDPService.executePatientErasure(
      testPatient._id.toString(),
      testStaffUser._id.toString(),
      "Patient requested erasure under DPDP Section 12",
      orgId.toString()
    );

    expect(erasureResult.success).toBe(true);
    expect(erasureResult.status).toBe("ANONYMIZED");
    expect(erasureResult.piiRedacted).toBe(true);
    expect(erasureResult.legalRetentionHoldUntil).toBeDefined();

    // Verify hold date is approximately 3 years from today
    const holdDate = new Date(erasureResult.legalRetentionHoldUntil as any);
    const todayPlus2Years = new Date();
    todayPlus2Years.setFullYear(todayPlus2Years.getFullYear() + 2);
    expect(holdDate.getTime()).toBeGreaterThan(todayPlus2Years.getTime());

    // Verify Patient document in DB has scrubbed PII
    const scrubbedPatient = await Patient.findById(testPatient._id);
    expect(scrubbedPatient?.name).toBe("[Anonymized Patient]");
    expect(scrubbedPatient?.phone).toBe("0000000000");
    expect(scrubbedPatient?.email).toContain("@deleted.local");
    expect(scrubbedPatient?.address).toBe("[Redacted under DPDP Section 12]");
    expect(scrubbedPatient?.emergencyContacts.length).toBe(0);
    expect(scrubbedPatient?.abhaNumber).toBeUndefined();
    expect(scrubbedPatient?.dpdpStatus).toBe("ANONYMIZED");
    expect(scrubbedPatient?.anonymizedAt).toBeDefined();

    // Verify linked User account was deactivated
    const deactivatedUser = await User.findById(testPatientUser._id);
    expect(deactivatedUser?.isActive).toBe(false);
    expect(deactivatedUser?.phone).toBe("0000000000");

    // Verify audit log was recorded
    const audit = await AuditLog.findOne({
      targetId: testPatient._id,
      action: "DPDP_PII_ANONYMIZED",
    });
    expect(audit).toBeDefined();
    expect(audit?.category).toBe("COMPLIANCE_DPDP");

    // Idempotency: repeating erasure should succeed gracefully
    const repeated = await DPDPService.executePatientErasure(
      testPatient._id.toString(),
      testStaffUser._id.toString(),
      "Repeated",
      orgId.toString()
    );
    expect(repeated.alreadyAnonymized).toBe(true);
  });

  it("3. should manage purpose consents and synchronize WhatsApp opt-out flag (Section 6 & 7)", async () => {
    // Fetch initial consents
    const consents = await DPDPService.getPatientConsents(testPatient._id.toString(), orgId.toString());
    expect(consents.purposes.length).toBe(4);
    const whatsappPurpose = consents.purposes.find((p) => p.purpose === "COMMUNICATION_WHATSAPP");
    expect(whatsappPurpose?.status).toBe("GRANTED");

    // Withdraw WhatsApp communication consent
    await DPDPService.updatePatientConsents(
      testPatient._id.toString(),
      orgId.toString(),
      [{ purpose: "COMMUNICATION_WHATSAPP", status: "WITHDRAWN" }],
      { ipAddress: "127.0.0.1", userAgent: "Vitest-Agent" }
    );

    // Verify Patient.optOutWhatsApp synchronized to true
    const updatedPatient = await Patient.findById(testPatient._id);
    expect(updatedPatient?.optOutWhatsApp).toBe(true);

    // Re-grant WhatsApp consent
    await DPDPService.updatePatientConsents(
      testPatient._id.toString(),
      orgId.toString(),
      [{ purpose: "COMMUNICATION_WHATSAPP", status: "GRANTED" }]
    );

    const reGrantedPatient = await Patient.findById(testPatient._id);
    expect(reGrantedPatient?.optOutWhatsApp).toBe(false);
  });

  it("4. should record breach incident and generate DPBI statutory notification dossier (Section 8(6))", async () => {
    const incident = await DPDPService.recordBreachIncident(
      {
        organizationId: orgId.toString(),
        title: "Misconfigured Lab Export Bucket",
        description: "Public S3 bucket URL permitted unauthenticated download of 12 lab test PDFs",
        severity: "CRITICAL",
        dataCategoriesExposed: ["PII", "CLINICAL_PHI"],
        affectedSubjectsCount: 12,
        affectedPatientIds: [testPatient._id.toString()],
        rootCause: "ACL set to public-read during deployment script run",
        remediationSteps: "Bucket ACL set to private within 14 minutes; signed URLs enforced",
      },
      testStaffUser._id.toString()
    );

    expect(incident.incidentId).toMatch(/^INC-DPDP-\d{4}-\d{4}$/);
    expect(incident.status).toBe("DETECTED");
    expect(incident.severity).toBe("CRITICAL");

    // Verify AuditLog
    const audit = await AuditLog.findOne({
      targetId: incident._id,
      action: "DPDP_BREACH_LOGGED",
    });
    expect(audit).toBeDefined();
    expect(audit?.category).toBe("COMPLIANCE_DPDP");

    // Generate DPBI Statutory Report
    const dossier = await DPDPService.generateDPBIReport(incident.incidentId);
    expect(dossier.header.recipient).toBe("Data Protection Board of India (DPBI)");
    expect(dossier.header.governingSection).toContain("Section 8(6)");
    expect(dossier.incidentDetails.incidentTrackingNumber).toBe(incident.incidentId);
    expect(dossier.incidentDetails.categoriesOfPersonalDataCompromised).toContain("CLINICAL_PHI");
    expect(dossier.incidentDetails.numberOfAffectedDataSubjects).toBe(12);
  });
});
