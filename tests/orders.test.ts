import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";

describe("Orders & Results Management Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let encounterId: string;
  let labTestId: string;
  let adminUserId: string;
  let orgId: string;

  // ─── Setup: Org → Clinic → LabTest → Patient → Encounter ───────────────────
  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Orders Diagnostic Hospital",
        city: "Chennai",
        admin_name: "Orders Admin",
        admin_email: `orders-admin-${Date.now()}@test.com`,
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    const orgData = JSON.parse(orgRes.body).data;
    orgId = orgData.organization.id;
    adminUserId = orgData.user.id || orgData.user._id;

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Path Lab Wing",
        city: "Chennai",
        address: "300 Lab Street",
        phone: "9100099000",
        email: "lab@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Seed LabTest catalog entry directly (bypasses admin-only route restriction)
    const test = await LabTest.create({
      clinicId,
      name: "Complete Blood Count",
      code: `CBC-${Date.now()}`,
      department: "Haematology",
      sampleType: "Venous Blood",
      price: 350,
      normalRange: "WBC: 4.0–11.0 × 10⁹/L",
    });
    labTestId = test._id.toString();

    // 4. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Lab Patient Alice",
        email: "lab.alice@patient.com",
        password: "Password123",
        phone: "9007654321",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId });

    // 5. Create Encounter
    const encRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, patientId, encounterType: "opd" },
    });
    expect(encRes.statusCode).toBe(201);
    encounterId = JSON.parse(encRes.body).data.id;
  });

  // ─── Test 1: Full Happy-Path Workflow ───────────────────────────────────────
  it("should execute full order workflow: place → collect → process → result", async () => {
    // Place order
    const placeRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/orders`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        testId: labTestId,
        clinicId,
        patientId,
        priority: "urgent",
        clinicalReason: "Evaluate suspected anaemia",
      },
    });
    expect(placeRes.statusCode).toBe(201);
    const order = JSON.parse(placeRes.body).data;
    expect(order.status).toBe("ordered");
    expect(order.priority).toBe("urgent");
    expect(order.clinicalReason).toBe("Evaluate suspected anaemia");
    expect(order.encounterId).toBe(encounterId);
    const orderId = order.id;

    // Collect sample → sample-collected
    const collectRes = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/collect`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(collectRes.statusCode).toBe(200);
    const collected = JSON.parse(collectRes.body).data;
    expect(collected.status).toBe("sample-collected");
    expect(collected.sampleCollectedAt).not.toBeNull();

    // Mark processing
    const processRes = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/process`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(processRes.statusCode).toBe(200);
    expect(JSON.parse(processRes.body).data.status).toBe("processing");

    // Record result (normal)
    const resultRes = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        value: "7.2",
        unit: "× 10⁹/L",
        referenceRange: "4.0–11.0 × 10⁹/L",
        interpretation: "normal",
        isAbnormal: false,
        notes: "Within normal limits",
      },
    });
    expect(resultRes.statusCode).toBe(200);
    const resultBody = JSON.parse(resultRes.body).data;
    expect(resultBody.order.status).toBe("result-uploaded");
    expect(resultBody.order.result.value).toBe("7.2");
    expect(resultBody.order.result.unit).toBe("× 10⁹/L");
    expect(resultBody.order.result.interpretation).toBe("normal");
    expect(resultBody.order.result.isAbnormal).toBe(false);
    expect(resultBody.abnormalSignal).toBeNull();

    // Verify accountabilities are set
    const finalOrder = await LabOrder.findById(orderId).lean() as any;
    expect(finalOrder.orderedBy?.toString()).toBe(adminUserId);
    expect(finalOrder.collectedBy?.toString()).toBe(adminUserId);
    expect(finalOrder.resultedBy?.toString()).toBe(adminUserId);
  });

  // ─── Test 2: Abnormal Result Flagging & CDS Signal ─────────────────────────
  it("should flag an abnormal result and return AbnormalResultSignal", async () => {
    // Place and advance a fresh order to processing state
    const placeRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/orders`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { testId: labTestId, clinicId, patientId, priority: "stat", clinicalReason: "Suspected infection" },
    });
    expect(placeRes.statusCode).toBe(201);
    const orderId = JSON.parse(placeRes.body).data.id;

    await app.inject({ method: "PUT", url: `/api/orders/${orderId}/collect`, headers: { cookie: adminCookies.join("; ") } });
    await app.inject({ method: "PUT", url: `/api/orders/${orderId}/process`, headers: { cookie: adminCookies.join("; ") } });

    // Record critical abnormal result
    const resultRes = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        value: "18.5",
        unit: "× 10⁹/L",
        referenceRange: "4.0–11.0 × 10⁹/L",
        interpretation: "critical",
        isAbnormal: true,
        notes: "Critical leukocytosis — notify attending physician immediately",
      },
    });
    expect(resultRes.statusCode).toBe(200);
    const body = JSON.parse(resultRes.body).data;
    expect(body.order.result.isAbnormal).toBe(true);
    expect(body.order.result.interpretation).toBe("critical");
    expect(body.abnormalSignal).not.toBeNull();
    expect(body.abnormalSignal.value).toBe("18.5");
    expect(body.abnormalSignal.interpretation).toBe("critical");
    expect(body.abnormalSignal.patientId).toBe(patientId);
    expect(body.abnormalSignal.encounterId).toBe(encounterId);
    // Message should indicate abnormal
    expect(JSON.parse(resultRes.body).message).toContain("ABNORMAL");
  });

  // ─── Test 3: Cancellation with Mandatory Reason ────────────────────────────
  it("should cancel a sample-collected order and block cancellation of terminal orders", async () => {
    // Place a fresh order
    const placeRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/orders`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { testId: labTestId, clinicId, patientId },
    });
    expect(placeRes.statusCode).toBe(201);
    const orderId = JSON.parse(placeRes.body).data.id;

    // Advance to sample-collected
    await app.inject({ method: "PUT", url: `/api/orders/${orderId}/collect`, headers: { cookie: adminCookies.join("; ") } });

    // Attempt cancellation without reason — should fail
    const noReasonRes = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/cancel`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {},
    });
    expect(noReasonRes.statusCode).toBe(400);

    // Cancel with reason
    const cancelRes = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/cancel`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { cancellationReason: "Patient transferred to another facility before sample processing" },
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelled = JSON.parse(cancelRes.body).data;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellationReason).toContain("transferred");

    // Verify terminal state: cannot cancel again
    const doubleCancel = await app.inject({
      method: "PUT",
      url: `/api/orders/${orderId}/cancel`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { cancellationReason: "Duplicate" },
    });
    expect(doubleCancel.statusCode).toBe(422);
  });

  // ─── Test 4: Encounter-Scoped Order Retrieval ───────────────────────────────
  it("should retrieve all orders for an encounter with structured results", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/encounters/${encounterId}/orders`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
    const orders = JSON.parse(res.body).data;
    expect(Array.isArray(orders)).toBe(true);
    expect(orders.length).toBeGreaterThanOrEqual(3); // from tests 1, 2, 3

    // All orders should be linked to the encounter
    for (const o of orders) {
      expect(o.encounterId?.toString() ?? o.encounterId).toBe(encounterId);
    }

    // Completed orders should have structured result
    const completed = orders.find((o: any) => o.status === "result-uploaded" && !o.result?.isAbnormal);
    expect(completed).toBeDefined();
    expect(completed.result?.value).toBe("7.2");
    expect(completed.result?.unit).toBe("× 10⁹/L");
  });
});
