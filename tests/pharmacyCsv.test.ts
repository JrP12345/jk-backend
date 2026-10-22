import { describe, expect, it } from "vitest";
import { parsePharmacyCsv, csvWhole, csvPaise, PHARMACY_CSV_LIMITS } from "../utilities/pharmacyCsv.ts";

describe("Bounded pharmacy import CSV parsing", () => {
  it("preserves BOM, quoted commas/quotes/newlines, leading-zero identities and formula text as literal data", () => {
    const csv = '\uFEFFSource,Name,Barcode,Cost\r\n001,"Sample, ""quoted""\r\nproduct",000123,0.29\r\n002,=SUM(A1:A2),000004,1\r\n';
    expect(parsePharmacyCsv(csv)).toEqual({ headers: ["Source", "Name", "Barcode", "Cost"], records: [
      { sourceLine: 2, cells: { Source: "001", Name: 'Sample, "quoted"\nproduct', Barcode: "000123", Cost: "0.29" } },
      { sourceLine: 4, cells: { Source: "002", Name: "=SUM(A1:A2)", Barcode: "000004", Cost: "1" } },
    ] });
  });
  it("supports an exact final row without a newline and explicit empty trailing columns", () => {
    expect(parsePharmacyCsv('a,b,c\nfirst,,""').records).toEqual([{ sourceLine: 2, cells: { a: "first", b: "", c: "" } }]);
    expect(parsePharmacyCsv("a,b\r\none,two\r\n\r\n").records).toHaveLength(1);
  });
  it("handles prototype-named headers as literal own fields without mutating prototypes", () => {
    const record = parsePharmacyCsv("__proto__,constructor\none,two").records[0].cells;
    expect(Object.hasOwn(record, "__proto__")).toBe(true); expect(record["__proto__"]).toBe("one");
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
  });
  it("rejects unpaired surrogate text through direct JSON calls while retaining real non-BMP Unicode", () => {
    expect(() => parsePharmacyCsv("name\n\uD800")).toThrow(/valid Unicode/);
    expect(parsePharmacyCsv("name\n\uD83D\uDE00").records[0].cells.name).toBe("\uD83D\uDE00");
  });
  it.each(['a,b\n"unclosed,two', 'a,b\none"quote,two', 'a,b\n"one"junk,two', 'a,b\none', 'a,b\none,two,three', 'a,a\none,two', ' a ,a\none,two', ',b\none,two', 'a,b\none,\u0000', 'a,b'])('rejects malformed or ambiguous CSV %j', csv => {
    expect(() => parsePharmacyCsv(csv)).toThrow();
  });
  it("bounds bytes, records, columns and field size before any database action", () => {
    expect(() => parsePharmacyCsv(`a\n${"x".repeat(PHARMACY_CSV_LIMITS.bytes)}`)).toThrow(/bytes/);
    expect(() => parsePharmacyCsv(`a\n${Array.from({ length: 201 }, () => "x").join("\n")}`)).toThrow(/200 data/);
    expect(() => parsePharmacyCsv(`${Array.from({ length: 41 }, (_, index) => `c${index}`).join(",")}\n1`)).toThrow(/40 columns/);
    expect(() => parsePharmacyCsv(`a\n${"x".repeat(2001)}`)).toThrow(/2,000/);
  });
  it("accepts exactly 200 records and keeps source physical line numbers", () => {
    const parsed = parsePharmacyCsv(`id\n${Array.from({ length: 200 }, (_, index) => index.toString()).join("\n")}`);
    expect(parsed.records).toHaveLength(200); expect(parsed.records.at(-1)?.sourceLine).toBe(201);
  });
});
describe("Import quantities and exact INR intent", () => {
  it("converts exact decimal paise without binary floating-point multiplication", () => {
    expect(csvPaise("0.29", "Cost")).toBe(29); expect(csvPaise("001.2", "Cost")).toBe(120);
    expect(csvPaise("1000000000.00", "Cost")).toBe(100000000000);
    expect(csvWhole(" 000123 ", "Packs")).toBe(123);
  });
  it.each(["", "1e2", "1,000", "1.001", "-1", "+1", "=1+2", "Infinity", "NaN", ".5", "1."])("rejects inferred or imprecise money %j", value => {
    expect(() => csvPaise(value, "Cost")).toThrow();
  });
  it.each(["", "1.0", "1e2", "-0", "=2", "9007199254740992"])("rejects unsafe or inferred quantities %j", value => {
    expect(() => csvWhole(value, "Packs")).toThrow();
  });
  it("respects independently configured monetary and pack bounds", () => {
    expect(() => csvPaise("1.01", "Cost", 100)).toThrow(/bound/);
    expect(() => csvWhole("11", "Loose units", 10)).toThrow(/bound/);
  });
});
