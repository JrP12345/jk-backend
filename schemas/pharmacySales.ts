import { object, identifier, whole, text } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export function pharmacySaleInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedProfileRevision", "expectedTotalPaise", "expectedQuoteHash", "customerId", "expectedCustomerRevision", "invoiceDiscountPaise", "roundOffPaise", "lines", "organizationId", "organization_id"]);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) throw new CommandError(400, "A counter invoice requires 1 to 100 product lines");
  const ids = new Set<string>(), products = new Set<string>();
  const lines = body.lines.map((rawLine: unknown) => {
    const line = object(rawLine, ["lineId", "medicineId", "quantity", "expectedUnitVersion", "expectedStockRevision", "discountPaise"]), lineId = text(line.lineId, "sale line", 8, 100), medicineId = identifier(line.medicineId);
    const quantity = whole(line.quantity, "base quantity", Number.MAX_SAFE_INTEGER);
    if (!quantity || !/^[a-zA-Z0-9_-]+$/.test(lineId) || ids.has(lineId) || products.has(medicineId)) throw new CommandError(400, "Sale lines need distinct references/products and positive whole base quantities");
    ids.add(lineId); products.add(medicineId);
    return { lineId, medicineId, quantity, expectedUnitVersion: whole(line.expectedUnitVersion, "unit version", Number.MAX_SAFE_INTEGER), expectedStockRevision: whole(line.expectedStockRevision, "stock revision", Number.MAX_SAFE_INTEGER - 1), discountPaise: line.discountPaise === undefined ? 0 : whole(line.discountPaise, "line discount") };
  });
  const roundOffPaise = body.roundOffPaise === undefined ? 0 : body.roundOffPaise;
  if (!Number.isSafeInteger(roundOffPaise) || Math.abs(roundOffPaise) > 99 || body.customerId === undefined && body.expectedCustomerRevision !== undefined) throw new CommandError(400, "Invalid round-off or customer revision");
  if (body.expectedQuoteHash !== undefined && (typeof body.expectedQuoteHash !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedQuoteHash))) throw new CommandError(400, "Invalid quote reference");
  return { locationId: identifier(body.locationId), expectedProfileRevision: whole(body.expectedProfileRevision, "issuer profile revision", Number.MAX_SAFE_INTEGER), expectedTotalPaise: whole(body.expectedTotalPaise, "confirmed total"),
    ...(body.expectedQuoteHash !== undefined ? { expectedQuoteHash: body.expectedQuoteHash as string } : {}),
    ...(body.customerId !== undefined ? { customerId: identifier(body.customerId), expectedCustomerRevision: whole(body.expectedCustomerRevision, "customer revision", Number.MAX_SAFE_INTEGER - 1) } : {}),
    invoiceDiscountPaise: body.invoiceDiscountPaise === undefined ? 0 : whole(body.invoiceDiscountPaise, "invoice discount"), roundOffPaise: roundOffPaise as number, lines };
}

/** A quote accepts intent only; all prices, units and revisions come from current records. */
export function pharmacyQuoteInput(raw: unknown) {
  const body = object(raw, ["locationId", "customerId", "invoiceDiscountPaise", "roundOffPaise", "lines", "organizationId", "organization_id"]);
  if (!Array.isArray(body.lines)) throw new CommandError(400, "Select product lines before requesting a quote");
  const normalized = pharmacySaleInput({ ...body, expectedProfileRevision: 0, expectedTotalPaise: 0,
    ...(body.customerId !== undefined ? { expectedCustomerRevision: 0 } : {}),
    lines: body.lines.map((rawLine: unknown) => {
      const line = object(rawLine, ["lineId", "medicineId", "quantity", "expectedUnitVersion", "discountPaise"]);
      return { ...line, expectedUnitVersion: whole(line.expectedUnitVersion, "displayed unit version", Number.MAX_SAFE_INTEGER), expectedStockRevision: 0 };
    }) });
  return normalized;
}
