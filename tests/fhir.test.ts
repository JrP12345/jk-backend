import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Observation } from "../models/Observation.ts";
import { Prescription } from "../models/Prescription.ts";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { DischargeDocument } from "../models/DischargeDocument.ts";

describe("FHIR R4 Interoperability Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let encounterId: string;
  let orgId: string;
  let adminUserId: string;
  let obsId: string;
  let labOrderId: string;
  let marId: string;
  let dischargeDocId: string;

  beforeAll(async () => {
    // 1. Create Org & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "FHIR Interop Hospital",
        city: "Hyderabad",
        admin_name: "FHIR Admin",
        admin_email: "fhir-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    orgId = JSON.parse(orgRes.body).data.organization.id;
    const adminUser = await User.findOne({ email: "fhir-admin@test.com" });
    adminUserId = adminUser!._id.toString();

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Interop Wing A",
        city: "Hyderabad",
        address: "700 FHIR Blvd",
        phone: "9100066000",
        email: "fhir@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "FHIR Patient David",
        email: "david.fhir@patient.com",
        password: "Password123",
        phone: "9005544332",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId, gender: "male", dob: new Date("1990-05-15") });

    // 4. Create Encounter
    const encRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, patientId, encounterType: "ipd" },
    });
    expect(encRes.statusCode).toBe(201);
    encounterId = JSON.parse(encRes.body).data.id;

    // 5. Seed Observation
    const obs = await Observation.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      recordedBy: adminUserId,
      code: "SPO2",
      name: "Oxygen Saturation",
      value: "98",
      unit: "%",
      recordedAt: new Date(),
    });
    obsId = obs._id.toString();

    // 6. Seed Prescription & MAR
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
      status: "active",
    });

    const mar = await MedicationAdministration.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      prescriptionId: rx._id,
      patientId,
      medicineName: "Amoxicillin 500mg",
      prescribedDose: "500mg",
      doseGiven: "500mg",
      route: "oral",
      scheduledTime: new Date(),
      administeredTime: new Date(),
      administeredBy: adminUserId,
      recordedBy: adminUserId,
      status: "administered",
    });
    marId = mar._id.toString();

    // 7. Seed Lab Order
    const labTest = await LabTest.create({
      clinicId,
      name: "Complete Blood Count (CBC)",
      code: "58410-2",
      department: "Hematology",
      sampleType: "Blood",
      price: 500,
      normalRange: "13.5-17.5 g/dL",
    });

    const order = await LabOrder.create({
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
        value: "15.1",
        unit: "g/dL",
        referenceRange: "13.5-17.5 g/dL",
        interpretation: "normal",
        isAbnormal: false,
      },
    });
    labOrderId = order._id.toString();

    // 8. Seed Discharge Document
    const dc = await DischargeDocument.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      authoredBy: adminUserId,
      status: "finalized",
      finalizedAt: new Date(),
      snapshotHash: "crypto-sha256-hash-val",
      aggregated: {},
      clinicianInput: {
        primaryDiagnosis: "Acute Bronchitis (J20.9)",
        conditionOnDischarge: "Stable",
        dischargeInstructions: "Complete amoxicillin course",
      },
    });
    dischargeDocId = dc._id.toString();
  });

  // ─── Test 1: FHIR R4 Patient Resource Mapping ───────────────────────────────
  it("should export a valid FHIR R4 Patient DTO", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/Patient/${patientId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/fhir+json");
    const patient = JSON.parse(res.body);

    expect(patient.resourceType).toBe("Patient");
    expect(patient.id).toBe(patientId);
    expect(patient.active).toBe(true);
    expect(patient.name[0].family).toBe("David");
    expect(patient.gender).toBe("male");
    expect(patient.birthDate).toBe("1990-05-15");
  });

  // ─── Test 2: FHIR R4 Encounter & Observation with LOINC System ─────────────
  it("should export FHIR R4 Encounter and Observation with standard LOINC coding", async () => {
    // Encounter
    const encRes = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/Encounter/${encounterId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(encRes.statusCode).toBe(200);
    const enc = JSON.parse(encRes.body);
    expect(enc.resourceType).toBe("Encounter");
    expect(enc.id).toBe(encounterId);
    expect(enc.subject.reference).toBe(`Patient/${patientId}`);
    expect(enc.class.code).toBe("IMP");

    // Observation
    const obsRes = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/Observation/${obsId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(obsRes.statusCode).toBe(200);
    const observation = JSON.parse(obsRes.body);
    expect(observation.resourceType).toBe("Observation");
    expect(observation.id).toBe(obsId);
    expect(observation.code.coding[0].system).toBe("http://loinc.org");
    expect(observation.code.coding[0].code).toBe("59408-5"); // LOINC SpO2
    expect(observation.subject.reference).toBe(`Patient/${patientId}`);
    expect(observation.encounter.reference).toBe(`Encounter/${encounterId}`);
  });

  // ─── Test 3: FHIR R4 DiagnosticReport & MedicationAdministration ───────────
  it("should export FHIR DiagnosticReport and MedicationAdministration DTOs", async () => {
    // DiagnosticReport
    const reportRes = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/DiagnosticReport/${labOrderId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(reportRes.statusCode).toBe(200);
    const report = JSON.parse(reportRes.body);
    expect(report.resourceType).toBe("DiagnosticReport");
    expect(report.id).toBe(labOrderId);
    expect(report.status).toBe("final");
    expect(report.subject.reference).toBe(`Patient/${patientId}`);

    // MedicationAdministration
    const marRes = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/MedicationAdministration/${marId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(marRes.statusCode).toBe(200);
    const mar = JSON.parse(marRes.body);
    expect(mar.resourceType).toBe("MedicationAdministration");
    expect(mar.id).toBe(marId);
    expect(mar.status).toBe("completed");
    expect(mar.dosage.route.coding[0].system).toBe("http://snomed.info/sct");
  });

  // ─── Test 4: FHIR Composition & Extension snapshotHash Preservation ──────
  it("should export FHIR Composition and preserve snapshotHash inside extension", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/Composition/${dischargeDocId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const comp = JSON.parse(res.body);
    expect(comp.resourceType).toBe("Composition");
    expect(comp.id).toBe(dischargeDocId);
    expect(comp.status).toBe("final");
    expect(comp.extension).toBeDefined();

    const hashExt = comp.extension.find((e: any) => e.url.includes("snapshot-hash"));
    expect(hashExt).toBeDefined();
    expect(hashExt.valueString).toBe("crypto-sha256-hash-val");
  });

  // ─── Test 5: Full Encounter $export Bundle & Referential Integrity ─────────
  it("should export full FHIR R4 Encounter document bundle with referential graph integrity", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/fhir/R4/Encounter/${encounterId}/$export`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const bundle = JSON.parse(res.body);
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.total).toBeGreaterThanOrEqual(5);

    // Verify all entries in bundle
    const resourceTypesInBundle = bundle.entry.map((e: any) => e.resource.resourceType);
    expect(resourceTypesInBundle).toContain("Patient");
    expect(resourceTypesInBundle).toContain("Encounter");
    expect(resourceTypesInBundle).toContain("Composition");
    expect(resourceTypesInBundle).toContain("Observation");
    expect(resourceTypesInBundle).toContain("DiagnosticReport");
    expect(resourceTypesInBundle).toContain("MedicationAdministration");

    // Verify Referential Integrity Graph: All clinical resources point back to Patient and Encounter
    for (const entry of bundle.entry) {
      const r = entry.resource;
      if (r.resourceType !== "Patient" && r.resourceType !== "Bundle") {
        if (r.subject) {
          expect(r.subject.reference).toBe(`Patient/${patientId}`);
        }
        if (r.encounter) {
          expect(r.encounter.reference).toBe(`Encounter/${encounterId}`);
        } else if (r.context) {
          expect(r.context.reference).toBe(`Encounter/${encounterId}`);
        }
      }
    }
  });
});
