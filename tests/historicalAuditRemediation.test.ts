import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.ts";
import { ChainTransitionRecord } from "../models/ChainTransitionRecord.ts";
import { computeAuditHash, GENESIS_HASH } from "../utilities/auditCrypto.ts";
import {
  scanAuditChain,
  exportAuditChain,
  remediateAuditChain,
} from "../scripts/audit-remediation.ts";

describe("Historical Audit Log Remediation & Chain Transition", () => {
  const testOrgId = new mongoose.Types.ObjectId();
  const testUserId = new mongoose.Types.ObjectId();

  beforeEach(async () => {
    await AuditLog.deleteMany({ organizationId: testOrgId });
    await ChainTransitionRecord.deleteMany({ organizationId: testOrgId });
  });

  it("scans legacy unredacted entries and broken hash links", async () => {
    // Insert legacy raw entries directly via collection to bypass pre('validate') hook
    const legacyEntries = [
      {
        organizationId: testOrgId,
        userId: testUserId,
        action: "PATIENT_RECORD_VIEW",
        category: "CLINICAL_READ",
        sequence: 1,
        prevHash: GENESIS_HASH,
        hash: "legacy-hash-1",
        details: {
          patient_name: "John Doe",
          phone: "+919876543210",
          symptoms: "Fever and chills",
        },
        createdAt: new Date("2026-01-01T10:00:00Z"),
      },
      {
        organizationId: testOrgId,
        userId: testUserId,
        action: "PRESCRIPTION_ISSUED",
        category: "CLINICAL_WRITE",
        sequence: 2,
        prevHash: "legacy-hash-1",
        hash: "legacy-hash-2",
        details: {
          patient_name: "John Doe",
          prescriptions: "Amoxicillin 500mg TDS",
        },
        createdAt: new Date("2026-01-01T10:30:00Z"),
      },
    ];

    await AuditLog.collection.insertMany(legacyEntries);

    const scan = await scanAuditChain({ organizationId: testOrgId.toString() });
    expect(scan.totalScanned).toBe(2);
    expect(scan.unredactedCount).toBe(2);
    expect(scan.brokenChainCount).toBe(2); // Since legacy-hash-1 was fake
    expect(scan.legacyChainExportHash).toBeTruthy();
    expect(scan.sampleUnredactedIds.length).toBe(2);
  });

  it("exports legacy chain with aggregate SHA-256 attestation checksum", async () => {
    const legacyEntries = [
      {
        organizationId: testOrgId,
        userId: testUserId,
        action: "APPOINTMENT_CREATE",
        category: "ADMIN",
        sequence: 1,
        prevHash: GENESIS_HASH,
        hash: "some-hash-1",
        details: { appointmentId: "apt-1" },
        createdAt: new Date("2026-01-01T09:00:00Z"),
      },
    ];
    await AuditLog.collection.insertMany(legacyEntries);

    const exportResult = await exportAuditChain({ organizationId: testOrgId.toString() });
    expect(exportResult.count).toBe(1);
    expect(exportResult.legacyChainExportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dryRun reports required remediations without modifying records", async () => {
    const rawDetails = {
      patient_name: "Jane Doe",
      email: "jane@example.com",
    };
    await AuditLog.collection.insertOne({
      organizationId: testOrgId,
      userId: testUserId,
      action: "PATIENT_UPDATE",
      category: "CLINICAL_WRITE",
      sequence: 1,
      prevHash: GENESIS_HASH,
      hash: "old-hash",
      details: rawDetails,
      createdAt: new Date("2026-01-02T10:00:00Z"),
    });

    const dryResult = await remediateAuditChain({
      organizationId: testOrgId.toString(),
      reason: "Test dry run",
      dryRun: true,
    });

    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.entriesRemediated).toBe(1);

    // Assert entry was NOT altered in database
    const entryAfter = await AuditLog.findOne({ organizationId: testOrgId }).lean();
    expect(entryAfter?.details?.patient_name).toBe("Jane Doe");
    expect(entryAfter?.details?.email).toBe("jane@example.com");

    const transitions = await ChainTransitionRecord.find({ organizationId: testOrgId });
    expect(transitions.length).toBe(0);
  });

  it("executes chain remediation, redacts PHI, preserves hash chaining, and creates transition record", async () => {
    const rawEntries = [
      {
        organizationId: testOrgId,
        userId: testUserId,
        action: "PATIENT_CREATE",
        category: "CLINICAL_WRITE",
        sequence: 1,
        prevHash: GENESIS_HASH,
        hash: "corrupted-or-legacy-1",
        details: {
          patient_name: "Alice Smith",
          phone: "9998887776",
          normalField: "keep-me",
        },
        createdAt: new Date("2026-01-03T10:00:00Z"),
      },
      {
        organizationId: testOrgId,
        userId: testUserId,
        action: "PRESCRIPTION_ADD",
        category: "CLINICAL_WRITE",
        sequence: 2,
        prevHash: "corrupted-or-legacy-1",
        hash: "corrupted-or-legacy-2",
        details: {
          prescriptions: "Paracetamol 650mg",
          doctorNote: "Take with food",
        },
        createdAt: new Date("2026-01-03T10:15:00Z"),
      },
    ];

    await AuditLog.collection.insertMany(rawEntries);

    const operatorId = new mongoose.Types.ObjectId();
    const result = await remediateAuditChain({
      organizationId: testOrgId.toString(),
      reason: "VAPT compliance audit remediation",
      operatorId: operatorId.toString(),
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
    expect(result.entriesRemediated).toBe(2);
    expect(result.transitionRecordId).toBeDefined();

    // Verify AuditLog entries are redacted and chained
    const updatedEntries = await AuditLog.find({ organizationId: testOrgId })
      .sort({ sequence: 1 })
      .lean();

    expect(updatedEntries.length).toBe(2);

    // Entry 1 verification
    const e1 = updatedEntries[0];
    expect(e1.details.patient_name).toBe("[REDACTED]");
    expect(e1.details.phone).toBe("[REDACTED]");
    expect(e1.details.normalField).toBe("keep-me");
    expect(e1.prevHash).toBe(GENESIS_HASH);

    const expectedHash1 = computeAuditHash({
      sequence: 1,
      prevHash: GENESIS_HASH,
      organizationId: testOrgId,
      userId: testUserId,
      action: "PATIENT_CREATE",
      category: "CLINICAL_WRITE",
      targetId: undefined,
      targetModel: undefined,
      details: e1.details,
      createdAt: e1.createdAt,
    });
    expect(e1.hash).toBe(expectedHash1);

    // Entry 2 verification
    const e2 = updatedEntries[1];
    expect(e2.details.prescriptions).toBe("[REDACTED]");
    expect(e2.prevHash).toBe(expectedHash1); // Perfectly chained!

    const expectedHash2 = computeAuditHash({
      sequence: 2,
      prevHash: expectedHash1,
      organizationId: testOrgId,
      userId: testUserId,
      action: "PRESCRIPTION_ADD",
      category: "CLINICAL_WRITE",
      targetId: undefined,
      targetModel: undefined,
      details: e2.details,
      createdAt: e2.createdAt,
    });
    expect(e2.hash).toBe(expectedHash2);

    // Verify ChainTransitionRecord
    const record = await ChainTransitionRecord.findById(result.transitionRecordId).lean();
    expect(record).toBeDefined();
    expect(record?.organizationId?.toString()).toBe(testOrgId.toString());
    expect(record?.entriesRemediated).toBe(2);
    expect(record?.remediatedBy?.toString()).toBe(operatorId.toString());
    expect(record?.reason).toBe("VAPT compliance audit remediation");
    expect(record?.legacyChainExportHash).toBe(result.legacyChainExportHash);
  });
});
