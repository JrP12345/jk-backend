import crypto from "node:crypto";
import fs from "node:fs";
import { expect, it } from "vitest";
import { PHARMACY_CALCULATION_ENGINE_SHA256, calculatePharmacyDocument, splitPharmacyTax } from "../services/InvoiceCalculationService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import * as pure from "../utilities/pharmacyCalculation.ts";

it("pins the server engine digest to the same dependency-free source shipped to the browser", () => {
  const source = fs.readFileSync(new URL("../utilities/pharmacyCalculation.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  expect(source).not.toMatch(/^import\s/m);
  expect(crypto.createHash("sha256").update(source).digest("hex")).toBe(PHARMACY_CALCULATION_ENGINE_SHA256);
});
it("keeps the existing service CommandError contract while the pure/browser engine has no server dependencies", () => {
  expect(() => pure.splitPharmacyTax(-1, 0, "inclusive", "none")).toThrow(pure.PharmacyCalculationError);
  try { splitPharmacyTax(-1, 0, "inclusive", "none"); throw new Error("Expected validation failure"); }
  catch (failure) { expect(failure).toBeInstanceOf(CommandError); expect(failure).toMatchObject({ statusCode: 409 }); }
  const input: pure.PharmacyCalculationInput = { policy: "pharmacy-paise-v2", currency: "INR", priceMode: "inclusive", taxMode: "sgst",
    invoiceDiscountPaise: 1, lines: [{ lineId: "stable", quantity: 3, unitPrice: { numeratorPaise: 10000, denominatorUnits: 3 }, gstRateBps: 1800 }] };
  expect(calculatePharmacyDocument(input)).toEqual(pure.calculatePharmacyDocument(input));
});
