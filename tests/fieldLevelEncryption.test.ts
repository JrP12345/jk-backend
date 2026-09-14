import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { encryptField, decryptField, isEncrypted, computeBlindIndex } from "../utilities/cryptoEnvelope.ts";
import { Patient } from "../models/Patient.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";

describe("Field-Level Envelope Encryption (FLE) Suite — DPDP & HIPAA Compliance", () => {
  const secretText = "Patient has active diagnosis of severe bipolar depression. Under confidential psychiatric therapy.";

  it("encrypts plaintext into authenticated AES-256-GCM envelope", () => {
    const ciphertext = encryptField(secretText);
    expect(ciphertext).toBeDefined();
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(ciphertext).not.toContain("bipolar");

    const decrypted = decryptField(ciphertext);
    expect(decrypted).toBe(secretText);
  });

  it("handles null, undefined, empty, and legacy unencrypted values gracefully", () => {
    expect(encryptField("")).toBe("");
    expect(encryptField(null as any)).toBeNull();
    expect(encryptField(undefined as any)).toBeUndefined();

    const legacyPlaintext = "Legacy unencrypted patient history from 2024";
    expect(decryptField(legacyPlaintext)).toBe(legacyPlaintext);
  });

  it("detects ciphertext tampering and rejects invalid authentication tags", () => {
    const validCiphertext = encryptField(secretText);
    const parts = validCiphertext.split(":");
    // Tamper with the ciphertext hex
    const tamperedHex = parts[4].slice(0, -4) + "ffff";
    const tamperedEnvelope = `enc:v1:${parts[2]}:${parts[3]}:${tamperedHex}`;

    const decrypted = decryptField(tamperedEnvelope);
    expect(decrypted).toBe("[DECRYPTION_FAILED]");
  });

  it("computes deterministic HMAC blind index for queryable matching", () => {
    const aadhaar = "1234-5678-9012";
    const idx1 = computeBlindIndex(aadhaar);
    const idx2 = computeBlindIndex(" 1234-5678-9012 ");
    expect(idx1).toBeDefined();
    expect(idx1.length).toBe(64);
    expect(idx1).toBe(idx2); // Deterministic matching
  });

  describe("Mongoose Model Automatic Encryption-at-Rest Integration", () => {
    let testPatient: any;
    let testNote: any;

    afterAll(async () => {
      if (testPatient?._id) await Patient.collection.deleteOne({ _id: testPatient._id });
      if (testNote?._id) await ClinicalNote.collection.deleteOne({ _id: testNote._id });
    });

    it("stores medicalNotes encrypted at rest in MongoDB and decrypts on retrieval", async () => {
      testPatient = await Patient.create({
        name: "FLE Confidential Patient",
        phone: "9988776655",
        medicalNotes: "Highly confidential oncology treatment plan and HIV prophylaxis.",
      });

      // 1. Raw MongoDB verification: must be encrypted with AES-256-GCM envelope
      const rawInDb: any = await Patient.collection.findOne({ _id: testPatient._id });
      expect(rawInDb).toBeDefined();
      expect(rawInDb.medicalNotes).toBeDefined();
      expect(isEncrypted(rawInDb.medicalNotes)).toBe(true);
      expect(rawInDb.medicalNotes).not.toContain("oncology");
      expect(rawInDb.medicalNotes).not.toContain("HIV");

      // 2. Mongoose document access: must be transparently decrypted
      const retrieved = await Patient.findById(testPatient._id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.medicalNotes).toBe("Highly confidential oncology treatment plan and HIV prophylaxis.");
    });

    it("encrypts clinical note history and treatment plan at rest", async () => {
      testNote = await ClinicalNote.create({
        organizationId: new mongoose.Types.ObjectId(),
        clinicId: new mongoose.Types.ObjectId(),
        encounterId: new mongoose.Types.ObjectId(),
        patientId: testPatient._id,
        doctorId: new mongoose.Types.ObjectId(),
        subjective: {
          chiefComplaint: "Severe anxiety",
          historyOfPresentIllness: "Patient reports chronic panic attacks triggered by stressful work environments.",
        },
        plan: {
          treatmentPlan: "Prescribe Sertraline 50mg OD, refer for Cognitive Behavioral Therapy.",
        },
      });

      // 1. Raw MongoDB check
      const rawNote: any = await ClinicalNote.collection.findOne({ _id: testNote._id });
      expect(isEncrypted(rawNote.subjective.historyOfPresentIllness)).toBe(true);
      expect(isEncrypted(rawNote.plan.treatmentPlan)).toBe(true);
      expect(rawNote.subjective.historyOfPresentIllness).not.toContain("panic attacks");

      // 2. Mongoose query check
      const retrievedNote = await ClinicalNote.findById(testNote._id);
      expect(retrievedNote!.subjective.historyOfPresentIllness).toBe(
        "Patient reports chronic panic attacks triggered by stressful work environments."
      );
      expect(retrievedNote!.plan.treatmentPlan).toBe(
        "Prescribe Sertraline 50mg OD, refer for Cognitive Behavioral Therapy."
      );
    });
  });
});
