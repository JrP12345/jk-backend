import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { requirePharmacyDispenseIndexes } from "./PharmacyDispenseIndexes.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { pharmacySaleInput } from "../schemas/pharmacySales.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { dispenseMedicineFEFO } from "./PharmacyInventoryService.ts";
import { loadPharmacyIssuer, pharmacyDocumentSnapshot } from "./PharmacyDocumentService.ts";
import { PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { prepareRestrictedSupply, recordRestrictedSupply } from "./PharmacyRestrictedSupply.ts";
import { allocatePharmacyInvoiceNumber } from "../utilities/invoiceNumber.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { prepareCounterSale } from "./PharmacySaleQuoteService.ts";
import { recordPharmacyCollection } from "./PharmacyCollectionService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { counterInvoiceDocument } from "../utilities/pharmacyInvoiceDocument.ts";
import { authorizeExternalSale, completeExternalSupply } from "./PharmacyExternalPrescriptionService.ts";
import { PharmacySaveTimings } from "./PharmacySaveTimings.ts";

const operationScope = (organizationId: string, locationId: string) => `pharmacy-sale:${organizationId}:${locationId}`;
export async function recoverPharmacySale(req: FastifyRequest, locationId: unknown, key: string) {
  const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid sale reference");
  const record = await OperationReceipt.findOne({ scope: operationScope(scope.organizationId, scope.locationId), key }).select("+responseCiphertext").lean();
  if (!record?.resultId || !record.responseCiphertext) throw new CommandError(404, "No committed counter invoice is visible. Keep the same reference and check again.");
  let snapshot: any;
  try { snapshot = JSON.parse(decryptField(record.responseCiphertext)); } catch { throw new CommandError(409, "Sale result needs review"); }
  if (snapshot.actorId !== scope.actorId) throw new CommandError(404, "No committed sale is visible for this operator");
  if (snapshot.version !== 1 || snapshot.data?.invoiceId !== String(record.resultId)) throw new CommandError(409, "Sale result needs review");
  return snapshot.data;
}
export async function issuePharmacySale(req: FastifyRequest, timings = new PharmacySaveTimings()) {
  const input = pharmacySaleInput(req.body), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for counter issue");
  const scope = await timings.measure("authority", async () => {
    const scope = await purchaseScope(req, input.locationId);
    if (input.payment && !await pharmacyRequestAllows(req, "collect")) throw new CommandError(403, "Pharmacy collection permission is required to save a paid bill");
    if (input.externalPrescription && !await pharmacyRequestAllows(req, "externalDispense")) throw new CommandError(403, "Prescribed medicine dispensing permission is required");
    return scope;
  });
  // Current development schema scopes prescription uniqueness to clinical supplies.
  await timings.measure("readiness", async () => {
    if (!await OperationReceipt.exists({ scope: operationScope(scope.organizationId, scope.locationId), key })) await requirePharmacyDispenseIndexes();
  });
  let committed: Record<string, unknown> | undefined;
  let finishFinalization: (() => void) | undefined;
  const command = await timings.measure("command", () => executeRecordedCommand(operationScope(scope.organizationId, scope.locationId), key, { actorId: scope.actorId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const external = input.externalPrescription ? await authorizeExternalSale(req, scope, input.externalPrescription, input.lines, true) : undefined;
    const issuer = await loadPharmacyIssuer(scope.organizationId, scope.locationId);
    if (input.confirmationMode !== "current_total" && issuer.revision !== input.expectedProfileRevision) throw new CommandError(409, "Issuer profile changed; refresh the sale before issuing");
    let customer: { anonymous: boolean; partyId?: mongoose.Types.ObjectId; revision?: number; name?: string; address?: string; phone?: string } = { anonymous: true };
    if (input.customerId) {
      const party = await PharmacyParty.findOneAndUpdate({ _id: input.customerId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer", archived: false, revision: input.expectedCustomerRevision }, { $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false });
      if (!party) throw new CommandError(409, "Customer changed or is unavailable at this branch");
      if (party.gstin) throw new CommandError(409, "Business GST invoicing requires a separately reviewed B2B workflow");
      customer = { anonymous: false, partyId: party._id, revision: party.revision, name: party.name, address: party.address, phone: party.phone || undefined };
    }
    const prepared = await timings.measure("prepare", () => prepareCounterSale(input, scope, issuer, session, input.confirmationMode !== "current_total", external, true));
    if (input.expectedQuoteHash && input.expectedQuoteHash !== prepared.quoteHash) throw new CommandError(409, "Quote changed; refresh and confirm the current sale before issuing");
    if (prepared.calculation.totals.payablePaise !== input.expectedTotalPaise || input.confirmationMode === "current_total" && prepared.captured.some(line => line.grossAmountPaise - line.discountPaise !== input.lines.find(wanted => wanted.lineId === line.calculationLineId)?.expectedLineTotalPaise)) throw new CommandError(409, "Current prices differ from the confirmed amounts; review the updated sale", { code: "COUNTER_TOTAL_CHANGED" });
    const invoiceId = new mongoose.Types.ObjectId(), dispenseId = new mongoose.Types.ObjectId(), issuedAt = new Date();
    const captured = prepared.captured.map(line => ({ ...line, _id: new mongoose.Types.ObjectId() })), calculation = prepared.calculation;
    await timings.measure("stock", async () => { for (const line of captured) {
      if (prepared.inventoryMode === "billing_only") {
        if (external) {
          const reviewed = await prepareRestrictedSupply(String(line.medicineId), scope.locationId, line.quantity, { organizationId: scope.organizationId, invoiceId, dispenseId, dispensedBy: scope.actorId, dispensedAt: issuedAt, externalPrescriptionId: input.externalPrescription!.id, externalPrescriptionRevision: input.externalPrescription!.revision + 1 });
          await recordRestrictedSupply(reviewed, line.pricingAllocations.map((lot: any) => ({ batchNumber: lot.batchNumber, expiryDate: lot.expiryDate, quantity: lot.quantity })));
        }
        continue;
      }
      const result = await dispenseMedicineFEFO(String(line.medicineId), scope.locationId, line.quantity, session, { dispensedBy: scope.actorId,
        ...(external ? { organizationId: scope.organizationId, invoiceId, dispenseId, dispensedAt: issuedAt, externalPrescriptionId: input.externalPrescription!.id, externalPrescriptionRevision: input.externalPrescription!.revision + 1 } : {}) }, prepared.stockPreparations.get(line.calculationLineId));
      if (JSON.stringify(result.dispensedBatches) !== JSON.stringify(line.batches)) throw new CommandError(409, "Eligible lots changed; refresh the sale");
    } });
    if (calculation.totals.payablePaise !== input.expectedTotalPaise) throw new CommandError(409, "Calculated total differs from the confirmed sale; refresh before issuing");
    const lines = captured.map(line => { const priced = calculation.lines.find(row => row.lineId === line.calculationLineId)!;
      return { ...line, baseAmountPaise: priced.baseAmountPaise, cgstPaise: priced.cgstPaise, sgstPaise: priced.sgstPaise, grossAmountPaise: priced.grossAmountPaise, amount: priced.baseAmountPaise / line.quantity / 100, lineAmount: priced.grossAmountPaise / 100 }; });
    const finishDocuments = timings.start("documents");
    const numbering = await allocatePharmacyInvoiceNumber(scope.locationId, issuedAt), totals = calculation.totals;
    const taxDocument = { ...await pharmacyDocumentSnapshot(issuer, { name: customer.name || external?.document.patientName || "Walk-in customer", address: customer.address || external?.document.patientAddress || "", state: issuer.stateCode }, scope.actorId, issuedAt, lines), version: 2, pricingPolicy: PHARMACY_CALCULATION_POLICY };
    // Retain the existing boundary for identified recipient evidence at high invoice values.
    if (totals.payablePaise >= 5_000_000 && (!customer.name || !customer.address) && !external) throw new CommandError(409, "Record actual recipient name/address before this high-value counter invoice");
    const invoice = await createWithSession<InstanceType<typeof Invoice>>(Invoice, { _id: invoiceId, kind: "pharmacy", createdBy: scope.actorId, customerSnapshot: customer, calculation,
      organizationId: scope.organizationId, locationId: scope.locationId, currency: "INR", documentVersion: 2, issuedAt, ...numbering, taxDocument,
      items: lines.map(line => ({ pharmacyDispenseId: dispenseId, pharmacyDispenseLineId: line._id, calculationLineId: line.calculationLineId, description: line.description,
        quantity: line.quantity, amount: line.amount, totalItemAmount: line.lineAmount, hsnSacCode: line.hsnSacCode, gstRate: line.gstRate, unitCode: line.unitCode, taxTreatment: line.taxTreatment,
        baseAmountPaise: line.baseAmountPaise, cgstPaise: line.cgstPaise, sgstPaise: line.sgstPaise, grossAmountPaise: line.grossAmountPaise,
        cgstAmount: line.cgstPaise / 100, sgstAmount: line.sgstPaise / 100 })),
      subtotal: totals.baseAmountPaise / 100, taxableAmount: totals.baseAmountPaise / 100, tax: (totals.cgstPaise + totals.sgstPaise) / 100,
      cgstTotal: totals.cgstPaise / 100, sgstTotal: totals.sgstPaise / 100, igstTotal: 0, discount: (totals.lineDiscountPaise + totals.invoiceDiscountPaise) / 100,
      totalAmount: totals.payablePaise / 100, status: totals.payablePaise === 0 ? "paid" : "unpaid", amountPaid: 0, balanceDue: totals.payablePaise / 100,
      invoiceType: "B2C", supplierGstin: issuer.gstin, placeOfSupply: issuer.stateCode, isInterstate: false,
    }, session);
    await createWithSession(PharmacyDispense, { _id: dispenseId, kind: "pharmacy", inventoryMode: prepared.inventoryMode, organizationId: scope.organizationId, locationId: scope.locationId, invoiceId, actorId: scope.actorId, operationKey: key, prescriptionIds: [], lines,
      ...(external ? { externalPrescriptionId: external.row._id, externalPrescriptionRevision: input.externalPrescription!.revision + 1 } : {}) }, session);
    if (external) await completeExternalSupply(external, scope, invoiceId, numbering.invoiceNumber, dispenseId, issuedAt, input.lines);
    finishDocuments();
    // One commit for an explicitly confirmed counter payment and its stock/bill changes.
    // Failures (including a closed drawer) roll back the entire new sale.
    const collection = input.payment ? await timings.measure("payment", () => recordPharmacyCollection(scope, String(invoiceId), input.payment!, key, session, true, invoice)) : undefined;
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_COUNTER_INVOICE_ISSUED", category: "BILLING", targetModel: "Invoice", targetId: invoiceId, details: { dispenseId, invoiceNumber: numbering.invoiceNumber, totalPaise: totals.payablePaise, paymentCollected: Boolean(collection) } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    const data = { invoiceId: String(invoiceId), dispenseId: String(dispenseId), invoiceNumber: numbering.invoiceNumber, totalPaise: totals.payablePaise, status: collection || totals.payablePaise === 0 ? "paid" : "unpaid", requestKey: key, ...(collection ? { collection } : {}), ...(input.includeDocument ? { document: counterInvoiceDocument(invoice.toObject(), { lines }) } : {}) };
    const saved = await OperationReceipt.updateOne({ scope: operationScope(scope.organizationId, scope.locationId), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Sale reservation changed; keep the same reference");
    committed = data;
    // Includes the enclosing receipt result write and actual transaction commit.
    finishFinalization = timings.start("finalize");
    return String(invoiceId);
  }), { writeConcern: { w: "majority" } }));
  finishFinalization?.();
  // Only return the captured result after the transaction has committed. Replays still read the durable receipt.
  return { ...(!command.replayed && committed ? committed : await recoverPharmacySale(req, scope.locationId, key)), replayed: command.replayed };
}
