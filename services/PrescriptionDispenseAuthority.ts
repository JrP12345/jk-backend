import mongoose from "mongoose";
import { Prescription } from "../models/Prescription.ts";
import { Encounter } from "../models/Encounter.ts";
import { Appointment } from "../models/Appointment.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PrescriptionSealingService } from "./PrescriptionSealingService.ts";
import { CommandError } from "./CommandReceiptService.ts";
import type { PharmacyDispenseAuthority, PharmacyDispenseInput } from "./PharmacyOperationService.ts";
import { prescriptionSupplySnapshot } from "./PrescriptionQuantityService.ts";
import { Medicine } from "../models/Medicine.ts";
import { requirePharmacyDispenseIndexes } from "./PharmacyDispenseIndexes.ts";

const stale = () => new CommandError(409, "The selected prescriptions require review. Reload the finalized visit before dispensing.");

/** Called inside the receipt transaction, before inventory or financial writes. */
export async function authorizePrescriptionDispense(authority: PharmacyDispenseAuthority, input: PharmacyDispenseInput) {
  const ids = input.prescriptionIds || [];
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !mongoose.isValidObjectId(id))) throw stale();
  const scope = { organizationId: authority.organizationId, locationId: authority.locationId, patientId: input.patientId, deletedAt: null };
  const prescriptions = await Prescription.find({ ...scope, _id: { $in: ids }, status: "active", isSealed: true, supersededByPrescriptionId: null });
  if (prescriptions.length !== ids.length) throw stale();
  const encounterId = String(prescriptions[0].encounterId);
  const doctorId = String(prescriptions[0].doctorId);
  if ((input.encounterId && input.encounterId !== encounterId) || (input.doctorId && input.doctorId !== doctorId) ||
      prescriptions.some(rx => String(rx.encounterId) !== encounterId || String(rx.doctorId) !== doctorId)) throw stale();
  // Also serializes encounter charge generation and concurrent supplies with different keys.
  const encounter = await Encounter.findOneAndUpdate({ ...scope, _id: encounterId, doctorId, status: "completed" },
    { $inc: { __v: 1 } }, { returnDocument: "after" });
  if (!encounter) throw stale();
  const appointmentId = encounter.appointmentId ? String(encounter.appointmentId) : undefined;
  if (input.appointmentId && input.appointmentId !== appointmentId) throw stale();
  if (appointmentId && !await Appointment.findOneAndUpdate({ ...scope, _id: appointmentId, doctorId, status: "completed" },
    { $inc: { __v: 1 } }, { returnDocument: "after" })) throw stale();
  const note = await ClinicalNote.findOneAndUpdate({ ...scope, encounterId, doctorId, isLatest: true,
    status: { $in: ["signed", "amended"] }, "plan.prescriptionIds": { $all: ids } },
    { $inc: { __v: 1 } }, { returnDocument: "after" });
  const latestNotes = await ClinicalNote.countDocuments({ ...scope, encounterId, isLatest: true });
  if (latestNotes > 1) throw stale();
  let focusedCompletion: any = null;
  if (!note) {
    if (!appointmentId || latestNotes) throw stale();
    focusedCompletion = await AuditLog.findOne({ organizationId: authority.organizationId, targetId: appointmentId,
      action: "CONSULTATION_COMPLETED_WITHOUT_CLINICAL_NOTE", "details.encounterId": String(encounter._id) });
    if (!focusedCompletion) throw stale();
  } else if (!note.signature?.signedAt) throw stale();
  for (const rx of prescriptions) {
    if (!(await PrescriptionSealingService.verifyPrescriptionIntegrity(String(rx._id))).intact) throw stale();
  }

  // Older callers can use only an unambiguous one-to-one catalogue mapping (or a single explicit selection).
  const mappings = input.prescriptionAllocations || prescriptions.map(rx => {
    const item = input.items.length === 1 && prescriptions.length === 1 ? input.items[0]
      : input.items.find(item => String(rx.medicineId) === item.medicineId);
    if (!item) throw new CommandError(409, "Explicit prescription-to-stock allocations are required for this selection");
    return { prescriptionId: String(rx._id), medicineId: item.medicineId, quantity: item.quantity };
  });
  if (mappings.length !== ids.length || new Set(mappings.map(item => item.prescriptionId)).size !== ids.length ||
      mappings.some(item => !ids.includes(item.prescriptionId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !input.items.some(stock => stock.medicineId === item.medicineId))) throw stale();
  for (const item of input.items) {
    const total = mappings.filter(rx => rx.medicineId === item.medicineId).reduce((sum, rx) => sum + rx.quantity, 0);
    if (!Number.isSafeInteger(total) || total !== item.quantity) throw new CommandError(409, "Prescription allocations must exactly cover the supplied stock quantities");
  }
  const quantitySnapshots = prescriptions.map(rx => prescriptionSupplySnapshot(rx, mappings.find(mapping => mapping.prescriptionId === String(rx._id))!));
  const bounded = quantitySnapshots.filter(snapshot => snapshot.mode === "quantity");
  if (bounded.length) {
    await requirePharmacyDispenseIndexes();
    const stocks = await Medicine.find({ _id: { $in: mappings.map(mapping => mapping.medicineId) }, locationId: authority.locationId, deletedAt: null }).select("unitDefinition").lean();
    for (const snapshot of bounded) {
      const mapping = mappings.find(item => item.prescriptionId === snapshot.prescriptionId)!;
      const medicine = stocks.find(item => String(item._id) === mapping.medicineId);
      if (!medicine?.unitDefinition || medicine.unitDefinition.baseUnit !== snapshot.baseUnit) throw new CommandError(409, "Selected stock units differ from the actual authorized prescription quantity");
    }
  }
  return { encounterId, appointmentId, doctorId, note, focusedCompletion, prescriptions, mappings, quantitySnapshots };
}

export async function fulfillAuthorizedPrescriptions(source: Awaited<ReturnType<typeof authorizePrescriptionDispense>>, dispenseId: mongoose.Types.ObjectId) {
  for (const rx of source.prescriptions) {
    const revision = rx.fulfillmentRevision ?? 0, snapshot = source.quantitySnapshots.find(item => item.prescriptionId === String(rx._id))!, mapping = source.mappings.find(item => item.prescriptionId === String(rx._id))!;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw stale();
    const changed = await Prescription.updateOne({ _id: rx._id, organizationId: rx.organizationId, locationId: rx.locationId,
      patientId: rx.patientId, encounterId: rx.encounterId, doctorId: rx.doctorId, status: "active", isSealed: true,
      supersededByPrescriptionId: null, deletedAt: null,
      ...(snapshot.mode === "single" ? { pharmacyDispenseId: null } : {}),
      ...(snapshot.suppliedQuantity === 0 ? { $and: [{ $or: [{ suppliedQuantity: 0 }, { suppliedQuantity: { $exists: false } }] }] } : { suppliedQuantity: snapshot.suppliedQuantity }),
      ...(revision === 0 ? { $or: [{ fulfillmentRevision: 0 }, { fulfillmentRevision: { $exists: false } }] } : { fulfillmentRevision: revision }) },
    { $set: { status: snapshot.completed ? "dispensed" : "active", pharmacyDispenseId: dispenseId, fulfillmentMedicineId: mapping.medicineId }, $inc: { fulfillmentRevision: 1, suppliedQuantity: mapping.quantity } });
    if (changed.modifiedCount !== 1) throw stale();
  }
}
