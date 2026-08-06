import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { AmbulanceDispatch } from "../models/AmbulanceDispatch.ts";

describe("Hospital Fleet & Emergency Ambulance Dispatch Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let dispatchId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Metro Emergency Trauma & Fleet Dispatch Services",
        subdomain: `ambulance-fleet-${Date.now()}`,
        admin_email: `admin_amb_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Director of Emergency EMS & Ambulance Fleet",
        city: "Delhi",
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
        name: "Central ER Triage & Ambulance Command Tower",
        code: `EMS-${Date.now()}`,
        city: "Delhi",
        address: "1 Fleet Dispatch Way",
        phone: "9100066000",
        email: "ems@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (AmbulanceDispatch) {
      await AmbulanceDispatch.deleteMany({ clinicId });
    }
  });

  it("should dispatch Code Red critical Advanced Life Support ambulance unit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ambulance-dispatch",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        vehicleNumber: "AMB-ALS-901",
        vehicleType: "advanced_life_support",
        callPriority: "code_red_critical",
        patientName: "Acute STEMI Cardiac Emergency Patient",
        pickupLocation: "Grand Trunk Expressway, KM 14",
        destinationHospitalUnit: "Cardiac Catheterization Lab & ER Bay 1",
        paramedicLead: "EMT-Paramedic Jason Miller",
        driverName: "Driver Robert Ross",
        fuelPercent: 92,
        notes: "Ventricular fibrillation pre-hospital CPR in progress. Defibrillator ready.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.vehicleNumber).toBe("AMB-ALS-901");
    expect(body.data.callPriority).toBe("code_red_critical");
    expect(body.data.dispatchStatus).toBe("dispatched");

    dispatchId = body.data.id;
  });

  it("should fetch ambulance dispatches with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/ambulance-dispatch?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.dispatches.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.codeRedCritical).toBeGreaterThanOrEqual(1);
  });

  it("should advance telemetry & status to en_route_to_scene and arrived_er", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/ambulance-dispatch/${dispatchId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        dispatchStatus: "arrived_er",
        fuelPercent: 88,
        notes: "Patient handed over to ER Trauma Resuscitation Team.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.dispatchStatus).toBe("arrived_er");
  });
});
