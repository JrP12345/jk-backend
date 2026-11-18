import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { saleBlocked } from "../utilities/pharmacySaleControl.ts";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { PharmacyOfflineGrant } from "../models/PharmacyOfflineGrant.ts";
import { PharmacyOfflineImport } from "../models/PharmacyOfflineImport.ts";
import { findOfflineDeviceEvidence } from "./PharmacyOfflineDeviceService.ts";
import { PharmacyOfflineSnapshotPage } from "../models/PharmacyOfflineSnapshotPage.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { buildOfflinePharmacyDocument, offlineEvidenceCanonical, type OfflineDocumentProduct, type OfflineDocumentLot, type OfflineIssuedReceipt } from "../utilities/pharmacyOfflineDocument.ts";
import { offlineDocumentPolicy } from "../utilities/pharmacyOfflinePolicy.ts";
import { validPharmacyInvoiceNumber } from "../utilities/pharmacyInvoiceNumberFormat.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { withVerifiedOfflineOwnership } from "../utilities/pharmacyOfflineOwnership.ts";
import { pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { recordPharmacyCollection } from "./PharmacyCollectionService.ts";
import { appendStockMovement } from "./PharmacyStockMovementService.ts";
import { verifyOfflineDeviceMessage, requireOfflineImportIndexes } from "./PharmacyOfflineGrantService.ts";
import { object } from "../schemas/pharmacyPurchases.ts";
import { CommandError } from "./CommandReceiptService.ts";

const hash = (value: unknown) => crypto.createHash("sha256").update(offlineEvidenceCanonical(value)).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
const whole = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) < Number.MAX_SAFE_INTEGER;
const conflict = (message: string): never => { throw new CommandError(409, message, { code: "OFFLINE_IMPORT_REVIEW" }); };
export function offlineReceiptProofMessage(authorityId: string, digest: string) { return `ekavyu.pharmacy.offline-sale.v1\n${authorityId}\n${digest}`; }
function input(raw: unknown) {
  const value = object(raw, ["receipt", "digest", "deviceSignature"]);
  const receipt = object(value.receipt, ["version", "authorityId", "manifestDigest", "calculationEngineSha256", "documentEngineSha256", "scope", "commandId", "leaseId", "sequence", "requestDigest", "previousDigest", "invoice", "lines", "payment", "stock", "products"]) as unknown as OfflineIssuedReceipt;
  if (receipt.version !== 2 || !/^[a-f0-9-]{36}$/.test(receipt.authorityId) || !whole(receipt.sequence, 1) || !/^[a-zA-Z0-9_-]{8,100}$/.test(receipt.commandId) ||
      !/^[a-f0-9]{64}$/.test(String(value.digest)) || !/^[\w-]{86}$/.test(String(value.deviceSignature)) || !/^[a-f0-9]{64}$/.test(receipt.requestDigest) || !/^[a-f0-9]{64}$/.test(receipt.manifestDigest) ||
      receipt.previousDigest !== null && !/^[a-f0-9]{64}$/.test(receipt.previousDigest) || !receipt.invoice || typeof receipt.invoice !== "object" || !Array.isArray(receipt.lines) || !receipt.lines.length || receipt.lines.length > 100 ||
      !Array.isArray(receipt.stock) || receipt.stock.length > 1000 || !Array.isArray(receipt.products) || receipt.products.length !== receipt.lines.length) throw new CommandError(400, "Offline receipt is incomplete or exceeds the supported bound");
  try { if (Buffer.byteLength(offlineEvidenceCanonical(receipt)) > 2 * 1024 * 1024 || hash(receipt) !== value.digest) throw new Error("digest"); }
  catch { throw new CommandError(400, "Original offline receipt digest is invalid"); }
  const lineIds = new Set<string>(), products = new Set<string>(), allocations = new Set<string>();
  for (const rawLine of receipt.lines) {
    const line = object(rawLine, ["lineId", "medicineId", "discountPaise", "allocations"]);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(line.lineId) || lineIds.has(line.lineId) || !id(line.medicineId) || products.has(line.medicineId) || !whole(line.discountPaise) || !Array.isArray(line.allocations) || !line.allocations.length || line.allocations.length > 100) throw new CommandError(400, "Invalid offline product lines");
    lineIds.add(line.lineId); products.add(line.medicineId);
    for (const rawAllocation of line.allocations) {
      const allocation = object(rawAllocation, ["lotId", "quantity", "expectedRevision"]);
      if (!id(allocation.lotId) || allocations.has(allocation.lotId) || !whole(allocation.quantity, 1) || !whole(allocation.expectedRevision)) throw new CommandError(400, "Invalid or duplicated offline lot allocation");
      allocations.add(allocation.lotId);
    }
  }
  if (allocations.size > 1000 || allocations.size !== receipt.stock.length || new Set(receipt.stock.map(row => row.lotId)).size !== allocations.size || new Set(receipt.products.map(row => row.medicineId)).size !== products.size) throw new CommandError(400, "Offline stock evidence is duplicated or incomplete");
  for (const rawStock of receipt.stock) {
    const row = object(rawStock, ["lotId", "before", "after", "revision"]);
    if (!allocations.has(row.lotId) || !whole(row.before, 1) || !whole(row.after) || row.after >= row.before || !whole(row.revision, 1)) throw new CommandError(400, "Invalid offline lot checkpoint");
  }
  for (const rawStock of receipt.products) {
    const row = object(rawStock, ["medicineId", "before", "after", "revision"]);
    if (!products.has(row.medicineId) || !whole(row.before, 1) || !whole(row.after) || row.after >= row.before || !whole(row.revision, 1)) throw new CommandError(400, "Invalid offline product checkpoint");
  }
  const payment = object(receipt.payment, ["manualConfirmed", "cashTenderedPaise", "shiftId", "drawerCode", "collectedPaise", "changePaise", "evidenceMode"]);
  if (payment.manualConfirmed !== true || payment.evidenceMode !== "staff_confirmed_manual" || !id(payment.shiftId) || !whole(payment.cashTenderedPaise) || !whole(payment.collectedPaise, 1) || !whole(payment.changePaise) || payment.cashTenderedPaise - payment.collectedPaise !== payment.changePaise) throw new CommandError(400, "Invalid captured offline cash evidence");
  return { receipt, digest: String(value.digest), deviceSignature: String(value.deviceSignature) };
}
function acknowledgement(row: { commandId: string; digest: string; invoiceNumber: string; invoiceId: unknown; sequence: number; authorityId: string }) {
  return { commandId: row.commandId, digest: row.digest, invoiceNumber: row.invoiceNumber, serverInvoiceId: String(row.invoiceId), sequence: row.sequence, authorityId: row.authorityId };
}

