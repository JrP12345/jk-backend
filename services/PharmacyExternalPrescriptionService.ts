import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyExternalPrescription } from "../models/PharmacyExternalPrescription.ts";
import { Medicine } from "../models/Medicine.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { externalPrescriptionInput } from "../schemas/pharmacyExternalPrescriptions.ts";
import { CommandError, commandHash, executeRecordedCommand } from "./CommandReceiptService.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { qualifyPharmacyProfessional } from "./PharmacyPharmacistAuthority.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";

type Scope = { organizationId: string; locationId: string; actorId: string };
type Evidence = ReturnType<typeof externalPrescriptionInput> & { reviewConfirmed: true; pharmacist: { name: string; registrationNumber: string; council: string; reviewReference: string; revision: number }; products: Array<{ medicineId: string; name: string; baseUnit: string }> };
export function externalEvidence(row: { evidenceCiphertext?: string | null }): Evidence {
  try { return JSON.parse(decryptField(row.evidenceCiphertext!)); } catch { throw new CommandError(409, "Prescription evidence cannot be read; do not supply"); }
}
export function externalPrescriptionDocument(row: any) {
  const evidence = externalEvidence(row);
  return { ...evidence, id: String(row._id), revision: row.revision, status: row.status, reviewedAt: row.reviewedAt, reviewedBy: String(row.reviewedBy), validUntil: row.validUntil,
    lines: evidence.lines.map(line => ({ ...line, ...evidence.products.find(product => product.medicineId === line.medicineId),
      supplied: row.supplies.reduce((sum: number, supply: any) => sum + supply.lines.filter((item: any) => String(item.medicineId) === line.medicineId).reduce((quantity: number, item: any) => quantity + item.quantity, 0), 0) })),
    supplies: row.supplies.map((supply: any) => ({ invoiceId: String(supply.invoiceId), invoiceNumber: supply.invoiceNumber, suppliedAt: supply.suppliedAt, suppliedBy: String(supply.suppliedBy), lines: supply.lines.map((line: any) => ({ medicineId: String(line.medicineId), quantity: line.quantity })) })) };
}
export function reviewedExternalMedicine(medicine: any) {
  return Boolean(medicine && ["general", "schedule_h", "schedule_h1"].includes(medicine.scheduleType) && medicine.unitDefinition && medicine.dispensingRevision >= 1 &&
    medicine.dispensingReview?.scheduleType === medicine.scheduleType && medicine.dispensingReview.confirmedBy && medicine.dispensingReview.confirmedAt && genuineDetail(medicine.dispensingReview.reviewReference));
}
export async function readExternalPrescription(scope: Pick<Scope, "organizationId" | "locationId">, id: string) {
  const row = await PharmacyExternalPrescription.findOne({ _id: id, organizationId: scope.organizationId, locationId: scope.locationId }).select("+evidenceCiphertext");
  if (!row) throw new CommandError(404, "External prescription not found at this branch");
  return row;
}
export async function recordExternalPrescription(req: FastifyRequest) {
  const input = externalPrescriptionInput(req.body), scope = await purchaseScope(req, input.locationId), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable prescription review reference is required");
  const command = await executeRecordedCommand(`external-rx:${scope.organizationId}:${scope.locationId}`, key, { actorId: scope.actorId, ...input }, () => withTransaction(async session => {
    let indexes;
    try { indexes = await PharmacyExternalPrescription.collection.listIndexes().toArray(); } catch { throw new CommandError(503, "Prepare current prescription source indexes before recording reviews"); }
    if (!indexes.some(index => index.unique && !index.sparse && !index.partialFilterExpression && index.key.organizationId === 1 && index.key.locationId === 1 && index.key.sourceKey === 1 && Object.keys(index.key).length === 3)) throw new CommandError(503, "Prepare current prescription source indexes before recording reviews");
    const pharmacist = await qualifyPharmacyProfessional(scope.organizationId, scope.locationId, scope.actorId, "pharmacist");
    const products = [];
    for (const line of input.lines) {
      const medicine = await Medicine.findOneAndUpdate({ _id: line.medicineId, locationId: scope.locationId, deletedAt: null, dispensingRevision: line.expectedDispensingRevision, "unitDefinition.version": line.expectedUnitVersion }, { $inc: { __v: 1 } });
      if (!reviewedExternalMedicine(medicine)) throw new CommandError(409, "Medicine classification or units changed, or this medicine needs a separately authorized workflow");
      products.push({ medicineId: line.medicineId, name: medicine!.name, baseUnit: medicine!.unitDefinition!.baseUnit });
    }
    const evidence: Evidence = { ...input, reviewConfirmed: true, products, pharmacist: { name: pharmacist.person.name!, registrationNumber: pharmacist.qualification.registrationNumber, council: pharmacist.qualification.council, reviewReference: pharmacist.qualification.reviewReference, revision: pharmacist.qualification.revision } };
    // This is a stable branch-local source identity, independent of retry key and
    // patient spelling. A repeat needs its own actual prescriber authorization.
    const sourceKey = commandHash({ registration: input.prescriberRegistration.normalize("NFKC").toUpperCase().replace(/\s+/g, ""), council: input.prescriberCouncil.normalize("NFKC").toLowerCase().trim(), reference: input.reference.normalize("NFKC").toLowerCase().trim() });
    const row = await createWithSession(PharmacyExternalPrescription, { organizationId: scope.organizationId, locationId: scope.locationId, sourceKey, evidenceCiphertext: encryptField(JSON.stringify(evidence)), reviewedBy: scope.actorId, reviewedAt: new Date(), validUntil: new Date(`${input.validUntil}T23:59:59.999+05:30`), revision: 0, status: "approved", supplies: [] }, session);
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_EXTERNAL_PRESCRIPTION_REVIEWED", category: "CLINICAL_WRITE", targetModel: "PharmacyExternalPrescription", targetId: row._id, details: { medicineCount: input.lines.length } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    return String(row._id);
  }), { writeConcern: { w: "majority" } });
  return externalPrescriptionDocument(await readExternalPrescription(scope, command.resultId));
}

