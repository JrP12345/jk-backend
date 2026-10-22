import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { authorizePrescriptionDispense } from "./PrescriptionDispenseAuthority.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";

export interface RestrictedSupplyContext {
  organizationId?: string | mongoose.Types.ObjectId;
  patientId?: string | mongoose.Types.ObjectId;
  doctorId?: string | mongoose.Types.ObjectId;
  encounterId?: string | mongoose.Types.ObjectId;
  invoiceId?: string | mongoose.Types.ObjectId;
  dispenseId?: string | mongoose.Types.ObjectId;
  dispensedBy?: string | mongoose.Types.ObjectId;
  dispensedAt?: Date;
  prescriptionAllocations?: import("./PharmacyOperationService.ts").PrescriptionAllocation[];
}
const reviewRequired = () => new CommandError(409, "Restricted supply requires reviewed classification, current professionals and complete signed prescription/recipient details");

/** Runs before any stock delta, within the allocator's transaction. Never trusts display strings from its caller. */
export async function prepareRestrictedSupply(medicineId: string, locationId: string, quantity: number, context?: RestrictedSupplyContext) {
  const medicine = await Medicine.findOne({ _id: medicineId, locationId, deletedAt: null }).lean();
  if (!medicine || !["general", "schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(medicine.scheduleType || "")) throw reviewRequired();
  if (["schedule_x", "narcotic"].includes(medicine.scheduleType)) throw new CommandError(409, "Schedule X and narcotic supply is blocked pending a separately validated workflow");
  if (medicine.scheduleType === "general") return null;
  if (!(mongoose as any).transactionAsyncLocalStorage?.getStore()?.session?.inTransaction()) throw reviewRequired();
  if (!context || ![context.organizationId, context.patientId, context.doctorId, context.encounterId, context.invoiceId, context.dispenseId, context.dispensedBy].every(id => mongoose.isValidObjectId(id)) ||
      !context.dispensedAt || !Number.isFinite(context.dispensedAt.getTime())) throw reviewRequired();
  const review = medicine.dispensingReview;
  if (!review || review.scheduleType !== medicine.scheduleType || !review.confirmedAt || !review.confirmedBy || !genuineDetail(review.reviewReference) || !Number.isSafeInteger(medicine.dispensingRevision) || medicine.dispensingRevision! < 1) throw reviewRequired();
  const organizationId = String(context.organizationId), actorId = String(context.dispensedBy), doctorId = String(context.doctorId);
  if (!await Location.exists({ _id: locationId, organizationId, isActive: true })) throw reviewRequired();
  const qualify = async (userId: string, profession: "pharmacist" | "prescriber") => {
    // Write locks serialize revocation/profile changes with a new supply.
    const member = await OrgMember.findOneAndUpdate({ organizationId, userId, role: { $nin: ["patient", "family_member", "guest"] },
      ...(profession === "pharmacist" ? { $or: [{ "locationAccess.mode": "all" }, { "locationAccess.mode": "selected", "locationAccess.locationIds": locationId }] } : {}) }, { $inc: { __v: 1 } });
    const person = await User.findOneAndUpdate({ _id: userId, isActive: true }, { $inc: { __v: 1 } });
    const qualification = await PharmacyProfessionalReview.findOneAndUpdate({ organizationId, locationId, userId, profession, active: true, validUntil: { $gt: new Date() }, confirmedBy: { $exists: true }, confirmedAt: { $exists: true } }, { $inc: { __v: 1 } });
    if (!member || !person || !qualification || !genuineDetail(person.name) || ![qualification.registrationNumber, qualification.council, qualification.address, qualification.reviewReference].every(genuineDetail)) throw reviewRequired();
    return { person, qualification };
  };
  const pharmacist = await qualify(actorId, "pharmacist"), prescriber = await qualify(doctorId, "prescriber");
  const doctor = await Doctor.findOneAndUpdate({ userId: doctorId, organizationId, isActive: true, registrationNumber: prescriber.qualification.registrationNumber }, { $inc: { __v: 1 } });
  const patient = await Patient.findOneAndUpdate({ _id: context.patientId, organizationId, deletedAt: null }, { $inc: { __v: 1 } });
  const patientName = patient?.name || (patient?.userId ? (await User.findById(patient.userId).select("name"))?.name : undefined);
  if (!doctor || !patient || !genuineDetail(patientName) || !genuineDetail(patient.address)) throw reviewRequired();
  const mappings = context.prescriptionAllocations || [];
  const source = await authorizePrescriptionDispense({ organizationId, locationId, actorId }, {
    patientId: String(context.patientId), locationId, doctorId, encounterId: String(context.encounterId),
    items: [{ medicineId, quantity }], prescriptionIds: mappings.map(rx => rx.prescriptionId), prescriptionAllocations: mappings,
  });
  // Focused completion without a signed prescription record cannot establish restricted-drug evidence.
  if (!source.note || String(source.note.signature?.signerId) !== doctorId || source.prescriptions.some(rx =>
    String(rx.medicineId) !== medicineId || rx.doctorRegistrationNumber !== prescriber.qualification.registrationNumber)) throw reviewRequired();
  return { medicine, mappings, common: {
    recordVersion: 1, organizationId, locationId, medicineId, medicineName: medicine.name, genericName: medicine.genericName,
    manufacturer: medicine.manufacturer || undefined, scheduleType: medicine.scheduleType, classificationReviewReference: review.reviewReference,
    patientId: patient._id, patientName, patientAddress: patient.address, patientPhone: patient.phone || undefined,
    doctorId, doctorName: prescriber.person.name, doctorAddress: prescriber.qualification.address,
    doctorRegNumber: prescriber.qualification.registrationNumber, doctorCouncil: prescriber.qualification.council,
    doctorReviewReference: prescriber.qualification.reviewReference, doctorReviewRevision: prescriber.qualification.revision,
    dispensedBy: actorId, dispensedByName: pharmacist.person.name, pharmacistRegNumber: pharmacist.qualification.registrationNumber,
    pharmacistCouncil: pharmacist.qualification.council, pharmacistReviewReference: pharmacist.qualification.reviewReference,
    pharmacistReviewRevision: pharmacist.qualification.revision, encounterId: source.encounterId,
    clinicalNoteId: source.note._id, invoiceId: context.invoiceId, dispenseId: context.dispenseId,
    dispensedAt: context.dispensedAt, signatureMode: "reviewed_electronic_record",
  } };
}

export async function recordRestrictedSupply(prepared: Awaited<ReturnType<typeof prepareRestrictedSupply>>,
  lots: Array<{ batchId?: string; batchNumber: string; expiryDate?: Date; quantity: number }>) {
  if (!prepared) return;
  if (!(mongoose as any).transactionAsyncLocalStorage?.getStore()?.session?.inTransaction()) throw reviewRequired();
  const remaining = prepared.mappings.map(rx => ({ ...rx }));
  for (const lot of lots) {
    if (!genuineDetail(lot.batchNumber) || !lot.expiryDate || !Number.isFinite(new Date(lot.expiryDate).getTime())) throw reviewRequired();
    let quantity = lot.quantity;
    for (const rx of remaining) {
      const supplied = Math.min(quantity, rx.quantity);
      if (!supplied) continue;
      await ScheduleH1Register.create({ ...prepared.common, batchId: lot.batchId, batchKey: lot.batchId || "aggregate", batchNumber: lot.batchNumber,
        expiryDate: lot.expiryDate, quantityDispensed: supplied, prescriptionId: rx.prescriptionId });
      rx.quantity -= supplied; quantity -= supplied;
    }
    if (quantity) throw reviewRequired();
  }
  if (remaining.some(rx => rx.quantity)) throw reviewRequired();
}

/** Legacy rows stay intact and visible; missing facts are never reconstructed. */
export function registerEvidenceStatus(entry: any) {
  const missing = ["patientName", "patientAddress", "doctorName", "doctorAddress", "doctorRegNumber", "dispensedByName", "pharmacistRegNumber", "batchNumber"].filter(field => !genuineDetail(entry[field]));
  if (entry.recordVersion !== 1 || !entry.dispenseId || !entry.invoiceId || !entry.prescriptionId || !entry.clinicalNoteId || !entry.dispensedBy || !entry.doctorId) missing.push("captured_supply_evidence");
  return { ...entry, registerKind: entry.scheduleType === "schedule_h" ? "prescription" : entry.scheduleType, requiresReview: missing.length > 0, missingEvidence: missing };
}
