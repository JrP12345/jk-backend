import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { Prescription } from "../models/Prescription.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { EventTypes } from "../platform/events/types.ts";
import { ClinicalSearchService } from "../services/ClinicalSearchService.ts";

describe("Clinical Search & Longitudinal Analytics Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let encounterId: string;
  let orgId: string;
  let adminUserId: string;

  beforeAll(async () => {
    // 1. Create Org & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Search General Hospital",
        city: "Bengaluru",
        admin_name: "Search Admin",
        admin_email: "search-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    orgId = JSON.parse(orgRes.body).data.organization.id;
    const adminUser = await User.findOne({ email: "search-admin@test.com" });
    adminUserId = adminUser!._id.toString();

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Analytics Wing",
        city: "Bengaluru",
        address: "500 Search Way",
        phone: "9100077000",
        email: "search@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Search Patient Charlie",
        email: "charlie.search@patient.com",
        password: "Password123",
        phone: "9001122334",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId });

    // 4. Create Encounter
    const encRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, patientId, encounterType: "ipd" },
    });
    expect(encRes.statusCode).toBe(201);
    encounterId = JSON.parse(encRes.body).data.id;

    // 5. Seed multi-engine data containing the term "amoxicillin"
    await ClinicalNote.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      doctorId: adminUserId,
      version: 1,
      isLatest: true,
      subjective: { chiefComplaint: "Bacterial bronchitis requiring amoxicillin" },
      objective: { physicalExamination: "Bilateral wheeze" },
      assessment: {
        diagnoses: [{ code: "J20.9", description: "Acute bronchitis, unspecified", codingSystem: "ICD-10", status: "active" }],
        severity: "moderate",
      },
      plan: { treatmentPlan: "Start oral amoxicillin 500mg" },
      status: "signed",
      signature: { signerId: adminUserId, signerName: "Search Admin", signedAt: new Date() },
    });

    await Observation.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      recordedBy: adminUserId,
      code: "SPO2",
      name: "Oxygen Saturation",
      value: "96%",
      unit: "%",
      recordedAt: new Date(),
    });

    await ObservationScore.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      algorithmId: "NEWS2",
      algorithmVersion: "1.0.0",
      totalScore: 2,
      riskCategory: "Low-Medium",
      isComplete: true,
      evaluatedAt: new Date(),
    });

    const rx = await Prescription.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      doctorId: adminUserId,
      medicineName: "Amoxicillin 500mg",
      dosage: "500mg",
      frequency: "1-1-1",
      duration: "7 days",
      instructions: "Take after meals",
      status: "active",
    });

    const labTest = await LabTest.create({
      clinicId,
      name: "Sputum Culture for Amoxicillin sensitivity",
      code: `SPUT-${Date.now()}`,
      department: "Microbiology",
      sampleType: "Sputum",
      price: 600,
      normalRange: "Normal flora",
    });

    await LabOrder.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      testId: labTest._id,
      orderedBy: adminUserId,
      status: "result-uploaded",
      resultedBy: adminUserId,
      resultedAt: new Date(),
      result: {
        value: "Sensitive to Amoxicillin",
        unit: "",
        referenceRange: "Normal flora",
        interpretation: "normal",
        isAbnormal: false,
      },
    });
  });

  // ─── Test 1: Cross-Engine Unified Search & Deterministic Ranking ────────────
  it("should perform unified search for 'amoxicillin' and rank results deterministically", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/search?q=amoxicillin`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).data;
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThanOrEqual(2);

    // Verify stable resourceType properties
    const resourceTypes = body.items.map((i: any) => i.resourceType);
    expect(resourceTypes).toContain("ClinicalNote");
    expect(resourceTypes).toContain("LabOrder");

    // Verify deterministic sorting: score desc, then occurredAt desc, then id asc
    for (let i = 0; i < body.items.length - 1; i++) {
      const curr = body.items[i];
      const next = body.items[i + 1];
      if (curr.score === next.score) {
        expect(new Date(curr.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(next.occurredAt).getTime());
      } else {
        expect(curr.score).toBeGreaterThanOrEqual(next.score);
      }
    }
  });

  // ─── Test 2: Category Filtering ─────────────────────────────────────────────
  it("should filter search results by category parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/search?category=lab`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).data;
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.category).toBe("lab");
      expect(item.resourceType).toBe("LabOrder");
    }
  });

  // ─── Test 3: Encounter Summary Report (Clinical Story) ─────────────────────
  it("should generate encounter summary report with vitals, news2, and lab summary", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/encounters/${encounterId}/summary-report`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const report = JSON.parse(res.body).data;
    expect(report.encounterId).toBe(encounterId);
    expect(report.primaryDiagnosis).toContain("bronchitis");
    expect(report.vitalsTrend.length).toBeGreaterThanOrEqual(1);
    expect(report.news2Trajectory.length).toBeGreaterThanOrEqual(1);
    expect(report.labSummary.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Test 4: Grouped Quality Metrics ────────────────────────────────────────
  it("should fetch organization quality metrics grouped by clinical domains", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/quality-metrics",
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const metrics = JSON.parse(res.body).data;
    expect(metrics.medication).toBeDefined();
    expect(metrics.diagnostics).toBeDefined();
    expect(metrics.diagnostics.totalOrders).toBeGreaterThanOrEqual(1);
    expect(metrics.clinical).toBeDefined();
    expect(metrics.clinical.totalNews2Evaluations).toBeGreaterThanOrEqual(1);
    expect(metrics.discharge).toBeDefined();
  });

  // ─── Test 5: Event-Driven Derived Metric Reactivity ─────────────────────────
  it("should reactively respond to DomainEventBus event emissions", async () => {
    const initialCount = ClinicalSearchService.getEventCount();

    await domainEventBus.publishEvent(EventTypes.MEDICATION_ADMINISTERED, {
      administrationId: "test-adm-1",
      prescriptionId: "test-rx-1",
      encounterId,
      patientId,
      medicineName: "Amoxicillin",
      prescribedDose: "500mg",
      doseGiven: "500mg",
      route: "oral",
      status: "administered",
      recordedBy: adminUserId,
    });

    const updatedCount = ClinicalSearchService.getEventCount();
    expect(updatedCount).toBeGreaterThan(initialCount);
  });
});
