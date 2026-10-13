import crypto from "node:crypto";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { TaskModel } from "../models/Task.ts";
import { reviewPrivacyRequest } from "../services/PatientPrivacyService.ts";
import { CONSENT_NOTICE_VERSION } from "../services/PatientConsentService.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Appointment } from "../models/Appointment.ts";
import { Prescription } from "../models/Prescription.ts";
import { Location } from "../models/Location.ts";
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
  let testLocation: any;
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

    // 2. Create Location
    testLocation = await Location.create({
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
      locationId: testLocation._id,
      patientId: testPatient._id,
      doctorId: testStaffUser._id,
      encounterType: "opd",
      status: "completed",
    });

    // 7. Create Clinical Records (Appointment & Prescription)
    await Appointment.create({
      patientId: testPatient._id,
      organizationId: orgId,
      locationId: testLocation._id,
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
      locationId: testLocation._id,
      encounterId: testEncounter._id,
      doctorId: testStaffUser._id,
      medicineName: "Amlodipine 5mg",
      dosage: "1-0-0",
      frequency: "daily",
      duration: "30 days",
      instructions: "Take after food",
    });
  });

  it("exports only the selected organization's records, with correct fields and actual actor audit", async () => {
    const foreign = await Organization.create({ name: "Other clinic", city: "Pune" });
    await Appointment.create({ patientId: testPatient.id, organizationId: foreign.id, locationId: testLocation.id,
      doctorId: testStaffUser.id, appointmentTime: new Date(), appointmentType: "walk-in", tokenNumber: 1, status: "completed", notes: "Foreign secret" });
    const result = await DPDPService.exportPatientData(testPatient.id, orgId.toString(), { actorId: testStaffUser.id, includeClinical: true });
    expect(result.metadata.format).toBe("EKAVYU_DPDP_EXPORT");
    expect(result.clinicalRecords.appointments).toHaveLength(1);
    expect(result.clinicalRecords.prescriptions[0].medicineName).toBe("Amlodipine 5mg");
    expect(result.patientProfile).not.toHaveProperty("allergies");
    expect(JSON.stringify(result)).not.toContain("Foreign secret");
    expect((await AuditLog.findOne({ targetId: testPatient.id, action: "DPDP_DATA_EXPORTED" }))?.userId.toString()).toBe(testStaffUser.id);
    await expect(DPDPService.exportPatientData(testPatient.id, foreign.id, { actorId: testStaffUser.id, includeClinical: true })).resolves.toMatchObject({ metadata: { organizationId: foreign.id } });
    const unrelated = await Organization.create({ name: "Unassociated", city: "Pune" });
    await expect(DPDPService.exportPatientData(testPatient.id, unrelated.id, { actorId: testStaffUser.id, includeClinical: true })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("bounds export pages, respects branch restrictions, and omits clinical resources for administrative exports", async () => {
    await Appointment.insertMany(Array.from({ length: 101 }, () => ({ patientId: testPatient.id, organizationId: orgId, locationId: testLocation.id,
      doctorId: testStaffUser.id, appointmentTime: new Date(), appointmentType: "walk-in", tokenNumber: 1, status: "completed" })));
    const context = { actorId: testStaffUser.id, includeClinical: false };
    const first = await DPDPService.exportPatientData(testPatient.id, orgId.toString(), context);
    expect(first.metadata.truncated).toBe(true);
    expect(first.clinicalRecords.appointments).toHaveLength(100);
    expect(first.clinicalRecords).not.toHaveProperty("prescriptions");
    const second = await DPDPService.exportPatientData(testPatient.id, orgId.toString(), { ...context, cursors: { appointments: first.metadata.nextCursors.appointments! } });
    expect(second.clinicalRecords.appointments).toHaveLength(2);
    const deniedBranch = await DPDPService.exportPatientData(testPatient.id, orgId.toString(), { ...context, locationIds: [new mongoose.Types.ObjectId()] });
    expect(deniedBranch.clinicalRecords.appointments).toHaveLength(0);
  });
  it("records a retryable privacy request without changing global identity, account or clinical retention", async () => {
    const input = { clientRequestId: crypto.randomUUID(), reason: "Please review CRM data erasure" };
    const request = () => DPDPService.executePatientErasure(testPatient.id, testPatientUser.id, orgId.toString(), input);
    const first = await request();
    expect(first.request.status).toBe("requested");
    expect((await request()).revision).toBe(first.revision);
    expect(await TaskModel.countDocuments({ organizationId: orgId, kind: "privacy_review" })).toBe(1);
    const unchanged = await Patient.findById(testPatient.id);
    expect(unchanged?.name).toBe("Rahul Sharma");
    expect(unchanged?.legalRetentionHoldUntil).toBeUndefined();
    expect((await User.findById(testPatientUser.id))?.isActive).toBe(true);
    const otherOrg = await Organization.create({ name: "Another relationship", city: "Pune" });
    await PatientRelationship.create({ organizationId: otherOrg.id, patientId: testPatient.id, contact: { phone: "9876543210" } });
    await CrmActivity.create({ organizationId: orgId, patientId: testPatient.id, kind: "administrative_note", note: "Delete my CRM note" });
    const reviewed = await reviewPrivacyRequest(testPatient.id, testStaffUser.id, orgId.toString(), { expectedRevision: first.revision, clientRequestId: crypto.randomUUID(),
      decision: "fulfilled", reason: "Reviewed eligible CRM data", retentionBasis: "Clinical and billing records retained for separate record-specific review", scopeConfirmed: true });
    expect(reviewed.request.status).toBe("fulfilled");
    expect((await PatientRelationship.findOne({ organizationId: otherOrg.id }))?.contact?.phone).toBe("9876543210");
    expect((await PatientRelationship.findOne({ organizationId: orgId }))?.preferences?.doNotContact).toBe(true);
    expect((await CrmActivity.findOne({ organizationId: orgId, kind: "administrative_note" }).select("+note"))?.note).toBeUndefined();
    expect(await Prescription.countDocuments({ patientId: testPatient.id })).toBe(1);
  });
  it("consent reads are pure, with unknown defaults and legacy grants requiring review", async () => {
    const initial = await DPDPService.getPatientConsents(testPatient.id, orgId.toString());
    expect(initial.purposes).toHaveLength(6);
    expect(initial.purposes.every(row => row.status === "UNKNOWN")).toBe(true);
    expect(await DPDPConsent.countDocuments({ organizationId: orgId })).toBe(0);
    await DPDPConsent.create({ patientId: testPatient.id, organizationId: orgId, purposes: [{ purpose: "COMMUNICATION_WHATSAPP", status: "GRANTED" }] });
    const legacy = await DPDPService.getPatientConsents(testPatient.id, orgId.toString());
    expect(legacy.purposes.find(row => row.purpose === "COMMUNICATION_WHATSAPP")).toMatchObject({ status: "UNKNOWN", reviewRequired: true });
    expect(await CrmActivity.countDocuments({ organizationId: orgId })).toBe(0);
  });
  it("records evidence, revisions and retries without changing other organizations or global opt-out", async () => {
    const command = { actorId: testStaffUser.id, clientRequestId: crypto.randomUUID(), expectedRevision: 0, method: "written_consent" as const,
      noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: true, note: "Patient signed the stated WhatsApp communication choice" };
    const updates = [{ purpose: "COMMUNICATION_WHATSAPP" as const, status: "GRANTED" as const }];
    const grant = () => DPDPService.updatePatientConsents(testPatient.id, orgId.toString(), updates, command);
    const first = await grant();
    expect(first.revision).toBe(1);
    expect((await grant()).revision).toBe(1);
    expect(first.purposes.find(row => row.purpose === "COMMUNICATION_WHATSAPP")?.status).toBe("GRANTED");
    await expect(DPDPService.updatePatientConsents(testPatient.id, orgId.toString(), updates, { ...command, clientRequestId: crypto.randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
    const withdrawn = await DPDPService.updatePatientConsents(testPatient.id, orgId.toString(), [{ purpose: "COMMUNICATION_WHATSAPP", status: "WITHDRAWN" }],
      { ...command, clientRequestId: crypto.randomUUID(), expectedRevision: 1, acknowledged: false });
    expect(withdrawn.purposes.find(row => row.purpose === "COMMUNICATION_WHATSAPP")?.status).toBe("WITHDRAWN");
    expect((await Patient.findById(testPatient.id))?.optOutWhatsApp).toBe(false);
    expect(await CrmActivity.countDocuments({ organizationId: orgId, visibility: "consent" })).toBe(2);
    expect((await AuditLog.findOne({ organizationId: orgId, action: "DPDP_CONSENT_UPDATED" }))?.userId.toString()).toBe(testStaffUser.id);
  });
  it("invalidates evidence when the organization recipient changes and rolls back failures", async () => {
    const command = { actorId: testStaffUser.id, clientRequestId: crypto.randomUUID(), expectedRevision: 0, method: "written_consent" as const,
      noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: true, note: "Signed consent" };
    const updates = [{ purpose: "COMMUNICATION_WHATSAPP" as const, status: "GRANTED" as const }];
    const spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Audit unavailable"));
    try { await expect(DPDPService.updatePatientConsents(testPatient.id, orgId.toString(), updates, command)).rejects.toThrow("Audit unavailable"); }
    finally { spy.mockRestore(); }
    expect(await DPDPConsent.countDocuments({ organizationId: orgId })).toBe(0);
    expect(await CrmActivity.countDocuments({ organizationId: orgId })).toBe(0);
    await DPDPService.updatePatientConsents(testPatient.id, orgId.toString(), updates, command);
    await PatientRelationship.create({ organizationId: orgId, patientId: testPatient.id, contact: { phone: "9999999999" } });
    expect((await DPDPService.getPatientConsents(testPatient.id, orgId.toString())).purposes.find(row => row.purpose === "COMMUNICATION_WHATSAPP")?.status).toBe("UNKNOWN");
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
    const dossier = await DPDPService.generateDPBIReport(incident.incidentId, orgId.toString());
    expect(dossier.header.recipient).toBe("Data Protection Board of India (DPBI)");
    expect(dossier.header.governingSection).toContain("Section 8(6)");
    expect(dossier.incidentDetails.incidentTrackingNumber).toBe(incident.incidentId);
    expect(dossier.incidentDetails.categoriesOfPersonalDataCompromised).toContain("CLINICAL_PHI");
    expect(dossier.incidentDetails.numberOfAffectedDataSubjects).toBe(12);
  });
});
