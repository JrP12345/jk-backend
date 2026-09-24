import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import app from "../index.js";
import { AuditLog } from "../models/AuditLog.ts";
import { Organization } from "../models/Organization.ts";
import { User } from "../models/User.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { GENESIS_HASH, computeAuditHash } from "../utilities/auditCrypto.ts";
import { AUDIT_REDACTED_VALUE } from "../utilities/auditRedaction.ts";
import { recordAuditLog, verifyAuditChainIntegrity } from "../services/AuditTrailService.ts";
import {
  registerClinicQueueWebSocket,
  registerClinicClinicalWebSocket,
  broadcastQueueUpdate,
  broadcastClinicalRealtime,
  handleClinicalWebSocket,
} from "../notifications/websocket.ts";
import { generateAccessToken, createRefreshToken } from "../utilities/helpers.ts";

describe("Cryptographic Audit Trail & WebSocket Channel Segregation Suite", () => {
  let orgId: string;
  let adminUser: any;
  let adminCookie: string;
  let patientUser: any;
  let patientCookie: string;

  beforeAll(async () => {
    const org: any = await (Organization as any).create({
      name: "Integrity Hospital Systems",
      city: "New Delhi",
      email: `integrity-${Date.now()}@test.org`,
      plan: "enterprise",
    });
    orgId = org._id.toString();

    await (ModuleRegistry as any).create({
      organizationId: orgId,
      moduleKey: "audit",
      enabled: true,
      priority: "P2",
      label: "Audit Logs",
    });

    adminUser = await (User as any).create({
      name: "Compliance Officer",
      email: `compliance-${Date.now()}@test.org`,
      password: "Password123!",
      role: "admin",
    });

    const adminToken = generateAccessToken({
      id: adminUser._id.toString(),
      email: adminUser.email,
      role: "admin",
      organization_id: orgId,
    });
    const adminRefresh = await createRefreshToken(adminUser._id.toString(), { organizationId: orgId });
    adminCookie = `access_token=${adminToken}; refresh_token=${adminRefresh}`;

    patientUser = await User.create({
      name: "Public Patient",
      email: `patient-${Date.now()}@test.org`,
      password: "Password123!",
      role: "patient",
    });

    const patientToken = generateAccessToken({
      id: patientUser._id.toString(),
      email: patientUser.email,
      role: "patient",
      organization_id: orgId,
    });
    const patientRefresh = await createRefreshToken(patientUser._id.toString(), { organizationId: orgId });
    patientCookie = `access_token=${patientToken}; refresh_token=${patientRefresh}`;
  });

  it("redacts PHI, credentials, and capabilities before an audit entry is hashed", async () => {
    const testOrgId = new mongoose.Types.ObjectId();
    const log = await recordAuditLog({
      organizationId: testOrgId,
      action: "REDACTION_BOUNDARY_TEST",
      category: "CLINICAL_WRITE",
      details: {
        patientId: "safe-reference",
        status: "completed",
        patientName: "Alice Example",
        phone: "+919876500000",
        diagnosis: "Sensitive clinical finding",
        trackerTokenHash: "secret-capability",
        nested: { email: "alice@example.test", notes: "Clinical free text" },
      },
    });

    expect(log.details.patientId).toBe("safe-reference");
    expect(log.details.status).toBe("completed");
    expect(log.details.patientName).toBe(AUDIT_REDACTED_VALUE);
    expect(log.details.phone).toBe(AUDIT_REDACTED_VALUE);
    expect(log.details.diagnosis).toBe(AUDIT_REDACTED_VALUE);
    expect(log.details.trackerTokenHash).toBe(AUDIT_REDACTED_VALUE);
    expect(log.details.nested.email).toBe(AUDIT_REDACTED_VALUE);
    expect(log.details.nested.notes).toBe(AUDIT_REDACTED_VALUE);

    const verification = await verifyAuditChainIntegrity(testOrgId.toString());
    expect(verification.intact).toBe(true);
  });

  it("redacts legacy audit details and actor PII in the audit API response", async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await AuditLog.collection.insertOne({
      _id: legacyId,
      organizationId: new mongoose.Types.ObjectId(orgId),
      userId: adminUser._id,
      action: "LEGACY_PHI_AUDIT_ENTRY",
      category: "CLINICAL_WRITE",
      details: {
        patientName: "Legacy Patient",
        diagnosis: "Legacy diagnosis",
        status: "completed",
      },
      createdAt: new Date(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const entry = JSON.parse(response.body).data.find((item: any) => item.action === "LEGACY_PHI_AUDIT_ENTRY");
    expect(entry.details.patientName).toBe(AUDIT_REDACTED_VALUE);
    expect(entry.details.diagnosis).toBe(AUDIT_REDACTED_VALUE);
    expect(entry.details.status).toBe("completed");
    expect(entry.userId.email).toBeUndefined();
  });

  // ─── Test 1: Cryptographic Hash Chaining on Audit Creation ─────────────────
  it("should chain audit logs monotonically with SHA-256 prevHash links", async () => {
    const testOrgId = new mongoose.Types.ObjectId();

    const log1 = await recordAuditLog({
      organizationId: testOrgId,
      action: "PATIENT_RECORD_VIEWED",
      category: "CLINICAL_READ",
      details: { patientId: "P001", reason: "OPD Consultation" },
    });

    expect(log1.sequence).toBe(1);
    expect(log1.prevHash).toBe(GENESIS_HASH);
    expect(log1.hash).toBeDefined();
    expect(log1.hash.length).toBe(64);

    const log2 = await recordAuditLog({
      organizationId: testOrgId,
      action: "PRESCRIPTION_ISSUED",
      category: "CLINICAL_WRITE",
      details: { patientId: "P001", drug: "Paracetamol 500mg" },
    });

    expect(log2.sequence).toBe(2);
    expect(log2.prevHash).toBe(log1.hash);
    expect(log2.hash).toBeDefined();
    expect(log2.hash).not.toBe(log1.hash);

    const log3 = await recordAuditLog({
      organizationId: testOrgId,
      action: "CDS_ALLERGY_OVERRIDE",
      category: "CLINICAL_WRITE",
      details: { patientId: "P001", overrideReason: "Urgent clinical indication" },
    });

    expect(log3.sequence).toBe(3);
    expect(log3.prevHash).toBe(log2.hash);

    // Verify chain integrity passes on unmodified chain
    const verification = await verifyAuditChainIntegrity(testOrgId.toString());
    expect(verification.intact).toBe(true);
    expect(verification.verifiedCount).toBe(3);
    if (verification.intact) {
      expect(verification.firstSequence).toBe(1);
      expect(verification.lastSequence).toBe(3);
      expect(verification.lastHash).toBe(log3.hash);
    }
  });

  // ─── Test 2: Tamper Detection on Document Modification ─────────────────────
  it("should detect cryptographic hash mismatch when an audit record is altered in MongoDB", async () => {
    const testOrgId = new mongoose.Types.ObjectId();

    const log1 = await recordAuditLog({
      organizationId: testOrgId,
      action: "ORIGINAL_ACTION_1",
      category: "CLINICAL_WRITE",
      details: { initial: true },
    });

    const log2 = await recordAuditLog({
      organizationId: testOrgId,
      action: "ORIGINAL_ACTION_2",
      category: "CLINICAL_WRITE",
      details: { important: "data" },
    });

    const log3 = await recordAuditLog({
      organizationId: testOrgId,
      action: "ORIGINAL_ACTION_3",
      category: "CLINICAL_WRITE",
      details: { final: true },
    });

    // Verify initially intact
    const initCheck = await verifyAuditChainIntegrity(testOrgId.toString());
    expect(initCheck.intact).toBe(true);

    // Attacker modifies log2 details directly in MongoDB collection (bypassing Mongoose hooks)
    await AuditLog.collection.updateOne(
      { _id: log2._id },
      { $set: { action: "TAMPERED_ACTION", details: { erased: true } } }
    );

    // Chain verification should immediately detect payload modification
    const tamperedCheck = await verifyAuditChainIntegrity(testOrgId.toString());
    expect(tamperedCheck.intact).toBe(false);
    if (!tamperedCheck.intact) {
      expect(tamperedCheck.reason).toBe("HASH_TAMPERED");
      expect(tamperedCheck.failedAtSequence).toBe(2);
      expect(tamperedCheck.logId).toBe(log2._id.toString());
    }
  });

  // ─── Test 3: Deletion & Sequence Gap Detection ─────────────────────────────
  it("should detect a broken audit chain when an intermediate record is deleted", async () => {
    const testOrgId = new mongoose.Types.ObjectId();

    const log1 = await recordAuditLog({
      organizationId: testOrgId,
      action: "ENCOUNTER_START",
      category: "CLINICAL_WRITE",
    });

    const log2 = await recordAuditLog({
      organizationId: testOrgId,
      action: "UNAUTHORIZED_MED_DISPENSE",
      category: "CLINICAL_WRITE",
    });

    const log3 = await recordAuditLog({
      organizationId: testOrgId,
      action: "ENCOUNTER_COMPLETE",
      category: "CLINICAL_WRITE",
    });

    // Attacker deletes incriminating log2 from MongoDB
    await AuditLog.collection.deleteOne({ _id: log2._id });

    // Chain verification must detect the sequence gap
    const gapCheck = await verifyAuditChainIntegrity(testOrgId.toString());
    expect(gapCheck.intact).toBe(false);
    if (!gapCheck.intact) {
      expect(gapCheck.reason).toBe("SEQUENCE_GAP");
      expect(gapCheck.failedAtSequence).toBe(3);
    }
  });

  // ─── Test 4: Verification API Endpoint Access Control ──────────────────────
  it("should expose GET /api/audit-logs/verify-integrity to authorized auditors", async () => {
    // 1. Authorized admin audit check
    const authRes = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify-integrity",
      headers: { cookie: adminCookie },
    });

    expect(authRes.statusCode).toBe(200);
    const body = JSON.parse(authRes.body);
    expect(body.success).toBe(true);
    expect(body.data.intact).toBeDefined();

    // 2. Unauthorized request (no cookie)
    const unauthRes = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify-integrity",
    });
    expect(unauthRes.statusCode).toBe(401);

    // 3. Patient role without audit permission
    const forbiddenRes = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify-integrity",
      headers: { cookie: patientCookie },
    });
    expect(forbiddenRes.statusCode).toBe(403);
  });

  // ─── Test 5: Lobby Queue WebSocket PHI Leakage Prevention ──────────────────
  it("should sanitize diagnostic lab names and panic values before emitting to waiting-room TV displays", () => {
    const testClinicId = "6aa03a085a3bdf2bee3c5e5a";
    const queueReceived: any[] = [];

    const mockLobbySocket: any = {
      readyState: 1,
      send: vi.fn((raw: string) => {
        queueReceived.push(JSON.parse(raw));
      }),
      on: vi.fn(),
    };

    registerClinicQueueWebSocket(testClinicId, mockLobbySocket);

    // Attempt to broadcast panic alert with sensitive medical lab data to public queue
    broadcastQueueUpdate(testClinicId, {
      type: "CLINICAL_PANIC_ALERT",
      data: {
        appointmentId: "6aa03a085a3bdf2bee3c5e99",
        tokenNumber: 42,
        testName: "Troponin-I High Sensitivity",
        resultValue: 4.82,
        panicReason: "ACUTE_MYOCARDIAL_INFARCTION",
      },
      message: "CRITICAL PANIC: Troponin-I = 4.82 ng/mL for Token #42",
      timestamp: new Date().toISOString(),
    });

    expect(mockLobbySocket.send).toHaveBeenCalled();
    const sentToLobby = queueReceived[0];

    // Verify lobby screen does NOT receive medical findings or panic text
    expect(sentToLobby.type).toBe("QUEUE_UPDATED");
    expect(sentToLobby.data.testName).toBeUndefined();
    expect(sentToLobby.data.resultValue).toBeUndefined();
    expect(sentToLobby.data.panicReason).toBeUndefined();
    expect(sentToLobby.message || "").not.toContain("Troponin");
    expect(sentToLobby.message || "").not.toContain("INFARCTION");
    expect(sentToLobby.data.tokenNumber).toBe(42);
  });

  // ─── Test 6: Clinical Staff WebSocket Receives Full Uncensored Panic Alert ──
  it("should deliver full clinical panic alerts only to authenticated clinical staff channels", () => {
    const testClinicId = "6aa03a085a3bdf2bee3c5e5b";
    const clinicalReceived: any[] = [];

    const mockClinicalSocket: any = {
      readyState: 1,
      send: vi.fn((raw: string) => {
        clinicalReceived.push(JSON.parse(raw));
      }),
      on: vi.fn(),
    };

    registerClinicClinicalWebSocket(testClinicId, mockClinicalSocket);

    const panicPayload = {
      type: "CLINICAL_PANIC_ALERT" as const,
      data: {
        appointmentId: "6aa03a085a3bdf2bee3c5e88",
        tokenNumber: 15,
        testName: "Serum Potassium",
        resultValue: 6.9,
        panicReason: "SEVERE_HYPERKALEMIA_ARRHYTHMIA_RISK",
      },
      message: "CRITICAL PANIC: Serum Potassium = 6.9 mEq/L for Token #15",
      timestamp: new Date().toISOString(),
    };

    broadcastClinicalRealtime(testClinicId, panicPayload);

    expect(mockClinicalSocket.send).toHaveBeenCalled();
    const sentToStaff = clinicalReceived[0];

    // Staff channel MUST receive exact clinical panic information
    expect(sentToStaff.type).toBe("CLINICAL_PANIC_ALERT");
    expect(sentToStaff.data.testName).toBe("Serum Potassium");
    expect(sentToStaff.data.resultValue).toBe(6.9);
    expect(sentToStaff.data.panicReason).toBe("SEVERE_HYPERKALEMIA_ARRHYTHMIA_RISK");
    expect(sentToStaff.data.tokenNumber).toBe(15);
  });

  // ─── Test 7: Clinical WebSocket Endpoint Access Enforcement ────────────────
  it("should reject non-staff users from connecting to /api/clinical/ws", async () => {
    const closedSockets: { code: number; reason: string }[] = [];
    const sentErrors: any[] = [];

    const mockSocket: any = {
      send: vi.fn((msg) => sentErrors.push(JSON.parse(msg))),
      close: vi.fn((code, reason) => closedSockets.push({ code, reason })),
      on: vi.fn(),
    };

    // Attempt connection with patient token
    const fakePatientReq: any = {
      headers: { cookie: patientCookie },
      query: { clinicId: "6aa03a085a3bdf2bee3c5e5a" },
    };

    await handleClinicalWebSocket(mockSocket, fakePatientReq);

    expect(mockSocket.close).toHaveBeenCalledWith(4003, "Forbidden");
    expect(sentErrors[0].type).toBe("ERROR");
    expect(sentErrors[0].message).toContain("Clinical staff role required");
  });
});
