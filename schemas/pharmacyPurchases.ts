import { CommandError } from "../services/CommandReceiptService.ts";

const invalid = (message: string): never => { throw new CommandError(400, message); };
export function object(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) return invalid("Unsupported or incomplete purchase fields");
  return input as Record<string, any>;
}
export function text(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) return invalid(`Invalid ${name}`);
  return value.trim();
}
export function identifier(value: unknown) { const result = text(value, "identifier", 24, 24); if (!/^[a-f\d]{24}$/i.test(result)) return invalid("Invalid identifier"); return result.toLowerCase(); }
export function whole(value: unknown, name: string, max = 100_000_000_000) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid(`Invalid ${name}; provide a bounded whole number`);
  return value;
}
export function calendarDate(value: unknown) {
  const date = text(value, "date", 10, 10), parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date < "2000-01-01" || date > "2199-12-31") return invalid("Invalid calendar date");
  return date;
}
export function partyInput(raw: unknown, editing: boolean) {
  const body = object(raw, ["locationId", "locationIds", "name", "kinds", "address", "phone", "email", "gstRegistration", "gstin", "licence", "archived", "expectedRevision", "organizationId", "organization_id"]);
  for (const key of ["phone", "email", "gstin"]) if (body[key] !== undefined && typeof body[key] !== "string") return invalid(`Invalid ${key}`);
  if (editing && (body.locationIds === undefined || typeof body.archived !== "boolean")) return invalid("A party edit must preserve explicit branch visibility and archive status");
  if (!Array.isArray(body.kinds) || !body.kinds.length || body.kinds.length > 2 || new Set(body.kinds).size !== body.kinds.length || body.kinds.some((value: unknown) => !["supplier", "customer"].includes(value as string))) return invalid("Select supplier, customer or both");
  if (!["registered", "unregistered"].includes(body.gstRegistration)) return invalid("Select the actual GST registration status");
  const gstin = body.gstRegistration === "registered" ? text(body.gstin, "GSTIN", 15, 15).toUpperCase() : undefined;
  if (gstin && !/^(0[1-9]|[12][0-9]|3[0-8])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) || !gstin && body.gstin) return invalid("GSTIN does not match the registration selection");
  let licence;
  if (body.licence !== undefined) { const value = object(body.licence, ["number", "validUntil"]); licence = { number: text(value.number, "supplier licence", 3, 80), ...(value.validUntil !== undefined ? { validUntil: calendarDate(value.validUntil) } : {}) }; }
  if (body.kinds.includes("supplier") && !licence) return invalid("Record the actual supplier licence number");
  const locationId = identifier(body.locationId);
  const locationIds = body.locationIds === undefined ? [locationId] : body.locationIds;
  if (!Array.isArray(locationIds) || !locationIds.length || locationIds.length > 100) return invalid("Select 1 to 100 visible branches");
  const locations = [...new Set(locationIds.map(identifier))].sort();
  if (!locations.includes(locationId)) return invalid("Party visibility must include the current branch");
  if (body.archived !== undefined && typeof body.archived !== "boolean") return invalid("Archived must be boolean");
  const phone = body.phone ? text(body.phone, "phone", 3, 30) : "", email = body.email ? text(body.email, "email", 3, 200) : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid("Invalid email");
  return { locationId, locationIds: locations, name: text(body.name, "party name", 2, 200), kinds: [...body.kinds].sort() as string[], address: text(body.address, "address", 3, 500), phone, email,
    gstRegistration: body.gstRegistration as "registered" | "unregistered", ...(gstin ? { gstin } : {}), ...(licence ? { licence } : {}), archived: body.archived ?? false,
    ...(editing ? { expectedRevision: whole(body.expectedRevision, "party revision", Number.MAX_SAFE_INTEGER - 1) } : {}) };
}
export function draftInput(raw: unknown, editing: boolean) {
  const body = object(raw, ["locationId", "supplierId", "expectedSupplierRevision", "supplierInvoiceNumber", "invoiceDate", "statedTotalPaise", "lines", "notes", "expectedRevision", "organizationId", "organization_id"]);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) return invalid("A purchase draft needs 1 to 100 lines");
  const seen = new Set<string>();
  const lines = body.lines.map((rawLine: unknown) => {
    const line = object(rawLine, ["lineId", "medicineId", "expectedUnitVersion", "packs", "looseUnits", "freePacks", "freeLooseUnits", "baseAmountPaise", "discountPaise", "gstRateBps", "hsnCode", "sellingPricePaise", "mrpPaise"]);
    const lineId = text(line.lineId, "line reference", 8, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(lineId) || seen.has(lineId)) return invalid("Each purchase line needs a distinct stable reference"); seen.add(lineId);
    const amount = whole(line.baseAmountPaise, "line amount"), discount = whole(line.discountPaise, "discount"), selling = whole(line.sellingPricePaise, "selling price"), mrp = line.mrpPaise === undefined ? undefined : whole(line.mrpPaise, "MRP");
    if (discount > amount || mrp !== undefined && selling > mrp) return invalid("Discount exceeds base amount or selling price exceeds MRP");
    const hsnCode = text(line.hsnCode, "HSN", 4, 8); if (!/^\d{4}(\d{2})?(\d{2})?$/.test(hsnCode)) return invalid("HSN must have 4, 6 or 8 digits");
    return { lineId, medicineId: identifier(line.medicineId), expectedUnitVersion: whole(line.expectedUnitVersion, "unit version", Number.MAX_SAFE_INTEGER),
      packs: whole(line.packs, "packs", Number.MAX_SAFE_INTEGER), looseUnits: whole(line.looseUnits, "loose units", Number.MAX_SAFE_INTEGER),
      freePacks: whole(line.freePacks, "free packs", Number.MAX_SAFE_INTEGER), freeLooseUnits: whole(line.freeLooseUnits, "free loose units", Number.MAX_SAFE_INTEGER),
      baseAmountPaise: amount, discountPaise: discount, gstRateBps: whole(line.gstRateBps, "GST basis points", 10000), hsnCode, sellingPricePaise: selling, ...(mrp !== undefined ? { mrpPaise: mrp } : {}) };
  });
  const invoiceDate = calendarDate(body.invoiceDate), year = Number(invoiceDate.slice(0, 4)) - (Number(invoiceDate.slice(5, 7)) < 4 ? 1 : 0);
  const invoiceNumber = text(body.supplierInvoiceNumber, "supplier invoice number", 1, 80).normalize("NFKC");
  if (/[\p{Cc}\p{Cf}]/u.test(invoiceNumber)) return invalid("Supplier invoice identity cannot contain hidden format or control characters");
  return { locationId: identifier(body.locationId), supplierId: identifier(body.supplierId), expectedSupplierRevision: whole(body.expectedSupplierRevision, "supplier revision", Number.MAX_SAFE_INTEGER),
    supplierInvoiceNumber: invoiceNumber, normalizedInvoiceNumber: invoiceNumber.toUpperCase().replace(/\s+/g, ""), invoiceDate, invoiceFY: `${year}-${year + 1}`,
    statedTotalPaise: whole(body.statedTotalPaise, "stated supplier total"), lines, notes: body.notes === undefined ? "" : text(body.notes, "notes", 0, 1000),
    ...(editing ? { expectedRevision: whole(body.expectedRevision, "draft revision", Number.MAX_SAFE_INTEGER - 1) } : {}) };
}
export function purchasePostingInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedRevision", "expectedSupplierRevision", "supplierStateCode", "taxMode", "costTreatment", "roundOffPaise", "reviewReference", "organizationId", "organization_id"]);
  const supplierStateCode = text(body.supplierStateCode, "supplier state", 2, 2);
  if (!/^(0[1-9]|[12][0-9]|3[0-8])$/.test(supplierStateCode) || !["sgst", "utgst", "igst"].includes(body.taxMode) || !["include_tax", "exclude_tax"].includes(body.costTreatment) ||
      !Number.isSafeInteger(body.roundOffPaise) || Math.abs(body.roundOffPaise) > 99) return invalid("Select reviewed supply state, tax mode, cost treatment and bounded explicit round-off");
  return { locationId: identifier(body.locationId), expectedRevision: whole(body.expectedRevision, "purchase revision", Number.MAX_SAFE_INTEGER - 1),
    expectedSupplierRevision: whole(body.expectedSupplierRevision, "supplier revision", Number.MAX_SAFE_INTEGER - 1), supplierStateCode,
    taxMode: body.taxMode as "sgst" | "utgst" | "igst", costTreatment: body.costTreatment as "include_tax" | "exclude_tax", roundOffPaise: body.roundOffPaise as number,
    reviewReference: text(body.reviewReference, "actual supplier/tax review reference", 3, 200) };
}
export function purchaseReceiptInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedRevision", "deliveryReference", "lines", "organizationId", "organization_id"]);
  const deliveryReference = text(body.deliveryReference, "delivery reference", 3, 100).normalize("NFKC");
  if (/[\p{Cc}\p{Cf}]/u.test(deliveryReference) || !Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) return invalid("Record an actual delivery reference and 1 to 100 receipt lines");
  const seen = new Set<string>();
  const lines = body.lines.map((rawLine: unknown) => {
    const line = object(rawLine, ["lineId", "purchaseLineId", "billedBaseUnits", "freeBaseUnits", "batchNumber", "expiry"]);
    const lineId = text(line.lineId, "delivery line", 8, 100), purchaseLineId = text(line.purchaseLineId, "purchase line", 8, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(lineId) || seen.has(lineId)) return invalid("Delivery lines need distinct stable references"); seen.add(lineId);
    const expiry = object(line.expiry, ["precision", "value"]);
    if (!["month", "day"].includes(expiry.precision)) return invalid("Record printed expiry precision");
    const billedBaseUnits = whole(line.billedBaseUnits, "received billed units", Number.MAX_SAFE_INTEGER), freeBaseUnits = whole(line.freeBaseUnits, "received free units", Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(billedBaseUnits + freeBaseUnits) || billedBaseUnits + freeBaseUnits <= 0) return invalid("Receipt quantities must be positive safe base units");
    return { lineId, purchaseLineId, billedBaseUnits, freeBaseUnits, batchNumber: text(line.batchNumber, "printed batch", 1, 100), expiry: { precision: expiry.precision as "month" | "day", value: text(expiry.value, "printed expiry", 7, 10) } };
  });
  return { locationId: identifier(body.locationId), expectedRevision: whole(body.expectedRevision, "purchase revision", Number.MAX_SAFE_INTEGER - 1),
    deliveryReference, normalizedDeliveryReference: deliveryReference.toUpperCase().replace(/\s+/g, ""), lines };
}
