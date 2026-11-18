import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { pharmacyQuoteInput, pharmacySaleInput } from "../schemas/pharmacySales.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, commandHash } from "./CommandReceiptService.ts";
import { loadPharmacyIssuer, pricePharmacySupply } from "./PharmacyDocumentService.ts";
import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";
import { prepareCounterStock, type CounterStockPreparation } from "./PharmacyInventoryService.ts";
import { createCapturedLotValidator } from "../utilities/pharmacyLot.ts";
import { toPaise } from "../utilities/pharmacyTax.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { authorizeExternalSale, reviewedExternalMedicine } from "./PharmacyExternalPrescriptionService.ts";
import { pharmacyInventoryMode, normalizeBillingSupply } from "../utilities/pharmacyInventoryMode.ts";
import { lotExpiry } from "../utilities/pharmacyLot.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { assertSaleAllowed } from "../utilities/pharmacySaleControl.ts";

type SaleInput = ReturnType<typeof pharmacySaleInput>;
type Scope = { organizationId: string; locationId: string };
type SupplyAllocation = { batchId?: string; batchNumber: string; expiryDate: Date; quantity: number; unitPrice: number; hsnCode: string; gstRate?: number; mrpPaise: number; expiryPrecision: string; expiryValue: string };
/** Read-only preparation used by both the provisional quote and committed issue. */
export async function prepareCounterSale(input: SaleInput, scope: Scope, issuer: any, session: mongoose.ClientSession | null, enforceVersions: boolean, external?: Awaited<ReturnType<typeof authorizeExternalSale>>, retainStock = false) {
  const branch = await pharmacyInventoryMode(scope.locationId, session), billingOnly = branch.mode === "billing_only";
  if ((input.expectedInventoryMode || "tracked") !== branch.mode) throw new CommandError(409, "Branch inventory mode changed; reload the counter before saving");
  const captured: any[] = [], versions: Array<{ lineId: string; medicineId: string; expectedUnitVersion: number; expectedStockRevision: number; quantity: number; discountPaise: number }> = [];
  const stockPreparations = new Map<string, CounterStockPreparation>();
  const validateLot = createCapturedLotValidator();
  const medicines = await Medicine.find({ _id: { $in: input.lines.map(line => line.medicineId) }, locationId: scope.locationId, deletedAt: null }).session(session);
  const byId = new Map(medicines.map(medicine => [String(medicine._id), medicine]));
  for (const line of input.lines) {
    const medicine = byId.get(line.medicineId);
    if (medicine) assertSaleAllowed(medicine);
    if (!medicine?.unitDefinition || medicine.unitDefinition.version !== line.expectedUnitVersion || !billingOnly && enforceVersions && medicine.stockRevision !== line.expectedStockRevision) throw new CommandError(409, "Product, units or stock changed; refresh the sale");
    if (external ? !reviewedExternalMedicine(medicine) || !external.document.lines.some(allowed => allowed.medicineId === line.medicineId && allowed.expectedDispensingRevision === medicine.dispensingRevision && allowed.expectedUnitVersion === line.expectedUnitVersion && line.quantity <= allowed.quantity - allowed.supplied) : medicine.scheduleType !== "general" || medicine.dispensingReview?.scheduleType !== "general" || !medicine.dispensingReview.confirmedAt || !medicine.dispensingReview.confirmedBy || !medicine.dispensingReview.reviewReference || medicine.dispensingRevision < 1) throw new CommandError(409, "Only reviewed ordinary products can use patient-optional counter issue; prescribed or restricted supplies need their authorized workflow");
    let allocations: SupplyAllocation[];
    if (billingOnly) {
      if (!medicine.billingSupply) throw new CommandError(409, `Record billing supply batch, expiry and MRP for ${medicine.name} in the catalogue`);
      const stored = medicine.billingSupply;
      const supply = normalizeBillingSupply({ batchNumber: stored.batchNumber, expiry: { precision: stored.expiry?.precision, value: stored.expiry?.value }, mrpPaise: stored.mrpPaise }), expiry = lotExpiry(supply.expiry, branch.timezone), pricePaise = toPaise(medicine.price);
      if (expiry.cutoff.getTime() <= Date.now() || pricePaise > supply.mrpPaise) throw new CommandError(409, "Billing supply is expired or current selling price exceeds MRP; correct the catalogue");
      if (retainStock) {
        requireStockTransaction(session);
        // A write conflict retries all fresh evidence. This technical lock changes no business
        // fields and bypasses document UPDATE auditing; the issued supply has its required audit.
        const pinned = await Medicine.collection.updateOne({ _id: medicine._id, locationId: new mongoose.Types.ObjectId(scope.locationId) }, { $inc: { __v: 1 } }, { session: session! });
        if (pinned.matchedCount !== 1) throw new CommandError(409, "Catalogue product changed; reload the sale");
      }
      allocations = [{ batchNumber: supply.batchNumber, expiryDate: expiry.cutoff, quantity: line.quantity, unitPrice: medicine.price, hsnCode: medicine.hsnCode, gstRate: medicine.gstRate,
        mrpPaise: supply.mrpPaise, expiryPrecision: expiry.precision, expiryValue: expiry.value }];
    } else {
      const { selected, preparation } = await prepareCounterStock(medicine, scope, line.quantity, session, retainStock, validateLot);
      if (preparation) stockPreparations.set(line.lineId, preparation);
      if (selected.some(({ batch }) => batch.mrpPaise === undefined || batch.sellingPricePaise! > batch.mrpPaise)) throw new CommandError(409, "Counter issue requires reviewed unit prices and MRP");
      allocations = selected.map(({ batch, quantity }) => ({ batchId: String(batch._id), batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantity, unitPrice: batch.sellingPrice, hsnCode: batch.hsnCode || "", gstRate: batch.gstRate,
        mrpPaise: batch.mrpPaise!, expiryPrecision: batch.expirySnapshot!.precision, expiryValue: batch.expirySnapshot!.value }));
    }
    const priced = pricePharmacySupply(medicine, allocations, issuer), unit = medicine.unitDefinition;
    captured.push({ calculationLineId: line.lineId, medicineId: medicine._id, description: medicine.name, quantity: line.quantity,
      unitSnapshot: { version: unit.version, baseUnit: unit.baseUnit, packUnit: unit.packUnit, unitsPerPack: unit.unitsPerPack },
      ...priced, discountPaise: line.discountPaise, prescriptions: [], batches: billingOnly ? [] : allocations.map(({ batchId, batchNumber, quantity }) => ({ batchId, batchNumber, quantity })),
      pricingAllocations: allocations.map(lot => ({ ...lot, unitPrice: toPaise(lot.unitPrice) / 100 })),
    });
    versions.push({ ...line, medicineId: String(medicine._id), expectedUnitVersion: unit.version, expectedStockRevision: billingOnly ? 0 : medicine.stockRevision });
  }
  const calculation = calculatePharmacyDocument({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "inclusive", taxMode: issuer.registration === "regular" ? "sgst" : "none", invoiceDiscountPaise: input.invoiceDiscountPaise, roundOffPaise: input.roundOffPaise,
    lines: captured.map(line => ({ lineId: line.calculationLineId, quantity: line.quantity, unitPrice: { numeratorPaise: line.grossAmountPaise, denominatorUnits: line.quantity }, lineDiscountPaise: line.discountPaise, gstRateBps: Math.round(line.gstRate * 100) })) });
  const quoteHash = commandHash({ locationId: scope.locationId, inventoryMode: branch.mode, externalPrescription: input.externalPrescription || null, issuerRevision: issuer.revision, customerId: input.customerId || null, customerRevision: input.expectedCustomerRevision ?? null, versions,
    lines: captured.map(line => ({ ...line, medicineId: String(line.medicineId), pricingAllocations: line.pricingAllocations.map((lot: any) => ({ ...lot, expiryDate: lot.expiryDate.toISOString() })) })), calculation });
  return { captured, calculation, versions, quoteHash, stockPreparations, inventoryMode: branch.mode };
}
export async function quoteCounterSale(req: FastifyRequest) {
  const input = pharmacyQuoteInput(req.body), scope = await purchaseScope(req, input.locationId);
  return withTransaction(async session => {
    const external = input.externalPrescription ? await authorizeExternalSale(req, scope, input.externalPrescription, input.lines) : undefined;
    const issuer = await loadPharmacyIssuer(scope.organizationId, scope.locationId, true);
    let customer: { id: string; revision: number; name: string } | null = null;
    if (input.customerId) {
      const party = await PharmacyParty.findOne({ _id: input.customerId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer", archived: false }).session(session);
      if (!party || party.gstin) throw new CommandError(409, "Customer unavailable or requires a separately reviewed B2B workflow");
      customer = { id: String(party._id), revision: party.revision, name: party.name };
      input.expectedCustomerRevision = party.revision;
    }
    const prepared = await prepareCounterSale(input, scope, issuer, session, false, external);
    if (prepared.calculation.totals.payablePaise >= 5_000_000 && !customer) throw new CommandError(409, "Select a recorded customer with actual name/address for this high-value invoice");
    return { locationId: scope.locationId, currency: "INR", quoteHash: prepared.quoteHash, customer, calculation: prepared.calculation,
      lines: prepared.captured.map(line => ({ lineId: line.calculationLineId, medicineId: String(line.medicineId), description: line.description, quantity: line.quantity, unitSnapshot: line.unitSnapshot,
        batches: line.pricingAllocations.map((lot: any) => ({ batchId: lot.batchId, batchNumber: lot.batchNumber, quantity: lot.quantity, expiryValue: lot.expiryValue, expiryPrecision: lot.expiryPrecision, sellingPricePaise: toPaise(lot.unitPrice), mrpPaise: lot.mrpPaise })) })),
      issueInput: { locationId: scope.locationId, expectedInventoryMode: prepared.inventoryMode, expectedProfileRevision: issuer.revision, expectedTotalPaise: prepared.calculation.totals.payablePaise, expectedQuoteHash: prepared.quoteHash,
        ...(input.externalPrescription ? { externalPrescription: input.externalPrescription } : {}),
        ...(customer ? { customerId: customer.id, expectedCustomerRevision: customer.revision } : {}), invoiceDiscountPaise: input.invoiceDiscountPaise, roundOffPaise: input.roundOffPaise, lines: prepared.versions } };
  }, { readConcern: { level: "snapshot" } });
}
