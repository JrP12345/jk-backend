import crypto from "node:crypto";
import { Prescription } from "../models/Prescription.ts";
import { Doctor } from "../models/Doctor.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Encounter } from "../models/Encounter.ts";
import { withClinicalTransaction } from "../utilities/transaction.ts";
import { prescriptionQuantityInput } from "./PrescriptionQuantityService.ts";
import { CommandError } from "./CommandReceiptService.ts";

export interface PrescriptionVerificationResult {
  intact: boolean;
  reason?: "NOT_SEALED" | "HASH_TAMPERED" | "SIGNATURE_INVALID" | "RECORD_NOT_FOUND";
  prescriptionId: string;
  expectedHash?: string;
  storedHash?: string;
  sealedAt?: Date;
  doctorRegistrationNumber?: string;
}

/**
 * Computes a deterministic SHA-256 payload hash over immutable prescription elements.
 */
export function computePrescriptionHash(data: {
  prescriptionId: string;
  organizationId: string;
  locationId: string;
  patientId: string;
  doctorId: string;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions?: string;
  doctorRegistrationNumber?: string;
  medicineId?: string;
  authorizedQuantity?: number | null;
  authorizedBaseUnit?: string | null;
}): string {
  const payload = [
    String(data.prescriptionId),
    String(data.organizationId),
    String(data.locationId),
    String(data.patientId),
    String(data.doctorId),
    data.medicineName.trim().toLowerCase(),
    data.dosage.trim().toLowerCase(),
    data.frequency.trim().toLowerCase(),
    data.duration.trim().toLowerCase(),
    (data.instructions || "").trim().toLowerCase(),
    (data.doctorRegistrationNumber || "").trim().toUpperCase(),
    data.medicineId ? String(data.medicineId) : "",
    data.authorizedQuantity == null ? "" : String(data.authorizedQuantity),
    data.authorizedBaseUnit || "",
  ].join("|");

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function computePrescriptionSignature(hash: string): string {
  const secret = process.env.PRESCRIPTION_SIGNING_KEY;
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32 || ["healthos-prescription-sealing-key", "ekavyu-development-prescription-key"].includes(secret))) {
    throw new Error("A persistent prescription signing key of at least 32 characters is required in production");
  }
  return crypto.createHmac("sha256", secret || "ekavyu-development-prescription-key").update(hash).digest("hex");
}

export class PrescriptionSealingService {
  /**
   * Cryptographically seals an electronic prescription under NMC RMP 2023 regulations.
   * Attaches the doctor's council registration number, computes a deterministic SHA-256 hash,
   * generates a digital signature, and permanently locks the prescription against alteration.
   */
  static async sealPrescription(
    prescriptionId: string,
    doctorUserId: string,
    options: {
      registrationNumber?: string;
      council?: string;
      diagnosisCode?: string;
      diagnosisDescription?: string;
    } = {}
  ): Promise<any> {
    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      throw new Error(`Prescription ${prescriptionId} not found`);
    }

    if (prescription.isSealed) {
      throw new Error("Prescription is already cryptographically sealed and immutable");
    }

    // Resolve doctor's registration number
    let regNumber = options.registrationNumber || prescription.doctorRegistrationNumber;
    let council = options.council || prescription.doctorCouncil;

    if (!regNumber) {
      const doctor = await Doctor.findOne({ userId: doctorUserId }).lean();
      if (doctor?.registrationNumber) {
        regNumber = doctor.registrationNumber;
      }
    }

    prescription.doctorRegistrationNumber = regNumber || "NMC-REG-PENDING";
    prescription.doctorCouncil = council || "State Medical Council";
    if (options.diagnosisCode) prescription.diagnosisCode = options.diagnosisCode;
    if (options.diagnosisDescription) prescription.diagnosisDescription = options.diagnosisDescription;

