import { describe, expect, it } from "vitest";
import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY, type CalculationLine, type PharmacyCalculationInput } from "../services/InvoiceCalculationService.ts";
import { inclusiveTax } from "../utilities/pharmacyTax.ts";
import { pricePharmacySupply } from "../services/PharmacyDocumentService.ts";

const line = (lineId: string, amount: number, gstRateBps = 0): CalculationLine => ({ lineId, quantity: 1, unitPrice: { numeratorPaise: amount, denominatorUnits: 1 }, gstRateBps });
const input = (lines = [line("a", 10500, 500)], extra: Partial<PharmacyCalculationInput> = {}): PharmacyCalculationInput => ({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "inclusive", taxMode: "sgst", lines, ...extra });
const calculate = (lines?: CalculationLine[], extra?: Partial<PharmacyCalculationInput>) => calculatePharmacyDocument(input(lines, extra));

describe("Versioned pharmacy financial calculations (synthetic review fixtures)", () => {
  it("matches inclusive sale, exclusive discounted purchase and positive credit examples", () => {
    expect(calculate().totals).toMatchObject({ baseAmountPaise: 10000, cgstPaise: 250, sgstPaise: 250, grossAmountPaise: 10500, payablePaise: 10500 });
    expect(calculate([{ ...line("purchase", 12000, 1800), lineDiscountPaise: 2000 }], { priceMode: "exclusive", taxMode: "unallocated" }).totals)
      .toMatchObject({ amountBeforeDiscountPaise: 12000, lineDiscountPaise: 2000, baseAmountPaise: 10000, unallocatedTaxPaise: 1800, grossAmountPaise: 11800 });
    // A credit uses the source's captured price/rate, as a positive magnitude; source caps belong to T19.
    expect(calculate([line("source-credit", 5250, 500)]).totals).toMatchObject({ baseAmountPaise: 5000, cgstPaise: 125, sgstPaise: 125, payablePaise: 5250 });
  });
  it("applies invoice discounts before tax on mixed inclusive rates", () => {
    const result = calculate([line("18", 11800, 1800), line("5", 10500, 500)], { invoiceDiscountPaise: 2230 });
    expect(result.lines.map(row => [row.invoiceDiscountPaise, row.baseAmountPaise, row.grossAmountPaise])).toEqual([[1180, 9000, 10620], [1050, 9000, 9450]]);
    expect(result.totals).toMatchObject({ invoiceDiscountPaise: 2230, baseAmountPaise: 18000, cgstPaise: 1035, sgstPaise: 1035, payablePaise: 20070 });
  });
  it("allocates an invoice paise by stable ID regardless of line order, after line discounts", () => {
    const rows = [{ ...line("c", 2), lineDiscountPaise: 1 }, line("b", 1), line("a", 1)];
    const first = calculate(rows, { invoiceDiscountPaise: 1 }), second = calculate([...rows].reverse(), { invoiceDiscountPaise: 1 });
    const allocations = (result: typeof first) => Object.fromEntries(result.lines.map(row => [row.lineId, row.invoiceDiscountPaise]));
    expect(allocations(first)).toEqual({ a: 1, b: 0, c: 0 }); expect(allocations(second)).toEqual(allocations(first));
    expect(first.totals).toMatchObject({ lineDiscountPaise: 1, invoiceDiscountPaise: 1, payablePaise: 2 });
  });
  it("multiplies rational pack costs before rounding the line", () => {
    expect(calculate([{ ...line("thirds", 100), quantity: 3, unitPrice: { numeratorPaise: 100, denominatorUnits: 3 } }]).totals.payablePaise).toBe(100);
    expect(calculate([{ ...line("half", 1), quantity: 1, unitPrice: { numeratorPaise: 1, denominatorUnits: 2 } }]).totals.payablePaise).toBe(1);
    // Eight billed plus two free units retain the actual acquisition total (not a rounded unit cost).
    expect(calculate([{ ...line("free", 101), quantity: 10, unitPrice: { numeratorPaise: 101, denominatorUnits: 10 } }]).totals.payablePaise).toBe(101);
  });
  it("preserves explicit zero rates, free lines and full discounts", () => {
    expect(calculate([line("zero-rate", 100)], { taxMode: "none" }).totals).toMatchObject({ baseAmountPaise: 100, cgstPaise: 0, sgstPaise: 0 });
    expect(calculate([line("free", 0, 1800)]).totals.payablePaise).toBe(0);
    expect(calculate([line("discounted", 11800, 1800)], { invoiceDiscountPaise: 11800 }).totals).toMatchObject({ baseAmountPaise: 0, cgstPaise: 0, sgstPaise: 0, payablePaise: 0 });
    expect(calculate([{ ...line("discounted", 11800, 1800), lineDiscountPaise: 11800 }]).totals.payablePaise).toBe(0);
  });
  it.each(["sgst", "utgst", "igst", "unallocated"] as const)("keeps odd tax paise exact for %s", taxMode => {
    const row = calculate([line("odd", 10001, 1800)], { taxMode }).lines[0];
    expect(row.baseAmountPaise).toBe(8475);
    expect(row.cgstPaise + row.sgstPaise + row.utgstPaise + row.igstPaise + row.unallocatedTaxPaise).toBe(1526);
    const odd = calculate([line("odd", 7, 1800)], { taxMode }).lines[0];
    expect(odd.baseAmountPaise).toBe(6);
    expect(odd).toMatchObject({ cgstPaise: 0, sgstPaise: taxMode === "sgst" ? 1 : 0, utgstPaise: taxMode === "utgst" ? 1 : 0, igstPaise: taxMode === "igst" ? 1 : 0, unallocatedTaxPaise: taxMode === "unallocated" ? 1 : 0 });
  });
  it("requires explicit bounded round-off without silently matching a stated total", () => {
    expect(calculate(undefined, { roundOffPaise: -1 }).totals).toMatchObject({ grossAmountPaise: 10500, roundOffPaise: -1, payablePaise: 10499 });
    expect(calculate(undefined, { roundOffPaise: 49 }).totals.payablePaise).toBe(10549);
    expect(() => calculate([line("zero", 0)], { roundOffPaise: -1 })).toThrow(/bound/);
  });
  it("checks the captured tax-inclusive MRP before discounts and before lossy rounding", () => {
    expect(calculate([{ ...line("cap", 10000, 1800), mrp: { numeratorPaise: 11800, denominatorUnits: 1 } }], { priceMode: "exclusive" }).totals.payablePaise).toBe(11800);
    expect(() => calculate([{ ...line("cap", 10001, 1800), lineDiscountPaise: 10001, mrp: { numeratorPaise: 11800, denominatorUnits: 1 } }], { priceMode: "exclusive" })).toThrow(/MRP/);
    expect(() => calculate([{ ...line("rounded", 1), unitPrice: { numeratorPaise: 1, denominatorUnits: 2 }, mrp: { numeratorPaise: 1, denominatorUnits: 2 } }])).toThrow(/MRP/);
  });
  it("reconciles mixed-rate discounts and tax components over boundary fixtures", () => {
    for (const priceMode of ["inclusive", "exclusive"] as const) for (const amount of [0, 1, 2, 3, 7, 99, 101, 10001, 99999999]) {
      const result = calculate([line("a", amount, 1800), line("b", amount + 1, 500), line("c", amount, 0)], { priceMode, invoiceDiscountPaise: amount });
      expect(result.lines.reduce((sum, row) => sum + row.invoiceDiscountPaise, 0)).toBe(amount);
      const t = result.totals;
      expect(t.baseAmountPaise + t.cgstPaise + t.sgstPaise + t.utgstPaise + t.igstPaise + t.unallocatedTaxPaise).toBe(t.grossAmountPaise);
      expect(result.lines.reduce((sum, row) => sum + row.grossAmountPaise, 0)).toBe(t.payablePaise);
      for (const row of result.lines) expect(row.invoiceDiscountPaise).toBeLessThanOrEqual(row.amountBeforeDiscountPaise - row.lineDiscountPaise);
    }
  });
  it.each([
    { policy: "future-version" }, { currency: "USD" }, { priceMode: "unknown" }, { taxMode: "unknown" }, { lines: [] },
    { invoiceDiscountPaise: -1 }, { invoiceDiscountPaise: 10501 }, { invoiceDiscountPaise: NaN }, { invoiceDiscountPaise: null },
    { roundOffPaise: 100 }, { roundOffPaise: 0.5 }, { roundOffPaise: null }, { taxMode: "none" },
    ...[NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100", null].map(amount => ({ lines: [{ ...line("invalid", 1), unitPrice: { numeratorPaise: amount, denominatorUnits: 1 } }] })),
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(quantity => ({ lines: [{ ...line("invalid", 1), quantity }] })),
    { lines: [{ ...line("invalid", 1), unitPrice: { numeratorPaise: 1, denominatorUnits: 0 } }] },
    { lines: [{ ...line("invalid", 1), gstRateBps: 0.5 }] }, { lines: [{ ...line("invalid", 1), gstRateBps: 10001 }] },
    { lines: [{ ...line("invalid", 1), lineDiscountPaise: 2 }] }, { lines: [{ ...line("invalid", 1), lineDiscountPaise: null }] },
    { lines: [{ ...line("invalid", 1), mrp: null }] }, { lines: [line("same", 1), line("same", 1)] },
    { lines: [{ ...line("overflow", Number.MAX_SAFE_INTEGER), quantity: 2 }] },
    { lines: [line("overflow-a", Number.MAX_SAFE_INTEGER), line("overflow-b", 1)] },
    { priceMode: "exclusive", lines: [line("tax-overflow", Number.MAX_SAFE_INTEGER, 10000)] },
  ])("rejects malformed, negative, fractional and overflowing financial inputs %#", patch => {
    expect(() => calculatePharmacyDocument({ ...input(), ...patch } as PharmacyCalculationInput)).toThrow();
  });
  it("retains every legacy inclusive-paise-v1 result, including safe-integer limits", () => {
    for (const gross of [0, 1, 3, 7, 105, 199, 10001, Number.MAX_SAFE_INTEGER]) for (const gstRate of [0, 5, 12, 18, 28, 100]) {
      const divisor = BigInt(10000 + gstRate * 100), base = Number((BigInt(gross) * 10000n + divisor / 2n) / divisor), tax = gross - base;
      expect(inclusiveTax(gross, gstRate)).toEqual({ baseAmountPaise: base, cgstPaise: Math.floor(tax / 2), sgstPaise: tax - Math.floor(tax / 2), grossAmountPaise: gross });
    }
  });
  it("prices captured lot allocations once under legacy rounding and rejects corrupt quantities", () => {
    const medicine = { hsnCode: "300490", gstRate: 18, taxClassification: { confirmedAt: new Date(), confirmedBy: "reviewer", reviewReference: "Synthetic", hsnCode: "300490", gstRate: 18, treatment: "taxable", unitCode: "NOS" } };
    const allocation = { quantity: 1, unitPrice: 0.07, hsnCode: "300490", gstRate: 18 }, issuer = { minimumHsnDigits: 6, registration: "regular" };
    expect(pricePharmacySupply(medicine, [allocation, allocation], issuer)).toMatchObject(inclusiveTax(14, 18));
    expect(pricePharmacySupply(medicine, [allocation], { ...issuer, registration: "composition" })).toMatchObject({ baseAmountPaise: 7, cgstPaise: 0, sgstPaise: 0, gstRate: 0 });
    expect(() => pricePharmacySupply(medicine, [{ ...allocation, quantity: 0.5 }], issuer)).toThrow(/quantities/);
    expect(() => pricePharmacySupply(medicine, [], issuer)).toThrow(/allocations/);
  });
});
