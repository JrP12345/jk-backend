import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { GeneticTestRecord } from "../models/GeneticTestRecord.ts";

describe("Clinical Genetics & Molecular Diagnostics Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let recordId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Genomix Institute of Precision Medicine",
        subdomain: `genetics-${Date.now()}`,
        admin_email: `admin_genetics_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Director of Molecular Genetics",
        city: "Bengaluru",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgBody = JSON.parse(orgRes.body);
    orgId = orgBody.data.organization._id || orgBody.data.organization.id;
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Central Genetics & Genomics Lab",
        code: `GEN-${Date.now()}`,
        city: "Bengaluru",
        address: "500 DNA Boulevard",
        phone: "9100066000",
        email: "genetics@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (GeneticTestRecord) {
      await GeneticTestRecord.deleteMany({ clinicId });
    }
  });

  it("should order & register a new genetic sequencing panel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/genetics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        sampleId: `GEN-SMP-${Date.now()}`,
        patientName: "Victoria Sterling",
        patientAge: 38,
        panelType: "hereditary_cancer",
        sequencingPlatform: "Illumina NovaSeq 6000",
        geneVariants: [
          { geneName: "BRCA1", variantHGVSc: "c.5266dupC (p.Gln1756Profs*74)", classification: "pathogenic" },
        ],
        actionableInsights: "High risk of hereditary breast/ovarian cancer. Recommend PARP inhibitor evaluation.",
        geneticCounselingStatus: "counseling_scheduled",
        geneticCounselorName: "Dr. Eleanor Vance, FACMG",
        notes: "Family history of early-onset ovarian carcinoma.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patientName).toBe("Victoria Sterling");
    expect(body.data.geneVariants.length).toBe(1);

    recordId = body.data.id;
  });

  it("should fetch genetic test records with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/genetics?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.records.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.pathogenicCount).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.counselingPending).toBeGreaterThanOrEqual(1);
  });

  it("should update genetic counseling status to completed", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/genetics/${recordId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        geneticCounselingStatus: "completed",
        notes: "Post-test genetic counseling session delivered to patient & spouse.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.geneticCounselingStatus).toBe("completed");
    expect(body.data.reportDate).not.toBeNull();
  });
});