    const hash = computePrescriptionHash({
      prescriptionId: prescription._id.toString(),
      organizationId: prescription.organizationId.toString(),
      locationId: prescription.locationId.toString(),
      patientId: prescription.patientId.toString(),
      doctorId: prescription.doctorId.toString(),
      medicineName: prescription.medicineName,
      dosage: prescription.dosage,
      frequency: prescription.frequency,
      duration: prescription.duration,
      instructions: prescription.instructions,
      doctorRegistrationNumber: prescription.doctorRegistrationNumber,
      medicineId: prescription.medicineId ? String(prescription.medicineId) : undefined,
      authorizedQuantity: prescription.authorizedQuantity,
      authorizedBaseUnit: prescription.authorizedBaseUnit,
    });

    const signature = computePrescriptionSignature(hash);

    prescription.prescriptionHash = hash;
    prescription.digitalSignature = signature;
    prescription.isSealed = true;
    prescription.sealedAt = new Date();

    await prescription.save();

    await AuditLog.create({
      userId: doctorUserId,
      organizationId: prescription.organizationId,
      action: "PRESCRIPTION_CRYPTOGRAPHICALLY_SEALED",
      targetId: prescription._id,
      targetModel: "Prescription",
      category: "CLINICAL_WRITE",
      details: {
        prescriptionHash: hash,
        doctorRegistrationNumber: prescription.doctorRegistrationNumber,
        medicineName: prescription.medicineName,
      },
    });