/** One durable server transaction per ordered, immutable local bill. Current
 * catalogue prices never overwrite the captured document already handed out.
 */
export async function importOfflinePharmacyReceipt(req: FastifyRequest, locationId: string, raw: unknown) {
  const command = input(raw), receipt = command.receipt, requester = await purchaseScope(req, locationId);
  const manager = await pharmacyRequestAllows(req, "manageSettings");
  const grantRow = await PharmacyOfflineGrant.findOne({ organizationId: requester.organizationId, locationId, authorityId: receipt.authorityId }).lean();
  if (!grantRow || !manager && String(grantRow.actorId) !== requester.actorId) throw new CommandError(404, "Original offline grant is not visible for this operator");
  if (!manager && (!await pharmacyRequestAllows(req, "sell") || !await pharmacyRequestAllows(req, "collect"))) throw new CommandError(403, "Current collection authority or an authorized branch manager is required for offline import");
  const grant = JSON.parse(grantRow.payload), owner = { organizationId: requester.organizationId, locationId, actorId: String(grantRow.actorId) };
  const device = await findOfflineDeviceEvidence(owner.organizationId, locationId, grant.deviceId, grant.enrollmentId);
  if (!device) return conflict("Original enrolled key requires recovery; keep the issued bill unchanged");
  verifyOfflineDeviceMessage(device.publicKey, offlineReceiptProofMessage(receipt.authorityId, command.digest), command.deviceSignature);
  const rebuild = offlineDocumentPolicy(receipt.calculationEngineSha256, receipt.documentEngineSha256);
  if (grant.checkoutEnabled !== true || grant.purpose !== "ekavyu.pharmacy.checkout-grant.v1" || grant.manifestDigest !== receipt.manifestDigest ||
      !rebuild ||
      grant.calculation.sha256 !== receipt.calculationEngineSha256 || grant.calculation.documentSha256 !== receipt.documentEngineSha256 ||
      offlineEvidenceCanonical(receipt.scope) !== offlineEvidenceCanonical({ organizationId: owner.organizationId, locationId, deviceId: grant.deviceId }) ||
      receipt.leaseId !== grant.enrollmentId || receipt.payment.shiftId !== grant.drawer.id || receipt.payment.drawerCode !== grant.drawer.code || receipt.invoice.createdBy !== owner.actorId)
    return conflict("Offline receipt differs from its original branch, device, issuer or calculation authority");
  await requireOfflineImportIndexes();
  try {
    return await withTransaction(async session => {
      requireStockTransaction(session);
      const existing = await PharmacyOfflineImport.findOne({ authorityId: receipt.authorityId, commandId: receipt.commandId });
      if (existing) {
        if (existing.digest !== command.digest || existing.sequence !== receipt.sequence) return conflict("This offline reference already contains different evidence");
        if (!await Invoice.exists({ _id: existing.invoiceId, organizationId: owner.organizationId, locationId }) || !await InvoiceCollectionReceipt.exists({ _id: existing.collectionId, invoiceId: existing.invoiceId })) return conflict("Committed offline import sources require integrity review");
        return acknowledgement(existing);
      }
      const authority = await PharmacyOfflineAuthority.findOne({ authorityId: receipt.authorityId, organizationId: owner.organizationId, locationId, state: "held", checkoutActivatedAt: { $exists: true } });
      if (!authority || authority.importedSequence + 1 !== receipt.sequence || receipt.sequence < authority.firstSequence || receipt.sequence > authority.lastSequence) return conflict("Import the next original offline sequence first; never create a replacement bill");
      const previous = receipt.sequence === authority.firstSequence ? null : await PharmacyOfflineImport.findOne({ authorityId: receipt.authorityId, sequence: receipt.sequence - 1 }).lean();
      const issuedAt = new Date(receipt.invoice.issuedAt);
      if (!Number.isFinite(issuedAt.getTime()) || issuedAt.toISOString() !== receipt.invoice.issuedAt || issuedAt < new Date(grant.validFrom) || issuedAt > new Date(grant.validUntil) || issuedAt > new Date(Date.now() + 60_000) ||
          previous && issuedAt < previous.issuedAt || receipt.previousDigest !== (previous?.digest ?? null)) return conflict("Offline issue time or the preceding receipt chain differs from its grant");
      const manifest = await PharmacyOfflineSnapshotPage.findOne({ organizationId: owner.organizationId, locationId, authorityId: receipt.authorityId, page: -1, sha256: receipt.manifestDigest }).lean();
      if (!manifest) return conflict("Original prepared stock evidence is missing");
      const prepared = JSON.parse(manifest.payload), references = new Map<number, string>(prepared.pages.map((page: { page: number; sha256: string }) => [page.page, page.sha256]));
      const wanted = [...receipt.lines.map(line => line.medicineId), ...receipt.stock.map(row => row.lotId)];
      const pages = await PharmacyOfflineSnapshotPage.find({ authorityId: receipt.authorityId, organizationId: owner.organizationId, locationId, page: { $gte: 0 }, recordIds: { $in: wanted } }).lean();
      const captured = new Map<string, Record<string, any>>();
      for (const page of pages) {
        if (references.get(page.page) !== page.sha256 || crypto.createHash("sha256").update(page.payload).digest("hex") !== page.sha256) return conflict("Original prepared page has changed");
        for (const record of JSON.parse(page.payload).records) captured.set(`${record.kind}:${record.id}`, record);
      }
      const sourceLines = receipt.lines.map(line => {
        const product = captured.get(`product:${line.medicineId}`) as unknown as OfflineDocumentProduct;
        const allocations = line.allocations.map(allocation => {
          const lot = captured.get(`lot:${allocation.lotId}`) as unknown as OfflineDocumentLot;
          if (!lot || lot.medicineId !== line.medicineId) return conflict("An offline lot was not assigned to this product/device");
          return { ...lot, quantity: allocation.quantity };
        });
        if (!product) return conflict("An offline product was not assigned to this device");
        return { lineId: line.lineId, product, allocations, discountPaise: line.discountPaise };
      });
      let document: ReturnType<typeof buildOfflinePharmacyDocument>;
      try { document = rebuild!({ actorId: owner.actorId, issuedAt: receipt.invoice.issuedAt, financialYear: grant.lease.financialYear, issuer: prepared.issuer, issuerRevision: prepared.issuerRevision,
        issuerReviewReference: prepared.issuerReviewReference, lines: sourceLines, invoiceDiscountPaise: receipt.invoice.calculation?.totals.invoiceDiscountPaise, roundOffPaise: receipt.invoice.calculation?.totals.roundOffPaise }); }
      catch { return conflict("Captured offline amounts or tax do not match the originally prepared supply"); }
      const lease = grant.lease, numbering = lease.format ? { numberingVersion: 3, invoiceSeries: lease.prefix, numberingSnapshot: { ...lease.format, version: 1, prefix: lease.prefix, sequence: receipt.sequence } }
        : { numberingVersion: 2, invoiceSeries: lease.prefix.slice(1, 5) };
      const invoiceNumber = `${lease.prefix}${String(receipt.sequence).padStart(lease.format?.digits ?? 6, "0")}`;
      if (offlineEvidenceCanonical(receipt.invoice) !== offlineEvidenceCanonical({ ...document, invoiceNumber, ...numbering }) ||
          !validPharmacyInvoiceNumber({ ...receipt.invoice, issuedAt }) || receipt.payment.collectedPaise !== document.calculation.totals.payablePaise) return conflict("Already issued invoice number/document/payment differs; retain the original for review");
      const expectedRequest = { commandId: receipt.commandId, leaseId: receipt.leaseId, actorId: owner.actorId, invoice: document, lines: receipt.lines,
        payment: { manualConfirmed: true, cashTenderedPaise: receipt.payment.cashTenderedPaise, shiftId: receipt.payment.shiftId, drawerCode: receipt.payment.drawerCode } };
      if (hash(expectedRequest) !== receipt.requestDigest) return conflict("Original offline Save intent does not match its receipt");
      return withVerifiedOfflineOwnership({ ...owner, authorityId: receipt.authorityId, drawerId: grant.drawer.id }, async () => {
        await pinPharmacyContinuityLocation(locationId, session);
        const medicines = await Medicine.find({ _id: { $in: receipt.lines.map(line => line.medicineId) }, locationId, deletedAt: null });
        const batches = await MedicineBatch.find({ _id: { $in: receipt.stock.map(row => row.lotId) }, organizationId: owner.organizationId, locationId });
        const byMedicine = new Map(medicines.map(medicine => [String(medicine._id), medicine])), byBatch = new Map(batches.map(batch => [String(batch._id), batch]));
        for (const line of receipt.lines) {
          const medicine = byMedicine.get(line.medicineId), productState = receipt.products.find(row => row.medicineId === line.medicineId)!;
          if (medicine && saleBlocked(medicine, issuedAt)) return conflict("The original offline bill was issued during a product sale hold. Retain its invoice, payment and stock evidence for review.");
          const quantity = line.allocations.reduce((sum, allocation) => sum + BigInt(allocation.quantity), 0n);
          if (!medicine || medicine.stockQuantity !== productState.before || medicine.stockRevision !== productState.revision - 1 || BigInt(productState.before) - quantity !== BigInt(productState.after)) return conflict("Offline product checkpoint differs from the owned server stock");
          const allocations = [];
          for (const allocation of line.allocations) {
            const batch = byBatch.get(allocation.lotId), state = receipt.stock.find(row => row.lotId === allocation.lotId)!;
            if (batch && saleBlocked(batch, issuedAt)) return conflict("The original offline bill was issued during a batch sale hold. Retain the original bill for review.");
            const old = batch?.offlineImportRevision, revision = old?.authorityId === receipt.authorityId ? old.revision : 0;
            if (!batch || String(batch.medicineId) !== line.medicineId || !["active", "expired"].includes(batch.status) || batch.quantity !== state.before || state.before - allocation.quantity !== state.after || allocation.expectedRevision !== revision || state.revision !== revision + 1) return conflict("Offline lot checkpoint differs from the owned server stock");
            const changed = await MedicineBatch.updateOne({ _id: batch._id, quantity: state.before, status: batch.status,
              ...(old ? { "offlineImportRevision.authorityId": old.authorityId, "offlineImportRevision.revision": old.revision } : { offlineImportRevision: { $exists: false } }) },
              { $set: { quantity: state.after, status: state.after === 0 ? "depleted" : batch.status, offlineImportRevision: { authorityId: receipt.authorityId, revision: state.revision } } }, { session });
            if (changed.modifiedCount !== 1) return conflict("Owned lot changed during import; retry the same receipt");
            allocations.push({ batchId: batch._id, beforeQuantity: state.before, afterQuantity: state.after, quantityDelta: -allocation.quantity });
          }
          await appendStockMovement(medicine, "dispense", productState.after, allocations, session, { actorId: owner.actorId, clientRequestId: receipt.commandId, notes: "Imported original offline counter supply" });
          const changed = await Medicine.updateOne({ _id: medicine._id, stockQuantity: productState.before, stockRevision: productState.revision - 1 }, { $set: { stockQuantity: productState.after, stockRevision: productState.revision, stockLedgerStartedAt: medicine.stockLedgerStartedAt || issuedAt } }, { session });
          if (changed.modifiedCount !== 1) return conflict("Owned product changed during import; retry the same receipt");
        }
        const invoiceId = new mongoose.Types.ObjectId(), dispenseId = new mongoose.Types.ObjectId(), totals = document.calculation.totals;
        const lines = sourceLines.map((line, index) => ({ _id: new mongoose.Types.ObjectId(), calculationLineId: line.lineId, medicineId: line.product.id, description: line.product.name,
          unitSnapshot: line.product.unitDefinition, quantity: document.items[index].quantity, amount: document.items[index].amount, lineAmount: document.items[index].grossAmountPaise / 100,
          baseAmountPaise: document.items[index].baseAmountPaise, cgstPaise: document.items[index].cgstPaise, sgstPaise: document.items[index].sgstPaise, grossAmountPaise: document.items[index].grossAmountPaise,
          hsnSacCode: line.product.hsnSacCode, unitCode: line.product.unitCode, gstRate: line.product.gstRateBps / 100, taxTreatment: line.product.taxTreatment,
          taxReviewReference: captured.get(`product:${line.product.id}`)!.taxReviewReference, prescriptions: [],
          batches: line.allocations.map(lot => ({ batchId: lot.id, batchNumber: lot.batchNumber, quantity: lot.quantity })),
          pricingAllocations: line.allocations.map(lot => ({ batchId: lot.id, batchNumber: lot.batchNumber, expiryDate: new Date(captured.get(`lot:${lot.id}`)!.expiryCutoff), expiryValue: lot.expiryValue,
            expiryPrecision: lot.expiryPrecision === "date" ? "day" : "month", quantity: lot.quantity, unitPrice: lot.sellingPricePaise / 100, mrpPaise: lot.mrpPaise, hsnCode: captured.get(`lot:${lot.id}`)!.hsnCode, gstRate: captured.get(`lot:${lot.id}`)!.gstRateBps / 100 })) }));
        const invoice = await createWithSession<InstanceType<typeof Invoice>>(Invoice, { ...document, ...numbering, invoiceNumber, _id: invoiceId, organizationId: owner.organizationId, locationId,
          createdAt: issuedAt, issuedAt, status: "unpaid", amountPaid: 0, balanceDue: totals.payablePaise / 100, taxableAmount: totals.baseAmountPaise / 100,
          igstTotal: 0, discount: (totals.lineDiscountPaise + totals.invoiceDiscountPaise) / 100, invoiceType: "B2C", supplierGstin: prepared.issuer.gstin,
          placeOfSupply: prepared.issuer.stateCode, isInterstate: false, items: lines.map(line => ({ ...line, pharmacyDispenseId: dispenseId, pharmacyDispenseLineId: line._id, totalItemAmount: line.lineAmount,
            cgstAmount: Number(line.cgstPaise) / 100, sgstAmount: Number(line.sgstPaise) / 100 })) }, session);
        await createWithSession(PharmacyDispense, { _id: dispenseId, kind: "pharmacy", inventoryMode: "tracked", organizationId: owner.organizationId, locationId, actorId: owner.actorId, invoiceId,
          operationKey: receipt.commandId, prescriptionIds: [], lines }, session);
        const collection = await recordPharmacyCollection(owner, String(invoiceId), { locationId, expectedPaymentRevision: 0, expectedBalancePaise: totals.payablePaise, manualConfirmed: true,
          cashTenderedPaise: receipt.payment.cashTenderedPaise, entries: [{ componentId: "offline-cash", paymentMethod: "cash", amountPaise: totals.payablePaise }] }, receipt.commandId, session, true, invoice, issuedAt);
        const imported = await PharmacyOfflineImport.create({ authorityId: receipt.authorityId, organizationId: owner.organizationId, locationId, actorId: owner.actorId, importedBy: requester.actorId,
          commandId: receipt.commandId, sequence: receipt.sequence, digest: command.digest, deviceSignature: command.deviceSignature, evidenceCiphertext: offlineEvidenceCanonical(receipt),
          invoiceId, collectionId: collection.receiptId, invoiceNumber, issuedAt });
        const advanced = await PharmacyOfflineAuthority.updateOne({ _id: authority._id, state: "held", revision: authority.revision, importedSequence: receipt.sequence - 1 }, { $set: { importedSequence: receipt.sequence }, $inc: { revision: 1 } });
        if (advanced.modifiedCount !== 1) return conflict("Another importer changed the original sequence; retry the same receipt");
        await AuditLog.create({ organizationId: owner.organizationId, userId: requester.actorId, action: "PHARMACY_OFFLINE_INVOICE_IMPORTED", category: "BILLING", targetModel: "Invoice", targetId: invoiceId,
          details: { authorityId: receipt.authorityId, commandId: receipt.commandId, sequence: receipt.sequence, invoiceNumber, originalActorId: owner.actorId, originalIssuedAt: issuedAt, digest: command.digest } });
        return acknowledgement(imported);
      });
    }, { writeConcern: { w: "majority" } });
  } catch (failure) {
    if ((failure as { code?: number }).code !== 11000) throw failure;
    const existing = await PharmacyOfflineImport.findOne({ authorityId: receipt.authorityId, commandId: receipt.commandId }).lean();
    if (existing?.digest === command.digest && existing.sequence === receipt.sequence) return acknowledgement(existing);
    return conflict("An offline command, number or sequence already has different evidence. Keep the original bill for review.");
  }
}
