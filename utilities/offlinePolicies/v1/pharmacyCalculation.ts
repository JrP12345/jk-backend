export class PharmacyCalculationError extends Error {}

export const PHARMACY_CALCULATION_POLICY = "pharmacy-paise-v2" as const;
export type PharmacyTaxMode = "sgst" | "utgst" | "igst" | "unallocated" | "none";
export interface RationalPaise { numeratorPaise: number; denominatorUnits: number }
export interface CalculationLine {
  lineId: string; quantity: number; unitPrice: RationalPaise; gstRateBps: number;
  lineDiscountPaise?: number; mrp?: RationalPaise;
}
export interface PharmacyCalculationInput {
  policy: typeof PHARMACY_CALCULATION_POLICY; currency: "INR";
  priceMode: "inclusive" | "exclusive"; taxMode: PharmacyTaxMode;
  lines: CalculationLine[]; invoiceDiscountPaise?: number; roundOffPaise?: number;
}
const invalid = (message: string): never => { throw new PharmacyCalculationError(message); };
function whole(value: number, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`Invalid ${label}: expected a bounded integer`);
  return BigInt(value);
}
function bounded(value: bigint) {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("Pharmacy calculation exceeds the supported monetary bound");
  return Number(value);
}
function halfUp(numerator: bigint, denominator: bigint) { return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2)); }
function rate(value: number) {
  const result = whole(value, "GST basis points");
  if (result > BigInt(10000)) invalid("Invalid GST basis points");
  return result;
}
function rational(value: RationalPaise) {
  if (!value) invalid("An explicit rational unit price is required");
  return { numerator: whole(value.numeratorPaise, "unit price"), denominator: whole(value.denominatorUnits, "price denominator", 1) };
}

/** Exact inclusive decomposition, also retained by the issued inclusive-paise-v1 adapter. */
export function splitPharmacyTax(amountPaise: number, gstRateBps: number, priceMode: "inclusive" | "exclusive", taxMode: PharmacyTaxMode) {
  const amount = whole(amountPaise, "line amount"), taxRate = rate(gstRateBps);
  if (!["inclusive", "exclusive"].includes(priceMode) || !["sgst", "utgst", "igst", "unallocated", "none"].includes(taxMode) || taxMode === "none" && taxRate !== BigInt(0)) invalid("Invalid pharmacy price or tax mode");
  const base = priceMode === "inclusive" ? halfUp(amount * BigInt(10000), BigInt(10000) + taxRate) : amount;
  const tax = priceMode === "inclusive" ? amount - base : halfUp(base * taxRate, BigInt(10000));
  // The second local component receives an odd tax paise, preserving v1 SGST rounding.
  return { baseAmountPaise: bounded(base), cgstPaise: taxMode === "sgst" || taxMode === "utgst" ? bounded(tax / BigInt(2)) : 0,
    sgstPaise: taxMode === "sgst" ? bounded(tax - tax / BigInt(2)) : 0,
    utgstPaise: taxMode === "utgst" ? bounded(tax - tax / BigInt(2)) : 0,
    igstPaise: taxMode === "igst" ? bounded(tax) : 0,
    unallocatedTaxPaise: taxMode === "unallocated" ? bounded(tax) : 0, grossAmountPaise: bounded(base + tax) };
}