    return prescription;
  }

  /**
   * Verifies the mathematical integrity and digital signature of a sealed prescription.
   * Detects any post-issuance tampering to medicines, dosages, duration, or doctor identity.
   */
  static async verifyPrescriptionIntegrity(
    prescriptionId: string
  ): Promise<PrescriptionVerificationResult> {
    const prescription = await Prescription.findById(prescriptionId, null, {
      bypassTenantFilter: true,
    }).lean();

    if (!prescription) {
      return {
        intact: false,
        reason: "RECORD_NOT_FOUND",
        prescriptionId,
      };
    }

    if (!prescription.isSealed || !prescription.prescriptionHash) {
      return {
        intact: false,
        reason: "NOT_SEALED",
        prescriptionId,
      };
    }

    const computedHash = computePrescriptionHash({
      prescriptionId: prescription._id.toString(),
      organizationId: prescription.organizationId.toString(),
      locationId: prescription.locationId.toString(),
      patientId: prescription.patientId.toString(),
      doctorId: prescription.doctorId.toString(),
      medicineName: prescription.medicineName,
      dosage: prescription.dosage,
      frequency: prescription.frequency,
      duration: prescription.duration,
      instructions: prescription.instructions,
      doctorRegistrationNumber: prescription.doctorRegistrationNumber,
      medicineId: prescription.medicineId ? String(prescription.medicineId) : undefined,
      authorizedQuantity: prescription.authorizedQuantity,
      authorizedBaseUnit: prescription.authorizedBaseUnit,
    });

    if (computedHash !== prescription.prescriptionHash) {
      return {
        intact: false,
        reason: "HASH_TAMPERED",
        prescriptionId,
        expectedHash: computedHash,
        storedHash: prescription.prescriptionHash,
        sealedAt: prescription.sealedAt,
      };
    }

    const expectedSignature = computePrescriptionSignature(computedHash);
    if (expectedSignature !== prescription.digitalSignature) {
      return {
        intact: false,
        reason: "SIGNATURE_INVALID",
        prescriptionId,
        sealedAt: prescription.sealedAt,
      };
    }

    return {
      intact: true,
      prescriptionId,
      storedHash: prescription.prescriptionHash,
      sealedAt: prescription.sealedAt,
      doctorRegistrationNumber: prescription.doctorRegistrationNumber,
    };
  }

  /**
   * Amends a sealed prescription under NMC RMP 2023 regulations.
   * Marks the predecessor as superseded (immutable transition), links the new
   * prescription to the predecessor via supersedesPrescriptionId and amendmentReason,
   * and cryptographically seals the new prescription.
   */
  static async amendPrescription(
    originalPrescriptionId: string,
    doctorUserId: string,
    amendment: {
      medicineName?: string;
      dosage?: string;
      frequency?: string;
      duration?: string;
      instructions?: string;
      amendmentReason: string;
      registrationNumber?: string;
      council?: string;
      diagnosisCode?: string;
      diagnosisDescription?: string;
      authorizedQuantity?: number;
      authorizedBaseUnit?: string;
    }
  ): Promise<any> {
    if (!amendment.amendmentReason || !amendment.amendmentReason.trim()) {
      throw new Error("amendmentReason is required to amend a sealed prescription");
    }

    return withClinicalTransaction(async () => {
    const original = await Prescription.findById(originalPrescriptionId);
    if (!original) {
      throw new Error(`Prescription ${originalPrescriptionId} not found`);
    }

    if (!original.isSealed) {
      throw new Error("Cannot amend an unsealed prescription; only cryptographically sealed prescriptions can be amended");
    }

    if (original.status === "superseded") {
      throw new Error("Prescription has already been superseded by another revision");
    }
    if (String(original.doctorId) !== doctorUserId) throw new CommandError(403, "Only the prescribing doctor can amend this prescription");
    if (!await Encounter.findOneAndUpdate({ _id: original.encounterId, organizationId: original.organizationId, locationId: original.locationId, status: "completed" }, { $inc: { __v: 1 } })) throw new CommandError(409, "Reload the finalized encounter before amending");
    if ((original.suppliedQuantity || 0) > 0 && amendment.authorizedQuantity == null) throw new CommandError(409, "A supplied prescription requires an explicit new quantity for any further supply; prior supplies remain recorded");
    const quantity = prescriptionQuantityInput(amendment);

    // Create the superseding prescription
    const newPrescription = new Prescription({
      ...quantity,
      organizationId: original.organizationId,
      locationId: original.locationId,
      encounterId: original.encounterId,
      patientId: original.patientId,
      doctorId: original.doctorId,
      medicineId: original.medicineId,
      medicineName: amendment.medicineName || original.medicineName,
      genericName: original.genericName,
      dosage: amendment.dosage || original.dosage,
      frequency: amendment.frequency || original.frequency,
      duration: amendment.duration || original.duration,
      instructions: amendment.instructions !== undefined ? amendment.instructions : original.instructions,
      diagnosisCode: amendment.diagnosisCode || original.diagnosisCode,
      diagnosisDescription: amendment.diagnosisDescription || original.diagnosisDescription,
      supersedesPrescriptionId: original._id,
      amendmentReason: amendment.amendmentReason.trim(),
      status: "active",
    });

    await newPrescription.save();

    // Seal the new prescription
    const sealedNew = await this.sealPrescription(
      newPrescription._id.toString(),
      doctorUserId,
      {
        registrationNumber: amendment.registrationNumber || original.doctorRegistrationNumber,
        council: amendment.council || original.doctorCouncil,
        diagnosisCode: newPrescription.diagnosisCode,
        diagnosisDescription: newPrescription.diagnosisDescription,
      }
    );

    // Transition original prescription status to superseded
    const updated = await Prescription.updateOne({ _id: original._id, status: original.status, supersededByPrescriptionId: null, fulfillmentRevision: original.fulfillmentRevision ?? 0 },
      { $set: { status: "superseded", supersededByPrescriptionId: newPrescription._id }, $inc: { fulfillmentRevision: 1 } });
    if (updated.modifiedCount !== 1) throw new CommandError(409, "Prescription changed during amendment; reload the source");

    await AuditLog.create({
      userId: doctorUserId,
      organizationId: original.organizationId,
      action: "PRESCRIPTION_AMENDED_SUPERSEDED",
      targetId: original._id,
      targetModel: "Prescription",
      category: "CLINICAL_WRITE",
      details: {
        originalPrescriptionId: original._id.toString(),
        newPrescriptionId: newPrescription._id.toString(),
        amendmentReason: amendment.amendmentReason,
      },
    });

    return sealedNew;
    });
  }
}