/** Both quote and commit read the original authority; callers cannot pass evidence strings. */
export async function authorizeExternalSale(req: FastifyRequest, scope: Scope, reference: { id: string; revision: number }, lines: Array<{ medicineId: string; quantity: number; expectedUnitVersion: number }>, commit = false) {
  if (!await pharmacyRequestAllows(req, "externalDispense")) throw new CommandError(403, "Prescribed medicine dispensing permission is required");
  const row = await readExternalPrescription(scope, reference.id), document = externalPrescriptionDocument(row);
  if (row.status !== "approved" || row.revision !== reference.revision || row.validUntil.getTime() < Date.now() || row.supplies.length >= 100) throw new CommandError(409, "Prescription changed, is complete or outside its reviewed supply deadline; reload it");
  for (const line of lines) {
    const allowed = document.lines.find(item => item.medicineId === line.medicineId);
    if (!allowed || allowed.expectedUnitVersion !== line.expectedUnitVersion || line.quantity > allowed.quantity - allowed.supplied) throw new CommandError(409, "Requested supply exceeds this prescription's remaining allowance or its reviewed units");
    const medicine = await Medicine.findOne({ _id: line.medicineId, locationId: scope.locationId, deletedAt: null });
    if (!reviewedExternalMedicine(medicine) || medicine!.dispensingRevision !== allowed.expectedDispensingRevision) throw new CommandError(409, "Reviewed medicine classification changed; do not supply from this record");
  }
  const pharmacist = await qualifyPharmacyProfessional(scope.organizationId, scope.locationId, scope.actorId, "pharmacist");
  if (commit) {
    // Every fill, including a different medicine, serializes on this revision.
    const pinned = await PharmacyExternalPrescription.updateOne({ _id: row._id, organizationId: scope.organizationId, locationId: scope.locationId, revision: reference.revision, status: "approved", validUntil: { $gte: new Date() } }, { $inc: { revision: 1 } });
    if (pinned.modifiedCount !== 1) throw new CommandError(409, "Another supply changed this prescription; reload its remaining quantities");
  }
  return { row, document, pharmacist };
}
export async function completeExternalSupply(authority: Awaited<ReturnType<typeof authorizeExternalSale>>, scope: Scope, invoiceId: mongoose.Types.ObjectId, invoiceNumber: string, dispenseId: mongoose.Types.ObjectId, suppliedAt: Date, lines: Array<{ medicineId: string; quantity: number }>) {
  const completed = authority.document.lines.every(line => line.supplied + (lines.find(item => item.medicineId === line.medicineId)?.quantity || 0) === line.quantity);
  const changed = await PharmacyExternalPrescription.updateOne({ _id: authority.row._id, organizationId: scope.organizationId, locationId: scope.locationId, revision: authority.row.revision + 1, status: "approved" }, { $push: { supplies: { invoiceId, invoiceNumber, dispenseId, suppliedAt, suppliedBy: scope.actorId, lines } }, ...(completed ? { $set: { status: "completed" } } : {}) });
  if (changed.modifiedCount !== 1) throw new CommandError(409, "Prescription supply could not be committed");
}
