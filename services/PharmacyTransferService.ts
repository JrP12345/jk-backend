import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyTransfer, PharmacyTransferEvent } from "../models/PharmacyTransfer.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { transferInput, type TransferAction } from "../schemas/pharmacyTransfers.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { validateCapturedLot } from "../utilities/pharmacyLot.ts";
import { validatePharmacyProfile } from "../utilities/pharmacyTax.ts";
import { normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";
import { pinActivePharmacyLocation, pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { appendStockMovement } from "./PharmacyStockMovementService.ts";

const fail = (message = "Transfer changed or its approved product/lot evidence needs review") => new CommandError(409, message);
const identifier = (value: unknown) => { if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) throw new CommandError(400, "An explicit branch and transfer identity are required"); return value.toLowerCase(); };
const normalized = (value: unknown) => String(value || "").normalize("NFKC").trim().toLowerCase();
function productFacts(medicine: any) {
  if (!medicine.unitDefinition) throw fail("Transfer requires reviewed explicit product units");
  const unit = normalizeUnitDefinition(medicine.unitDefinition, medicine.unitDefinition.version);
  return { name: normalized(medicine.name), genericName: normalized(medicine.genericName), manufacturer: normalized(medicine.manufacturer), strength: normalized(medicine.strength),
    category: medicine.category, scheduleType: medicine.scheduleType, hsnCode: medicine.hsnCode, gstRate: medicine.gstRate,
    unit: { version: unit.version, baseUnit: unit.baseUnit, packUnit: unit.packUnit, unitsPerPack: unit.unitsPerPack } };
}
function lotFacts(lot: any) {
  return { batchNumber: lot.batchNumber, expiryDate: new Date(lot.expiryDate).toISOString(),
    expiry: { precision: lot.expirySnapshot.precision, value: lot.expirySnapshot.value, timezone: lot.expirySnapshot.timezone, cutoff: new Date(lot.expirySnapshot.cutoff).toISOString() },
    costBasis: { totalPaise: lot.costBasis.totalPaise, receivedBaseUnits: lot.costBasis.receivedBaseUnits, currency: lot.costBasis.currency },
    sellingPricePaise: lot.sellingPricePaise, mrpPaise: lot.mrpPaise ?? null, hsnCode: lot.hsnCode, gstRate: lot.gstRate };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
async function requireRestrictedTransferReview(medicine: any, organizationId: string, locationId: string, actorId: string) {
  if (medicine.scheduleType === "general") return;
  if (!["schedule_h", "schedule_h1"].includes(medicine.scheduleType) || !Number.isSafeInteger(medicine.dispensingRevision) || medicine.dispensingRevision < 1 || medicine.dispensingReview?.scheduleType !== medicine.scheduleType ||
      !genuineDetail(medicine.dispensingReview?.reviewReference) || !medicine.dispensingReview?.confirmedAt || !medicine.dispensingReview?.confirmedBy) throw fail("Restricted transfer requires current reviewed product classification");
  const member = await OrgMember.findOneAndUpdate({ organizationId, userId: actorId, role: { $nin: ["patient", "family_member", "guest"] },
    $or: [{ "locationAccess.mode": "all" }, { "locationAccess.mode": "selected", "locationAccess.locationIds": locationId }] }, { $inc: { __v: 1 } });
  const person = await User.findOneAndUpdate({ _id: actorId, isActive: true }, { $inc: { __v: 1 } });
  const professional = await PharmacyProfessionalReview.findOneAndUpdate({ organizationId, locationId, userId: actorId, profession: "pharmacist", active: true, validUntil: { $gt: new Date() } }, { $inc: { __v: 1 } });
  if (!member || !person || !professional || !professional.confirmedBy || !professional.confirmedAt || !Number.isSafeInteger(professional.revision) || professional.revision < 1 ||
      ![professional.registrationNumber, professional.council, professional.address, professional.reviewReference].every(genuineDetail)) throw fail("Current branch pharmacist evidence is required for restricted transfer approval, dispatch or saleable receipt");
}
function remaining(transfer: any) { return transfer.dispatchedQuantity - transfer.receivedQuantity - transfer.quarantinedQuantity - transfer.lostQuantity - transfer.returnedQuantity; }
function dto(transfer: any) {
  return { id: String(transfer._id), organizationId: String(transfer.organizationId), sourceLocationId: String(transfer.sourceLocationId), destinationLocationId: String(transfer.destinationLocationId),
    sourceMedicineId: String(transfer.sourceMedicineId), destinationMedicineId: String(transfer.destinationMedicineId), sourceBatchId: String(transfer.sourceBatchId),
    sourceName: transfer.sourceSnapshot.medicine.name, destinationName: transfer.destinationSnapshot.medicine.name, unit: transfer.sourceSnapshot.medicine.unit,
    lot: transfer.sourceSnapshot.lot, quantity: transfer.quantity, status: transfer.status, revision: transfer.revision, dispatchedQuantity: transfer.dispatchedQuantity,
    receivedQuantity: transfer.receivedQuantity, quarantinedQuantity: transfer.quarantinedQuantity, lostQuantity: transfer.lostQuantity, returnedQuantity: transfer.returnedQuantity,
    inTransitQuantity: remaining(transfer), transportReference: transfer.transportReference, reviewReference: transfer.reviewReference, createdAt: transfer.createdAt, dispatchedAt: transfer.dispatchedAt || null };
}
async function authority(req: FastifyRequest, locationId: unknown) {
  if (!await pharmacyRequestAllows(req, "transferStock") || !await pharmacyRequestAllows(req, "viewCost")) throw new CommandError(403, "Transfer and acquisition-cost grants are required");
  return purchaseScope(req, locationId);
}
async function scoped(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await authority(req, locationId);
  const transfer = await PharmacyTransfer.findOne({ _id: identifier(id), organizationId: scope.organizationId, $or: [{ sourceLocationId: scope.locationId }, { destinationLocationId: scope.locationId }] });
  if (!transfer) throw new CommandError(404, "Transfer not found at this branch");
  return { scope, transfer };
}
async function bothBranches(req: FastifyRequest, transfer: any, organizationId: string) {
  for (const locationId of [transfer.sourceLocationId, transfer.destinationLocationId].map(String).sort()) {
    if ((await authority(req, locationId)).organizationId !== organizationId) throw new CommandError(404, "Transfer branches must belong to the same organization");
  }
}
async function inventory(medicine: any, organizationId: string, session: mongoose.ClientSession) {
  stockRevisionFilter(medicine.stockRevision ?? 0);
  const lots = await MedicineBatch.find({ medicineId: medicine._id }).limit(5001).session(session);
  if (lots.length > 5000 || !Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0 || lots.some(lot => lot.lotVersion !== 1 || String(lot.locationId) !== String(medicine.locationId))) throw fail("Transfer inventory requires complete owned lot provenance");
  for (const lot of lots) validateCapturedLot(lot, medicine.unitDefinition, organizationId);
  if (lots.reduce((sum, lot) => sum + BigInt(lot.quantity), 0n) !== BigInt(medicine.stockQuantity)) throw fail("Transfer aggregate and batch quantities do not reconcile");
}
async function policy(organizationId: string, sourceLocationId: string, destinationLocationId: string) {
  if (!await Organization.findOneAndUpdate({ _id: organizationId, isActive: true, countryCode: "IN", currency: "INR" }, { $inc: { __v: 1 } })) throw fail("New transfers require an active India/INR organization; existing custody facts remain recorded");
  const profiles = [];
  for (const locationId of [sourceLocationId, destinationLocationId]) {
    const profile = await PharmacyTaxProfile.findOne({ organizationId, locationId });
    if (!profile) throw fail("Both branches require actual reviewed issuer/licence profiles");
    validatePharmacyProfile(profile, false);
    if (profile.electronicReportingRequired) throw fail("Electronic transfer reporting is unsupported; review the actual requirement before transfer");
    profiles.push({ registration: profile.registration, gstin: profile.gstin || "", stateCode: profile.stateCode, legalName: normalized(profile.legalName), revision: profile.revision,
      drugLicenceNumbers: [...profile.drugLicenceNumbers], reviewReference: profile.reviewReference });
  }
  const [source, destination] = profiles;
  if (source.registration !== destination.registration || source.stateCode !== destination.stateCode || source.gstin !== destination.gstin || source.legalName !== destination.legalName) throw fail("Only reviewed branches of the same legal issuer/state/GST registration are supported; distinct-GSTIN or interstate transfer needs its own tax-document workflow");
  return { policy: "same-issuer-manual-transport-v1", source, destination };
}
async function checkedFacts(transfer: any, session: mongoose.ClientSession, dispatch = false) {
  const source = await Medicine.findOne({ _id: transfer.sourceMedicineId, locationId: transfer.sourceLocationId, ...(dispatch ? { deletedAt: null } : {}) }).session(session);
  const destination = await Medicine.findOne({ _id: transfer.destinationMedicineId, locationId: transfer.destinationLocationId, ...(dispatch ? { deletedAt: null } : {}) }).session(session);
  const lot = await MedicineBatch.findOne({ _id: transfer.sourceBatchId, medicineId: transfer.sourceMedicineId, locationId: transfer.sourceLocationId }).session(session);
  if (!source || !destination || !lot || lot.lotVersion !== 1) throw fail();
  validateCapturedLot(lot, source.unitDefinition, String(transfer.organizationId));
  if (!same(productFacts(source), transfer.sourceSnapshot.medicine) || !same(productFacts(destination), transfer.destinationSnapshot.medicine) || !same(lotFacts(lot), transfer.sourceSnapshot.lot)) throw fail();
  if (dispatch && (lot.status !== "active" || lot.quantity < transfer.quantity || lot.expiryDate <= new Date())) throw fail("The approved source lot is unavailable or expired");
  return { source, destination, lot };
}
async function pinBusiness(transfer: any, session: mongoose.ClientSession) {
  for (const locationId of [transfer.sourceLocationId, transfer.destinationLocationId].map(String).sort()) await pinActivePharmacyLocation(locationId, session);
}
const commandScope = (organizationId: string, locationId: string, action: TransferAction, transferId?: string) => `pharmacy-transfer:${organizationId}:${locationId}:${action}:${transferId || "new"}`;
function key(req: FastifyRequest) {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new CommandError(428, "Keep a stable Idempotency-Key for each transfer stage"); return value;
}
export async function recoverPharmacyTransfer(req: FastifyRequest, locationId: string, action: TransferAction, requestKey: string, transferId?: string) {
  const scope = await authority(req, locationId);
  const receipt = await OperationReceipt.findOne({ scope: commandScope(scope.organizationId, scope.locationId, action, transferId), key: requestKey }).select("+responseCiphertext");
  if (!receipt?.resultId) throw new CommandError(404, "Transfer outcome is not confirmed. Keep this stage reference; do not repeat with a new key");
  let result: any; try { result = JSON.parse(decryptField(receipt.responseCiphertext!)); } catch { throw fail("Transfer result requires review; retain the stage reference"); }
  if (result.version !== 1 || result.actorId !== scope.actorId || String(result.eventId) !== String(receipt.resultId) || result.data.organizationId !== scope.organizationId ||
      ![result.data.sourceLocationId, result.data.destinationLocationId].includes(scope.locationId) || transferId && result.data.id !== transferId) throw new CommandError(404, "Transfer result is not visible to this operator and branch");
  return result.data;
}
export async function commandPharmacyTransfer(req: FastifyRequest, action: TransferAction, transferId?: string) {
  const input = transferInput(req.body, action), requestKey = key(req), scope = await authority(req, input.locationId);
  if (transferId) identifier(transferId);
  const operationScope = commandScope(scope.organizationId, scope.locationId, action, transferId);
  if (!await OperationReceipt.exists({ scope: operationScope, key: requestKey })) {
    try {
      const indexes = await MedicineBatch.collection.listIndexes().toArray(), eventIndexes = await PharmacyTransferEvent.collection.listIndexes().toArray();
      if (!indexes.some(row => row.unique && same(row.key, { organizationId: 1, locationId: 1, receiptLineId: 1 }) && row.partialFilterExpression?.lotVersion === 1) ||
          indexes.some(row => row.unique && same(row.key, { medicineId: 1, locationId: 1, batchNumber: 1 })) ||
          !eventIndexes.some(row => row.unique && same(row.key, { transferId: 1, revision: 1 }))) throw fail();
    } catch { throw new CommandError(503, "Prepare current transfer event and receipt identity indexes before a new transfer stage"); }
  }
  const command = await executeRecordedCommand(operationScope, requestKey, { actorId: scope.actorId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    await authority(req, scope.locationId);
    let transfer: any, batchId: mongoose.Types.ObjectId | undefined;
    const eventId = new mongoose.Types.ObjectId();
    if (action === "create") {
      await bothBranches(req, { sourceLocationId: scope.locationId, destinationLocationId: input.destinationLocationId! }, scope.organizationId);
      const source = await Medicine.findOne({ _id: input.sourceMedicineId, locationId: scope.locationId, deletedAt: null }).session(session);
      const destination = await Medicine.findOne({ _id: input.destinationMedicineId, locationId: input.destinationLocationId, deletedAt: null }).session(session);
      const lot = await MedicineBatch.findOne({ _id: input.sourceBatchId, medicineId: input.sourceMedicineId, locationId: scope.locationId }).session(session);
      if (!source || !destination || !lot || lot.lotVersion !== 1 || lot.status !== "active" || lot.quantity < input.quantity! || lot.expiryDate <= new Date()) throw fail("Select an actual available, unexpired source lot and an owned destination product");
      const sourceProduct = productFacts(source), destinationProduct = productFacts(destination);
      if (!same(sourceProduct, destinationProduct)) throw fail("Explicit source/destination identity, formulation, schedule, tax and units must match; fuzzy substitution is not supported");
      if (["schedule_x", "narcotic"].includes(source.scheduleType)) throw fail("This category is not supported by the transfer workflow");
      await inventory(source, scope.organizationId, session); await inventory(destination, scope.organizationId, session);
      const issuerSnapshot = await policy(scope.organizationId, scope.locationId, input.destinationLocationId!);
      transfer = await createWithSession(PharmacyTransfer, { organizationId: scope.organizationId, sourceLocationId: scope.locationId, destinationLocationId: input.destinationLocationId,
        sourceMedicineId: source._id, destinationMedicineId: destination._id, sourceBatchId: lot._id, quantity: input.quantity, createdBy: scope.actorId,
        sourceSnapshot: { medicine: sourceProduct, lot: lotFacts(lot) }, destinationSnapshot: { medicine: destinationProduct }, issuerSnapshot, transportReference: input.transportReference, reviewReference: input.reviewReference }, session);
      await pinBusiness(transfer, session);
    } else {
      transfer = (await scoped(req, transferId!, scope.locationId)).transfer;
      if (transfer.revision !== input.expectedRevision) throw fail("Transfer revision changed; reload the physical transfer before another stage");
      const sourceBranch = String(transfer.sourceLocationId), destinationBranch = String(transfer.destinationLocationId), updates: Record<string, unknown> = {};
      if (["approve", "dispatch", "cancel"].includes(action) && scope.locationId !== sourceBranch || action === "receive" && scope.locationId !== destinationBranch) throw new CommandError(403, "Use the branch responsible for this physical stage");
      if (action === "approve") {
        if (transfer.status !== "draft") throw fail(); await bothBranches(req, transfer, scope.organizationId);
        const facts = await checkedFacts(transfer, session, true);
        await requireRestrictedTransferReview(facts.source, scope.organizationId, sourceBranch, scope.actorId);
        await requireRestrictedTransferReview(facts.destination, scope.organizationId, destinationBranch, scope.actorId);
        if (!same(await policy(scope.organizationId, sourceBranch, destinationBranch), transfer.issuerSnapshot)) throw fail("Branch issuer review changed before approval");
        Object.assign(updates, { status: "approved", approvedBy: scope.actorId, approvedAt: new Date() }); await pinBusiness(transfer, session);
      } else if (action === "dispatch") {
        if (transfer.status !== "approved") throw fail(); const { source, lot } = await checkedFacts(transfer, session, true);
        await requireRestrictedTransferReview(source, scope.organizationId, sourceBranch, scope.actorId);
        if (!same(await policy(scope.organizationId, sourceBranch, destinationBranch), transfer.issuerSnapshot)) throw fail("Branch issuer review changed before dispatch");
        await inventory(source, scope.organizationId, session);
        const changed = await MedicineBatch.updateOne({ _id: lot._id, quantity: lot.quantity, status: "active" }, { $inc: { quantity: -transfer.quantity }, $set: { status: lot.quantity === transfer.quantity ? "depleted" : "active" } }, { session });
        if (changed.modifiedCount !== 1) throw fail();
        const after = source.stockQuantity - transfer.quantity;
        if (after < 0 || !await Medicine.findOneAndUpdate({ _id: source._id, stockQuantity: source.stockQuantity, ...stockRevisionFilter(source.stockRevision ?? 0) }, { $inc: { stockQuantity: -transfer.quantity, stockRevision: 1 }, $set: { stockLedgerStartedAt: source.stockLedgerStartedAt || new Date() } }, { session })) throw fail();
        await appendStockMovement(source, "transfer_out", after, [{ batchId: lot._id, beforeQuantity: lot.quantity, afterQuantity: lot.quantity - transfer.quantity, quantityDelta: -transfer.quantity }], session,
          { actorId: scope.actorId, clientRequestId: requestKey, notes: input.reviewReference, transferSource: { transferId: transfer.id, eventId: String(eventId) } });
        Object.assign(updates, { status: "in_transit", dispatchedQuantity: transfer.quantity, dispatchedAt: new Date() }); await pinBusiness(transfer, session);
      } else if (action === "cancel") {
        if (!["draft", "approved"].includes(transfer.status)) throw fail("Dispatched stock must be received, returned or resolved; it cannot be cancelled"); updates.status = "cancelled";
      } else {
        if (transfer.status !== "in_transit" || input.quantity! > remaining(transfer)) throw fail("Stage quantity exceeds the actual in-transit balance");
        if (action === "resolve" && input.disposition === "lost") await bothBranches(req, transfer, scope.organizationId);
        if (action === "resolve" && input.disposition === "return_to_source" && scope.locationId !== sourceBranch) throw new CommandError(403, "Only source branch receiving authority can record stock returned to source");
        if (action === "receive" || input.disposition === "return_to_source") {
          const { source, destination, lot } = await checkedFacts(transfer, session), medicine = action === "receive" ? destination : source;
          if (medicine.deletedAt) throw fail("Restore the actual receiving product before recording stock at this branch");
          if (action === "receive" && input.disposition === "saleable") {
            await requireRestrictedTransferReview(destination, scope.organizationId, destinationBranch, scope.actorId);
            if (lot.expiryDate <= new Date()) throw fail("Expired in-transit stock must be received into quarantine, never saleable stock");
            if (!same(await policy(scope.organizationId, sourceBranch, destinationBranch), transfer.issuerSnapshot)) throw fail("Branch issuer review changed; use quarantine and obtain a reviewed disposition");
          }
          await inventory(medicine, scope.organizationId, session);
          const after = medicine.stockQuantity + input.quantity!; if (!Number.isSafeInteger(after)) throw fail();
          batchId = new mongoose.Types.ObjectId(); const quarantined = action !== "receive" || input.disposition === "quarantined";
          await createWithSession(MedicineBatch, { _id: batchId, organizationId: scope.organizationId, locationId: medicine.locationId, medicineId: medicine._id,
            lotVersion: 1, receiptKind: "transfer", receiptLineId: crypto.randomUUID(), receivedAt: new Date(), receivedQuantity: input.quantity, quantity: input.quantity,
            transferSource: { transferId: transfer._id, eventId, originalBatchId: lot._id }, unitSnapshot: { ...productFacts(medicine).unit }, costBasis: { ...lotFacts(lot).costBasis },
            expirySnapshot: { ...lotFacts(lot).expiry, cutoff: lot.expiryDate }, expiryDate: lot.expiryDate, batchNumber: lot.batchNumber, sellingPricePaise: lot.sellingPricePaise, sellingPrice: lot.sellingPrice,
            mrpPaise: lot.mrpPaise, mrp: lot.mrp, purchaseCost: lot.purchaseCost, hsnCode: lot.hsnCode, gstRate: lot.gstRate, status: quarantined ? "quarantined" : "active" }, session);
          if (!await Medicine.findOneAndUpdate({ _id: medicine._id, stockQuantity: medicine.stockQuantity, ...stockRevisionFilter(medicine.stockRevision ?? 0) }, { $inc: { stockQuantity: input.quantity, stockRevision: 1 }, $set: { stockLedgerStartedAt: medicine.stockLedgerStartedAt || new Date() } }, { session })) throw fail();
          await appendStockMovement(medicine, action === "receive" ? "transfer_in" : "transfer_return", after, [{ batchId, beforeQuantity: 0, afterQuantity: input.quantity!, quantityDelta: input.quantity! }], session,
            { actorId: scope.actorId, clientRequestId: requestKey, notes: input.reviewReference, transferSource: { transferId: transfer.id, eventId: String(eventId) } });
          await pinPharmacyContinuityLocation(String(medicine.locationId), session);
        }
        const field = action === "receive" ? input.disposition === "saleable" ? "receivedQuantity" : "quarantinedQuantity" : input.disposition === "lost" ? "lostQuantity" : "returnedQuantity";
        updates[field] = transfer[field] + input.quantity!; if (remaining(transfer) === input.quantity) updates.status = "closed";
      }
      updates.revision = transfer.revision + 1;
      await new PharmacyTransfer({ ...transfer.toObject(), ...updates }).validate();
      transfer = await PharmacyTransfer.findOneAndUpdate({ _id: transfer._id, organizationId: scope.organizationId, revision: input.expectedRevision, status: transfer.status }, { $set: updates }, { session, returnDocument: "after", runValidators: true });
      if (!transfer) throw fail();
    }
    await createWithSession(PharmacyTransferEvent, { _id: eventId, organizationId: scope.organizationId, locationId: scope.locationId, transferId: transfer._id, actorId: scope.actorId,
      revision: transfer.revision, action, quantity: action === "dispatch" ? transfer.quantity : input.quantity || 0, disposition: input.disposition, reviewReference: input.reviewReference, operationKey: requestKey, batchId }, session);
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: `PHARMACY_TRANSFER_${action.toUpperCase()}`, targetModel: "PharmacyTransfer", targetId: transfer._id,
      details: { eventId, revision: transfer.revision, quantity: input.quantity, disposition: input.disposition, transportReference: transfer.transportReference, reviewReference: input.reviewReference } }, session);
    const data = { ...dto(transfer), eventId: String(eventId), requestKey, ...(batchId ? { receivedBatchId: String(batchId) } : {}) };
    const saved = await OperationReceipt.updateOne({ scope: operationScope, key: requestKey }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, eventId: String(eventId), data }) } }).session(session);
    if (saved.matchedCount !== 1) throw fail(); return String(eventId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPharmacyTransfer(req, scope.locationId, action, requestKey, transferId), replayed: command.replayed };
}
export async function readPharmacyTransfer(req: FastifyRequest, transferId: string, locationId: string, eventCursor?: string) {
  const { transfer } = await scoped(req, transferId, locationId);
  const events = await PharmacyTransferEvent.find({ transferId: transfer._id, organizationId: transfer.organizationId, ...(eventCursor ? { _id: { $lt: identifier(eventCursor) } } : {}) }).sort({ _id: -1 }).limit(21).lean();
  return { ...dto(transfer), nextEventsCursor: events.length > 20 ? String(events[19]._id) : null,
    events: events.slice(0, 20).map(event => ({ id: String(event._id), action: event.action, revision: event.revision, quantity: event.quantity, disposition: event.disposition || null, reviewReference: event.reviewReference, createdAt: event.createdAt })) };
}
export async function listPharmacyTransfers(req: FastifyRequest, locationId: string, cursor?: string) {
  const scope = await authority(req, locationId);
  const rows = await PharmacyTransfer.find({ organizationId: scope.organizationId, $or: [{ sourceLocationId: scope.locationId }, { destinationLocationId: scope.locationId }], ...(cursor ? { _id: { $lt: identifier(cursor) } } : {}) }).sort({ _id: -1 }).limit(21).lean();
  return { items: rows.slice(0, 20).map(dto), nextCursor: rows.length > 20 ? String(rows[19]._id) : null };
}
export async function transferProducts(req: FastifyRequest, locationId: string, search: unknown = "") {
  const scope = await authority(req, locationId);
  if (typeof search !== "string" || search.length > 100) throw new CommandError(400, "Search up to 100 characters within one branch");
  const pattern = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const rows = await Medicine.find({ locationId: scope.locationId, deletedAt: null, $or: [{ name: pattern }, { genericName: pattern }, { barcodes: search.trim() }] }).select("name genericName manufacturer strength category scheduleType unitDefinition stockQuantity").sort({ _id: -1 }).limit(20).maxTimeMS(5000).lean();
  return { locationId: scope.locationId, items: rows.map(row => ({ id: String(row._id), name: row.name, identity: [row.genericName, row.strength, row.manufacturer].filter(Boolean).join(" / "), stockQuantity: row.stockQuantity, unit: row.unitDefinition?.baseUnit || null })) };
}
export async function transferSourceLots(req: FastifyRequest, locationId: string, medicineId: string, cursor?: string) {
  const scope = await authority(req, locationId);
  const medicine = await Medicine.findOne({ _id: identifier(medicineId), locationId: scope.locationId, deletedAt: null });
  if (!medicine?.unitDefinition) throw fail("Choose an owned product with explicit reviewed units");
  const rows = await MedicineBatch.find({ organizationId: scope.organizationId, medicineId: medicine._id, locationId: scope.locationId, lotVersion: 1, status: "active", quantity: { $gt: 0 }, expiryDate: { $gt: new Date() }, ...(cursor ? { _id: { $lt: identifier(cursor) } } : {}) }).sort({ _id: -1 }).limit(21).lean();
  for (const lot of rows) validateCapturedLot(lot, medicine.unitDefinition, scope.organizationId);
  return { locationId: scope.locationId, medicineId, items: rows.slice(0, 20).map(lot => ({ id: String(lot._id), quantity: lot.quantity, ...lotFacts(lot) })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null };
}
