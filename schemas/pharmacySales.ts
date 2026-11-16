import { object, identifier, whole, text } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { pharmacyCollectionInput } from "./pharmacyCollections.ts";
import { externalPrescriptionReference } from "./pharmacyExternalPrescriptions.ts";
export function pharmacySaleInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedInventoryMode", "externalPrescription", "confirmationMode", "includeDocument", "expectedProfileRevision", "expectedTotalPaise", "expectedQuoteHash", "customerId", "expectedCustomerRevision", "invoiceDiscountPaise", "roundOffPaise", "lines", "payment", "organizationId", "organization_id"]);
  if (body.expectedInventoryMode !== undefined && !["tracked", "billing_only"].includes(String(body.expectedInventoryMode))) throw new CommandError(400, "Invalid inventory mode");
  const currentTotal = body.confirmationMode === "current_total";
  if (body.confirmationMode !== undefined && !currentTotal || body.includeDocument !== undefined && body.includeDocument !== true || currentTotal && (body.expectedProfileRevision !== undefined || body.expectedQuoteHash !== undefined)) throw new CommandError(400, "Invalid counter confirmation mode");
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) throw new CommandError(400, "A counter invoice requires 1 to 100 product lines");
  const ids = new Set<string>(), products = new Set<string>();
  const lines = body.lines.map((rawLine: unknown) => {
    const line = object(rawLine, ["lineId", "medicineId", "quantity", "expectedUnitVersion", "expectedStockRevision", "expectedLineTotalPaise", "discountPaise"]), lineId = text(line.lineId, "sale line", 8, 100), medicineId = identifier(line.medicineId);
    const quantity = whole(line.quantity, "base quantity", Number.MAX_SAFE_INTEGER);
    if (!quantity || !/^[a-zA-Z0-9_-]+$/.test(lineId) || ids.has(lineId) || products.has(medicineId)) throw new CommandError(400, "Sale lines need distinct references/products and positive whole base quantities");
    ids.add(lineId); products.add(medicineId);
    if (currentTotal ? line.expectedStockRevision !== undefined : line.expectedLineTotalPaise !== undefined) throw new CommandError(400, "Invalid counter line confirmation");
    return { lineId, medicineId, quantity, expectedUnitVersion: whole(line.expectedUnitVersion, "unit version", Number.MAX_SAFE_INTEGER),
      expectedLineTotalPaise: currentTotal ? whole(line.expectedLineTotalPaise, "confirmed line amount") : undefined,
      expectedStockRevision: currentTotal ? undefined : whole(line.expectedStockRevision, "stock revision", Number.MAX_SAFE_INTEGER - 1), discountPaise: line.discountPaise === undefined ? 0 : whole(line.discountPaise, "line discount") };
  });
  const roundOffPaise = body.roundOffPaise === undefined ? 0 : body.roundOffPaise;
  if (!Number.isSafeInteger(roundOffPaise) || Math.abs(roundOffPaise) > 99 || body.customerId === undefined && body.expectedCustomerRevision !== undefined) throw new CommandError(400, "Invalid round-off or customer revision");
  if (body.expectedQuoteHash !== undefined && (typeof body.expectedQuoteHash !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedQuoteHash))) throw new CommandError(400, "Invalid quote reference");
  const payment = body.payment === undefined ? undefined : pharmacyCollectionInput(body.payment);
  if (payment && (payment.locationId !== body.locationId || payment.expectedPaymentRevision !== 0 || payment.expectedBalancePaise !== body.expectedTotalPaise ||
      payment.entries.reduce((sum, entry) => sum + entry.amountPaise, 0) !== body.expectedTotalPaise)) throw new CommandError(400, "Counter payment must settle this new bill's confirmed total");
  return { locationId: identifier(body.locationId), confirmationMode: currentTotal ? "current_total" as const : undefined, expectedProfileRevision: currentTotal ? undefined : whole(body.expectedProfileRevision, "issuer profile revision", Number.MAX_SAFE_INTEGER), expectedTotalPaise: whole(body.expectedTotalPaise, "confirmed total"),
    ...(body.includeDocument === true ? { includeDocument: true as const } : {}),
    ...(body.expectedInventoryMode !== undefined ? { expectedInventoryMode: body.expectedInventoryMode as "tracked" | "billing_only" } : {}),
    ...(body.externalPrescription !== undefined ? { externalPrescription: externalPrescriptionReference(body.externalPrescription) } : {}),
    ...(body.expectedQuoteHash !== undefined ? { expectedQuoteHash: body.expectedQuoteHash as string } : {}),
    ...(body.customerId !== undefined ? { customerId: identifier(body.customerId), expectedCustomerRevision: whole(body.expectedCustomerRevision, "customer revision", Number.MAX_SAFE_INTEGER - 1) } : {}),
    invoiceDiscountPaise: body.invoiceDiscountPaise === undefined ? 0 : whole(body.invoiceDiscountPaise, "invoice discount"), roundOffPaise: roundOffPaise as number, lines, ...(payment ? { payment } : {}) };
}

/** A quote accepts intent only; all prices, units and revisions come from current records. */
export function pharmacyQuoteInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedInventoryMode", "externalPrescription", "customerId", "invoiceDiscountPaise", "roundOffPaise", "lines", "organizationId", "organization_id"]);
  if (!Array.isArray(body.lines)) throw new CommandError(400, "Select product lines before requesting a quote");
  const normalized = pharmacySaleInput({ ...body, expectedProfileRevision: 0, expectedTotalPaise: 0,
    ...(body.customerId !== undefined ? { expectedCustomerRevision: 0 } : {}),
    lines: body.lines.map((rawLine: unknown) => {
      const line = object(rawLine, ["lineId", "medicineId", "quantity", "expectedUnitVersion", "discountPaise"]);
      return { ...line, expectedUnitVersion: whole(line.expectedUnitVersion, "displayed unit version", Number.MAX_SAFE_INTEGER), expectedStockRevision: 0 };
    }) });
  return normalized;
}
