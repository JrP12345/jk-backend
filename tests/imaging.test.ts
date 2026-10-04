import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { ImagingStudy } from "../models/ImagingStudy.ts";

describe("Radiology & PACS Imaging Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let patientCookies: string[] = [];
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  beforeAll(async () => {
    process.env.PACS_BASE_URL = "https://pacs.test/dicom-web";
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Radiology Diagnostics Center",
        city: "Mumbai",
        admin_name: "Radiology Admin",
        admin_email: `rad_admin_${Date.now()}@imaging.internal`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Advanced Imaging & MRI Wing",
        city: "Mumbai",
        address: "700 Diagnostic Boulevard",
        phone: "9900011000",
        email: "pacs@imaging.internal",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Vikram Sethi",
        email: `vikram_${Date.now()}@patient.com`,
        phone: "9876543210",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    patientCookies = patientRes.headers["set-cookie"] as string[];
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient } = await import("../models/Patient.ts");
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
  });

  it("should create a PACS DICOM imaging study request via POST /api/radiology/studies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/radiology/studies",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        modality: "CT",
        studyDescription: "CT High Resolution Chest with Contrast",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.modality).toBe("CT");
    expect(body.data.status).toBe("requested");
    expect(body.data.studyInstanceUid).toBeDefined();
  });

  it("should list imaging studies with modality filters via GET /api/radiology/studies", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/radiology/studies?clinicId=${clinicId}&modality=CT`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].modality).toBe("CT");
  });

  it("should update imaging study status via PUT /api/radiology/studies/:id/status", async () => {
    // Create MRI study
    const createRes = await app.inject({
      method: "POST",
      url: "/api/radiology/studies",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        modality: "MR",
        studyDescription: "MRI Brain 3T T1/T2 Flair",
      },
    });
    const createData = JSON.parse(createRes.body).data;
    const studyId = createData._id || createData.id;

    // Update status to in_progress
    const statusRes = await app.inject({
      method: "PUT",
      url: `/api/radiology/studies/${studyId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { status: "in_progress" },
    });

    expect(statusRes.statusCode).toBe(200);
    const updated = JSON.parse(statusRes.body).data;
    expect(updated.status).toBe("in_progress");
  });

  it("should attach and digitally sign radiology report via PUT /api/radiology/studies/:id/report", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/radiology/studies",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        modality: "DX",
        studyDescription: "Digital Chest X-Ray PA View",
      },
    });
    const reportData = JSON.parse(createRes.body).data;
    const studyId = reportData._id || reportData.id;

    const reportRes = await app.inject({
      method: "PUT",
      url: `/api/radiology/studies/${studyId}/report`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        radiologyReport: "Clinical Impression: Lungs clear bilaterally. No focal pulmonary consolidation, effusion, or pneumothorax. Heart size within normal limits.",
      },
    });

    expect(reportRes.statusCode).toBe(200);
    const reportedStudy = JSON.parse(reportRes.body).data;
    expect(reportedStudy.status).toBe("reported");
    expect(reportedStudy.radiologyReport).toContain("Lungs clear bilaterally");
  });

  it("requires authentication and returns an explicit unconfigured preview without contacting PACS", async () => {
    const study = await ImagingStudy.findOne({ clinicId });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("PACS_DICOMWEB_BASE_URL", "");
    const url = `/api/radiology/studies/${study!._id}/preview`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { cookie: patientCookies.join("; ") } })).statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url, headers: { cookie: adminCookies.join("; ") } });
    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopes previews to the stored study and never fetches its supplied URL", async () => {
    const study = await ImagingStudy.findOne({ clinicId });
    study!.dicomWebUrl = "https://untrusted.example/redirect"; await study!.save();
    vi.stubEnv("PACS_DICOMWEB_BASE_URL", "https://orthanc.test/dicom-web");
    vi.stubEnv("PACS_DICOMWEB_TOKEN", "test-only-token");
    const rows = [{ "0020000E": { Value: ["1.2.3"] }, "00080018": { Value: ["1.2.4"] }, "00280008": { Value: [2] } }];
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(rows), { headers: { "content-type": "application/dicom+json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({ method: "GET", url: `/api/radiology/studies/${study!._id}/preview`, headers: { cookie: adminCookies.join("; ") } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(JSON.parse(res.body).data.instances[0]).toMatchObject({ seriesUid: "1.2.3", instanceUid: "1.2.4", frames: 2 });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`https://orthanc.test/dicom-web/studies/${study!.studyInstanceUid}/instances`), expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer test-only-token" }) }));
  });

  it("denies an administrator from another organization before contacting PACS", async () => {
    const other = await app.inject({ method: "POST", url: "/api/onboarding/organization", payload: { org_name: "Other Imaging", city: "Mumbai", admin_name: "Other Admin", admin_email: "other-preview@example.test", admin_password: "Password123", plan: "enterprise" } });
    expect(other.statusCode).toBe(201);
    const study = await ImagingStudy.findOne({ clinicId });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({ method: "GET", url: `/api/radiology/studies/${study!._id}/preview`, headers: { cookie: (other.headers["set-cookie"] as string[]).join("; ") } });
    expect([403, 404]).toContain(res.statusCode);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves only frames in the authorized study with private no-store headers", async () => {
    const study = await ImagingStudy.findOne({ clinicId });
    vi.stubEnv("PACS_DICOMWEB_BASE_URL", "https://orthanc.test/dicom-web");
    const rows = [{ "0020000E": { Value: ["1.2.3"] }, "00080018": { Value: ["1.2.4"] }, "00280008": { Value: [2] } }];
    const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
    const fetchMock = vi.fn().mockImplementationOnce(async () => new Response(JSON.stringify(rows))).mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const url = `/api/radiology/studies/${study!._id}/preview?seriesUid=1.2.3&instanceUid=1.2.4&frame=2`;
    const res = await app.inject({ method: "GET", url, headers: { cookie: adminCookies.join("; ") } });
    expect(res.statusCode).toBe(200); expect(res.headers["content-type"]).toContain("image/png");
    expect(res.rawPayload).toEqual(png); expect(res.headers["cache-control"]).toContain("no-store");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(rows)));
    const missing = await app.inject({ method: "GET", url: url.replace("instanceUid=1.2.4", "instanceUid=1.2.99"), headers: { cookie: adminCookies.join("; ") } });
    expect(missing.statusCode).toBe(404);
  });
});