/** Does no rate lookup or statutory approval. Callers supply the captured, reviewed policy. */
export function calculatePharmacyDocument(input: PharmacyCalculationInput) {
  if (!input || input.policy !== PHARMACY_CALCULATION_POLICY || input.currency !== "INR" ||
      !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 1000) invalid("Invalid pharmacy calculation policy, currency or lines");
  // Validate even zero-valued/zero-tax documents; no implicit jurisdiction or rate defaults.
  splitPharmacyTax(0, 0, input.priceMode, input.taxMode);
  const ids = new Set<string>();
  const prepared = input.lines.map(line => {
    if (!line || typeof line.lineId !== "string" || !line.lineId.trim() || line.lineId.length > 100 || ids.has(line.lineId)) invalid("Calculation lines require unique stable identifiers");
    ids.add(line.lineId);
    const quantity = whole(line.quantity, "base quantity", 1), price = rational(line.unitPrice), taxRate = rate(line.gstRateBps);
    if (input.taxMode === "none" && taxRate !== BigInt(0)) invalid("A non-collecting profile requires an explicit zero effective GST rate");
    const before = bounded(halfUp(price.numerator * quantity, price.denominator));
    const discount = whole(line.lineDiscountPaise === undefined ? 0 : line.lineDiscountPaise, "line discount");
    if (discount > BigInt(before)) invalid("Line discount exceeds its price basis");
    if (line.mrp !== undefined) {
      const mrp = rational(line.mrp);
      const taxFactor = input.priceMode === "inclusive" ? BigInt(10000) : BigInt(10000) + taxRate;
      if (price.numerator * taxFactor * mrp.denominator > mrp.numerator * price.denominator * BigInt(10000)) invalid("Tax-inclusive unit price exceeds captured MRP");
      // Whole-paise rounding must also stay inside the exact extended MRP cap.
      const gross = splitPharmacyTax(before, line.gstRateBps, input.priceMode, input.taxMode).grossAmountPaise;
      if (BigInt(gross) * mrp.denominator > mrp.numerator * quantity) invalid("Rounded tax-inclusive line price exceeds captured MRP");
    }
    return { line, before, discount: Number(discount), remaining: BigInt(before) - discount };
  });
  const remaining = prepared.reduce((sum, line) => sum + line.remaining, BigInt(0));
  bounded(remaining);
  const invoiceDiscount = whole(input.invoiceDiscountPaise === undefined ? 0 : input.invoiceDiscountPaise, "invoice discount");
  if (invoiceDiscount > remaining) invalid("Invoice discount exceeds the remaining price basis");
  const allocations = prepared.map(row => ({ id: row.line.lineId,
    allocated: remaining ? invoiceDiscount * row.remaining / remaining : BigInt(0),
    remainder: remaining ? invoiceDiscount * row.remaining % remaining : BigInt(0) }));
  let leftover = invoiceDiscount - allocations.reduce((sum, row) => sum + row.allocated, BigInt(0));
  // Stable ID, rather than array order or locale, breaks equal-remainder ties.
  for (const row of [...allocations].sort((a, b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.remainder > b.remainder ? -1 : 1)) {
    if (!leftover) break;
    row.allocated += BigInt(1); leftover -= BigInt(1);
  }
  const lines = prepared.map((row, index) => ({ lineId: row.line.lineId, quantity: row.line.quantity, gstRateBps: row.line.gstRateBps,
    amountBeforeDiscountPaise: row.before, lineDiscountPaise: row.discount, invoiceDiscountPaise: Number(allocations[index].allocated),
    ...splitPharmacyTax(Number(row.remaining - allocations[index].allocated), row.line.gstRateBps, input.priceMode, input.taxMode) }));
  const sum = (field: Exclude<keyof typeof lines[number], "lineId">) => bounded(lines.reduce((total, line) => total + BigInt(line[field]), BigInt(0)));
  const roundOffPaise = input.roundOffPaise === undefined ? 0 : input.roundOffPaise;
  if (!Number.isSafeInteger(roundOffPaise) || Math.abs(roundOffPaise) > 99) invalid("Explicit round-off must be an integer between -99 and 99 paise");
  const grossAmountPaise = sum("grossAmountPaise");
  const totals = { amountBeforeDiscountPaise: sum("amountBeforeDiscountPaise"), lineDiscountPaise: sum("lineDiscountPaise"), invoiceDiscountPaise: Number(invoiceDiscount),
    baseAmountPaise: sum("baseAmountPaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), utgstPaise: sum("utgstPaise"), igstPaise: sum("igstPaise"),
    unallocatedTaxPaise: sum("unallocatedTaxPaise"), grossAmountPaise, roundOffPaise,
    payablePaise: bounded(BigInt(grossAmountPaise) + BigInt(roundOffPaise)) };
  return { policy: PHARMACY_CALCULATION_POLICY, currency: "INR" as const, priceMode: input.priceMode, taxMode: input.taxMode, lines, totals };
}
export type PharmacyCalculation = ReturnType<typeof calculatePharmacyDocument>;

/** Reverse captured components; never re-price a return using today's tax or catalogue. */
export function allocateSourceCredit(lines: Array<{ lineId: string; quantity: number; baseAmountPaise: number; cgstPaise: number; sgstPaise: number;
  lots: Array<{ batchId: string; quantity: number; unitPricePaise: number }> }>, payablePaise: number) {
  const allocate = (amount: number, rows: Array<{ id: string; weight: bigint }>) => {
    const total = rows.reduce((sum, row) => sum + row.weight, BigInt(0)), value = whole(amount, "captured credit basis");
    if (!total && value) invalid("Captured credit basis has no allocation weight");
    const parts = rows.map(row => ({ id: row.id, amount: total ? value * row.weight / total : BigInt(0), remainder: total ? value * row.weight % total : BigInt(0) }));
    let remaining = value - parts.reduce((sum, row) => sum + row.amount, BigInt(0));
    for (const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id, "en") : a.remainder > b.remainder ? -1 : 1)) { if (!remaining) break; part.amount++; remaining--; }
    return new Map(parts.map(part => [part.id, bounded(part.amount)]));
  };
  const ids = new Set<string>(), result: Array<{ lineId: string; batchId: string; quantity: number; baseAmountPaise: number; cgstPaise: number; sgstPaise: number; grossAmountPaise: number; payablePaise: number }> = [];
  for (const line of lines) {
    whole(line.quantity, "captured quantity", 1);
    if (!line.lineId || ids.has(line.lineId) || !line.lots.length || new Set(line.lots.map(lot => lot.batchId)).size !== line.lots.length || line.lots.reduce((sum, lot) => sum + BigInt(lot.quantity), BigInt(0)) !== BigInt(line.quantity)) invalid("Captured return source quantities do not reconcile");
    ids.add(line.lineId);
    const weights = line.lots.map(lot => ({ id: lot.batchId, weight: whole(lot.quantity, "captured lot quantity", 1) * whole(lot.unitPricePaise, "captured selling price") }));
    const base = allocate(line.baseAmountPaise, weights), cgst = allocate(line.cgstPaise, weights), sgst = allocate(line.sgstPaise, weights);
    for (const lot of line.lots) { const b = base.get(lot.batchId)!, c = cgst.get(lot.batchId)!, s = sgst.get(lot.batchId)!;
      result.push({ lineId: line.lineId, batchId: lot.batchId, quantity: lot.quantity, baseAmountPaise: b, cgstPaise: c, sgstPaise: s, grossAmountPaise: b + c + s, payablePaise: 0 });
    }
  }
  const anyGross = result.some(row => row.grossAmountPaise > 0);
  const payable = allocate(payablePaise, result.map(row => ({ id: `${row.lineId}:${row.batchId}`, weight: BigInt(anyGross ? row.grossAmountPaise : row.quantity) })));
  return result.map(row => ({ ...row, payablePaise: payable.get(`${row.lineId}:${row.batchId}`)! }));
}
export function cumulativeSourceCredit(source: { quantity: number; baseAmountPaise: number; cgstPaise: number; sgstPaise: number; payablePaise: number }, before: number, quantity: number) {
  const maximum = whole(source.quantity, "sold quantity", 1), start = whole(before, "previous returned quantity"), count = whole(quantity, "returned quantity", 1);
  if (start + count > maximum) invalid("Return exceeds the remaining sold quantity");
  const delta = (amount: number) => { const basis = whole(amount, "captured credit component"); return bounded(basis * (start + count) / maximum - basis * start / maximum); };
  const baseAmountPaise = delta(source.baseAmountPaise), cgstPaise = delta(source.cgstPaise), sgstPaise = delta(source.sgstPaise), payablePaise = delta(source.payablePaise);
  const grossAmountPaise = baseAmountPaise + cgstPaise + sgstPaise;
  return { baseAmountPaise, cgstPaise, sgstPaise, grossAmountPaise, payablePaise, roundOffPaise: payablePaise - grossAmountPaise };
}
