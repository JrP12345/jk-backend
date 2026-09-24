import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { Doctor } from "../models/Doctor.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { runWithContext } from "../utilities/context.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";

describe("Automated ORM Tenant Isolation & Prescription Sealing Suite", () => {
  let orgAId: string;
  let orgBId: string;
  let doctorUser: any;
  let doctorDoc: any;
  let patientA: any;
  let patientB: any;

  beforeAll(async () => {
    // 1. Create two separate tenant organizations
    const orgA: any = await Organization.create({
      name: "Apollo Multispecialty",
      city: "Bengaluru",
      email: `apollo-${Date.now()}@test.org`,
      plan: "enterprise",
    });
    orgAId = orgA._id.toString();

    const orgB: any = await Organization.create({
      name: "Fortis Healthcare",
      city: "Mumbai",
      email: `fortis-${Date.now()}@test.org`,
      plan: "enterprise",
    });
    orgBId = orgB._id.toString();

    // 2. Create Doctor with official NMC registration number
    doctorUser = await User.create({
      name: "Dr. Vikram Seth",
      email: `vikram-${Date.now()}@test.org`,
      password: "Password123!",
      role: "doctor",
      organizationId: orgAId,
    } as any);

    doctorDoc = await Doctor.create({
      userId: doctorUser._id,
      organizationId: orgAId,
      specialization: "General Physician",
      registrationNumber: "KMC-2018-99482",
    });

    // 3. Create Patient in Org A and Patient in Org B
    patientA = await Patient.create({
      name: "Ramesh Sharma",
      phone: "9876543210",
      organizationId: new mongoose.Types.ObjectId(orgAId),
    });

    patientB = await Patient.create({
      name: "Priya Patel",
      phone: "9876543211",
      organizationId: new mongoose.Types.ObjectId(orgBId),
    });
  });

  afterAll(async () => {
    await Patient.deleteMany({ _id: { $in: [patientA._id, patientB._id] } });
    await Organization.deleteMany({ _id: { $in: [orgAId, orgBId] } });
    await Doctor.deleteMany({ _id: doctorDoc._id });
    await User.deleteMany({ _id: doctorUser._id });
  });

  // ─── Suite 1: Automated ORM Tenant Scoping ─────────────────────────────────
  describe("ORM Row-Level Tenant Isolation", () => {
    it("automatically restricts Patient.find to caller's active organizationId", async () => {
      await runWithContext({ organizationId: orgAId }, async () => {
        const patients = await Patient.find({});
        const patientIds = patients.map((p) => p._id.toString());
        expect(patientIds).toContain(patientA._id.toString());
        expect(patientIds).not.toContain(patientB._id.toString());
      });

      await runWithContext({ organizationId: orgBId }, async () => {
        const patients = await Patient.find({});
        const patientIds = patients.map((p) => p._id.toString());
        expect(patientIds).toContain(patientB._id.toString());
        expect(patientIds).not.toContain(patientA._id.toString());
      });
    });

    it("blocks explicit cross-tenant query injection", async () => {
      await runWithContext({ organizationId: orgAId }, async () => {
        // Attempting to query Patient B from within Org A's context
        const crossTenant = await Patient.findOne({ _id: patientB._id, organizationId: orgBId });
        expect(crossTenant).toBeNull();
      });
    });

    it("allows root super-admin to view all tenants without automatic filtering", async () => {
      await runWithContext({ isRoot: true }, async () => {
        const patients = await Patient.find({ _id: { $in: [patientA._id, patientB._id] } });
        expect(patients.length).toBe(2);
      });
    });

    it("allows explicit bypassTenantFilter option for system background operations", async () => {
      await runWithContext({ organizationId: orgAId }, async () => {
        const patients = await Patient.find(
          { _id: { $in: [patientA._id, patientB._id] } },
          null,
          { bypassTenantFilter: true }
        );
        expect(patients.length).toBe(2);
      });
    });
  });

  // ─── Suite 2: Prescription Cryptographic Sealing & NMC Immutability ────────
  describe("Prescription Sealing & Medico-Legal Protection", () => {
    let testPrescription: any;

    beforeAll(async () => {
      testPrescription = await Prescription.create({
        organizationId: new mongoose.Types.ObjectId(orgAId),
        clinicId: new mongoose.Types.ObjectId(),
        encounterId: new mongoose.Types.ObjectId(),
        patientId: patientA._id,
        doctorId: doctorUser._id,
        medicineName: "Amoxicillin",
        dosage: "500mg",
        frequency: "1-0-1",
        duration: "5 days",
        instructions: "Take after meals",
      });
    });

    afterAll(async () => {
      if (testPrescription?._id) {
        await Prescription.collection.deleteOne({ _id: testPrescription._id });
      }
    });

    it("cryptographically seals a prescription with doctor's registration number and digital signature", async () => {
      const sealed = await PrescriptionSealingService.sealPrescription(
        testPrescription._id.toString(),
        doctorUser._id.toString()
      );

      expect(sealed.isSealed).toBe(true);
      expect(sealed.doctorRegistrationNumber).toBe("KMC-2018-99482");
      expect(sealed.prescriptionHash).toBeDefined();
      expect(sealed.prescriptionHash.length).toBe(64);
      expect(sealed.digitalSignature).toBeDefined();

      // Verify mathematical integrity
      const verification = await PrescriptionSealingService.verifyPrescriptionIntegrity(
        testPrescription._id.toString()
      );
      expect(verification.intact).toBe(true);
      expect(verification.doctorRegistrationNumber).toBe("KMC-2018-99482");
    });

    it("enforces immutability: rejects attempts to modify clinical details on a sealed prescription", async () => {
      const prescriptionDoc = await Prescription.findById(testPrescription._id, null, {
        bypassTenantFilter: true,
      });
      expect(prescriptionDoc?.isSealed).toBe(true);

      // Attempt to tamper with medicine dosage
      prescriptionDoc!.dosage = "1000mg";

      await expect(prescriptionDoc!.save()).rejects.toThrow(
        /cryptographically sealed and immutable under NMC regulations/
      );
    });

    it("prevents query-update bypass: rejects Mongoose updateOne on sealed prescription", async () => {
      // Create and seal a dedicated test prescription
      const sealedRx = await Prescription.create({
        organizationId: new mongoose.Types.ObjectId(orgAId),
        clinicId: new mongoose.Types.ObjectId(),
        encounterId: new mongoose.Types.ObjectId(),
        patientId: patientA._id,
        doctorId: doctorUser._id,
        medicineName: "Metformin",
        dosage: "500mg",
        frequency: "0-0-1",
        duration: "30 days",
      });

      await PrescriptionSealingService.sealPrescription(sealedRx._id.toString(), doctorUser._id.toString());

      // Attempt to bypass immutability via Mongoose updateOne
      await expect(
        Prescription.updateOne({ _id: sealedRx._id }, { dosage: "1000mg" })
      ).rejects.toThrow(/Cannot modify clinical details via query update/);

      // Clean up
      await Prescription.collection.deleteOne({ _id: sealedRx._id });
    });

    it("allows regulated amendment and marks predecessor as superseded", async () => {
      const originalRx = await Prescription.create({
        organizationId: new mongoose.Types.ObjectId(orgAId),
        clinicId: new mongoose.Types.ObjectId(),
        encounterId: new mongoose.Types.ObjectId(),
        patientId: patientA._id,
        doctorId: doctorUser._id,
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "1-1-1",
        duration: "3 days",
      });

      await PrescriptionSealingService.sealPrescription(originalRx._id.toString(), doctorUser._id.toString());

      // Amend the prescription with clinically justified amendmentReason
      const amendedRx = await PrescriptionSealingService.amendPrescription(
        originalRx._id.toString(),
        doctorUser._id.toString(),
        {
          dosage: "650mg",
          amendmentReason: "Persistent fever above 102F requiring higher dose",
        }
      );

      expect(amendedRx.isSealed).toBe(true);
      expect(amendedRx.dosage).toBe("650mg");
      expect(amendedRx.supersedesPrescriptionId.toString()).toBe(originalRx._id.toString());
      expect(amendedRx.amendmentReason).toContain("Persistent fever");

      // Verify the predecessor is superseded
      const updatedOriginal: any = await Prescription.findById(originalRx._id, null, {
        bypassTenantFilter: true,
      });
      expect(updatedOriginal.status).toBe("superseded");
      expect(updatedOriginal.supersededByPrescriptionId.toString()).toBe(amendedRx._id.toString());

      // Clean up
      await Prescription.collection.deleteMany({ _id: { $in: [originalRx._id, amendedRx._id] } });
    });

    it("detects tampering if database is altered directly via out-of-band write", async () => {
      // Malicious attacker or direct database modification
      await Prescription.collection.updateOne(
        { _id: testPrescription._id },
        { $set: { medicineName: "Fentanyl" } }
      );

      const verification = await PrescriptionSealingService.verifyPrescriptionIntegrity(
        testPrescription._id.toString()
      );

      expect(verification.intact).toBe(false);
      expect(verification.reason).toBe("HASH_TAMPERED");
    });
  });
});
