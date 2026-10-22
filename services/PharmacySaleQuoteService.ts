import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { pharmacyQuoteInput, pharmacySaleInput } from "../schemas/pharmacySales.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, commandHash } from "./CommandReceiptService.ts";
import { loadPharmacyIssuer, pricePharmacySupply } from "./PharmacyDocumentService.ts";
import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";
import { validateCapturedLot } from "../utilities/pharmacyLot.ts";
import { toPaise } from "../utilities/pharmacyTax.ts";
import { withTransaction } from "../utilities/transaction.ts";

type SaleInput = ReturnType<typeof pharmacySaleInput>;
type Scope = { organizationId: string; locationId: string };
/** Read-only preparation used by both the provisional quote and committed issue. */
export async function prepareCounterSale(input: SaleInput, scope: Scope, issuer: any, session: mongoose.ClientSession | null, enforceVersions: boolean) {
  const captured: any[] = [], versions: Array<{ lineId: string; medicineId: string; expectedUnitVersion: number; expectedStockRevision: number; quantity: number; discountPaise: number }> = [];
  const now = new Date();
  for (const line of input.lines) {
    const medicine = await Medicine.findOne({ _id: line.medicineId, locationId: scope.locationId, deletedAt: null }).session(session);
    if (!medicine?.unitDefinition || medicine.unitDefinition.version !== line.expectedUnitVersion || enforceVersions && medicine.stockRevision !== line.expectedStockRevision) throw new CommandError(409, "Product, units or stock changed; refresh the sale");
    if (medicine.scheduleType !== "general" || medicine.dispensingReview?.scheduleType !== "general" || !medicine.dispensingReview.confirmedAt || !medicine.dispensingReview.confirmedBy || !medicine.dispensingReview.reviewReference || medicine.dispensingRevision < 1) throw new CommandError(409, "Only reviewed ordinary products can use patient-optional counter issue; prescribed or restricted supplies need their authorized workflow");
    const inventory = await MedicineBatch.find({ medicineId: medicine._id }).sort({ expiryDate: 1, receivedAt: 1, _id: 1 }).limit(5001).session(session);
    if (!inventory.length || inventory.length > 5000 || inventory.some(lot => lot.lotVersion !== 1 || String(lot.locationId) !== scope.locationId || String(lot.organizationId) !== scope.organizationId)) throw new CommandError(409, "Counter stock needs captured owned lots within the review bound");
    for (const lot of inventory) validateCapturedLot(lot, medicine.unitDefinition, scope.organizationId);
    if (!Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0 || inventory.reduce((sum, lot) => sum + BigInt(lot.quantity), 0n) !== BigInt(medicine.stockQuantity)) throw new CommandError(409, "Counter lot and aggregate stock do not reconcile");
    let remaining = line.quantity;
    const selected: Array<{ batch: typeof inventory[number]; quantity: number }> = [];
    for (const batch of inventory) {
      if (!remaining) break;
      if (batch.status !== "active" || batch.expiryDate <= now || batch.quantity <= 0) continue;
      const quantity = Math.min(remaining, batch.quantity); selected.push({ batch, quantity }); remaining -= quantity;
    }
    if (remaining) throw new CommandError(409, "Insufficient eligible batch stock; refresh the sale");
    if (selected.some(({ batch }) => batch.mrpPaise === undefined || batch.sellingPricePaise! > batch.mrpPaise)) throw new CommandError(409, "Counter issue requires reviewed unit prices and MRP");
    const allocations = selected.map(({ batch, quantity }) => ({ batchId: String(batch._id), batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantity, unitPrice: batch.sellingPrice, hsnCode: batch.hsnCode || "", gstRate: batch.gstRate }));
    const priced = pricePharmacySupply(medicine, allocations, issuer), unit = medicine.unitDefinition;
    captured.push({ calculationLineId: line.lineId, medicineId: medicine._id, description: medicine.name, quantity: line.quantity,
      unitSnapshot: { version: unit.version, baseUnit: unit.baseUnit, packUnit: unit.packUnit, unitsPerPack: unit.unitsPerPack },
      ...priced, discountPaise: line.discountPaise, prescriptions: [], batches: allocations.map(({ batchId, batchNumber, quantity }) => ({ batchId, batchNumber, quantity })),
      pricingAllocations: allocations.map((lot, index) => ({ ...lot, unitPrice: toPaise(lot.unitPrice) / 100, mrpPaise: selected[index].batch.mrpPaise, expiryPrecision: selected[index].batch.expirySnapshot!.precision, expiryValue: selected[index].batch.expirySnapshot!.value })),
    });
    versions.push({ ...line, medicineId: String(medicine._id), expectedUnitVersion: unit.version, expectedStockRevision: medicine.stockRevision });
  }
  const calculation = calculatePharmacyDocument({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "inclusive", taxMode: issuer.registration === "regular" ? "sgst" : "none", invoiceDiscountPaise: input.invoiceDiscountPaise, roundOffPaise: input.roundOffPaise,
    lines: captured.map(line => ({ lineId: line.calculationLineId, quantity: line.quantity, unitPrice: { numeratorPaise: line.grossAmountPaise, denominatorUnits: line.quantity }, lineDiscountPaise: line.discountPaise, gstRateBps: Math.round(line.gstRate * 100) })) });
  const quoteHash = commandHash({ locationId: scope.locationId, issuerRevision: issuer.revision, customerId: input.customerId || null, customerRevision: input.expectedCustomerRevision ?? null, versions,
    lines: captured.map(line => ({ ...line, medicineId: String(line.medicineId), pricingAllocations: line.pricingAllocations.map((lot: any) => ({ ...lot, expiryDate: lot.expiryDate.toISOString() })) })), calculation });
  return { captured, calculation, versions, quoteHash };
}
export async function quoteCounterSale(req: FastifyRequest) {
  const input = pharmacyQuoteInput(req.body), scope = await purchaseScope(req, input.locationId);
  return withTransaction(async session => {
    const issuer = await loadPharmacyIssuer(scope.organizationId, scope.locationId, true);
    let customer: { id: string; revision: number; name: string } | null = null;
    if (input.customerId) {
      const party = await PharmacyParty.findOne({ _id: input.customerId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer", archived: false }).session(session);
      if (!party || party.gstin) throw new CommandError(409, "Customer unavailable or requires a separately reviewed B2B workflow");
      customer = { id: String(party._id), revision: party.revision, name: party.name };
      input.expectedCustomerRevision = party.revision;
    }
    const prepared = await prepareCounterSale(input, scope, issuer, session, false);
    if (prepared.calculation.totals.payablePaise >= 5_000_000 && !customer) throw new CommandError(409, "Select a recorded customer with actual name/address for this high-value invoice");
    return { locationId: scope.locationId, currency: "INR", quoteHash: prepared.quoteHash, customer, calculation: prepared.calculation,
      lines: prepared.captured.map(line => ({ lineId: line.calculationLineId, medicineId: String(line.medicineId), description: line.description, quantity: line.quantity, unitSnapshot: line.unitSnapshot,
        batches: line.pricingAllocations.map((lot: any) => ({ batchId: lot.batchId, batchNumber: lot.batchNumber, quantity: lot.quantity, expiryValue: lot.expiryValue, expiryPrecision: lot.expiryPrecision, sellingPricePaise: toPaise(lot.unitPrice), mrpPaise: lot.mrpPaise })) })),
      issueInput: { locationId: scope.locationId, expectedProfileRevision: issuer.revision, expectedTotalPaise: prepared.calculation.totals.payablePaise, expectedQuoteHash: prepared.quoteHash,
        ...(customer ? { customerId: customer.id, expectedCustomerRevision: customer.revision } : {}), invoiceDiscountPaise: input.invoiceDiscountPaise, roundOffPaise: input.roundOffPaise, lines: prepared.versions } };
  }, { readConcern: { level: "snapshot" } });
}
