import crypto from "node:crypto";
import { CommandError } from "../services/CommandReceiptService.ts";
import { addBillingPeriod } from "./billingPeriod.ts";

export const LEGACY_TIERS = ["starter", "professional", "enterprise"] as const;
export interface ProductRates {
  clinicPaise: number;
  pharmacyPaise: number;
  pharmacyAddonPaise: number;
  extraDoctorPaise: number;
  additionalPharmacyPaise?: number | null;
}
export interface CommercialPricing {
  revision: number;
  monthly: ProductRates;
  annual?: ProductRates | null;
  taxMode: "inclusive" | "exclusive";
  taxRateBps: number;
  includedDoctors: number;
  doctorsPerAdditionalClinic: number;
}
export interface ProductLocation { locationId: string; clinic: boolean; pharmacy: boolean; capabilityRevision: number }
export interface ProductSelection { billingCycle: "monthly" | "annual"; priceRevision: number; doctorSeats: number; locations: ProductLocation[] }
export interface CommercialQuote {
  version: 1; organizationId: string; planId: string; priceRevision: number;
  commercialFamily: "pharmacy" | "clinic" | "mixed"; legacyTier: typeof LEGACY_TIERS[number];
  billingCycle: "monthly" | "annual"; currency: "INR"; taxMode: "inclusive" | "exclusive"; taxRateBps: number;
  periodStart: string; periodEnd: string; expiresAt: string;
  lines: Array<{ id: string; kind: "clinic" | "pharmacy" | "pharmacy_addon" | "extra_doctor"; locationId?: string; quantity: number; unitPricePaise: number; amountPaise: number }>;
  subtotalPaise: number; taxPaise: number; totalPaise: number;
  entitlements: { maxLocations: number; maxDoctors: number; maxStaff: number; locations: ProductLocation[] };
  fingerprint: string;
}
const MAX_PAISE = 100_000_000_000;
function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new CommandError(400, `${name} must be a bounded non-negative integer`);
}
export function isProductPlan(plan: { commercialFamily?: unknown }) { return plan.commercialFamily === "location_products"; }
export function validateCommercialPlan(plan: { commercialFamily?: unknown; legacyTier?: unknown; currency?: unknown; commercialPricing?: unknown; limits?: { maxLocations?: unknown; maxDoctors?: unknown; maxStaff?: unknown } | null }) {
  if (!isProductPlan(plan) || !LEGACY_TIERS.includes(plan.legacyTier as typeof LEGACY_TIERS[number]) || plan.currency !== "INR") throw new CommandError(409, "A location-product catalogue requires an explicit legacy tier and INR currency");
  const config = plan.commercialPricing as CommercialPricing | undefined;
  if (!config || !["inclusive", "exclusive"].includes(config.taxMode)) throw new CommandError(409, "Reviewed commercial pricing and tax treatment are required");
  integer(config.revision, "Price revision"); if (config.revision < 1) throw new CommandError(400, "Price revision must be positive");
  integer(config.taxRateBps, "Tax rate", 10000); integer(config.includedDoctors, "Included doctors", 1000);
  integer(config.doctorsPerAdditionalClinic, "Additional-clinic included doctors", 1000);
  for (const rates of [config.monthly, ...(config.annual ? [config.annual] : [])]) {
    if (!rates) throw new CommandError(409, "Monthly product prices must be configured");
    for (const key of ["clinicPaise", "pharmacyPaise", "pharmacyAddonPaise", "extraDoctorPaise"] as const) integer(rates[key], key, MAX_PAISE);
    if (rates.additionalPharmacyPaise != null) integer(rates.additionalPharmacyPaise, "Additional pharmacy price", MAX_PAISE);
  }
  for (const key of ["maxLocations", "maxDoctors", "maxStaff"] as const) integer(plan.limits?.[key], key, key === "maxLocations" ? 100 : 10000);
  return config;
}
export function commercialFingerprint(value: unknown) {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export const quoteFingerprint = (value: Omit<CommercialQuote, "fingerprint">) => commercialFingerprint(value);
export function calculateCommercialQuote(organizationId: string, plan: Parameters<typeof validateCommercialPlan>[0] & { id: string }, selection: ProductSelection, now = new Date()): CommercialQuote {
  const config = validateCommercialPlan(plan);
  if (selection.priceRevision !== config.revision) throw new CommandError(409, "Commercial prices changed; reload the catalogue before quoting");
  if (!["monthly", "annual"].includes(selection.billingCycle)) throw new CommandError(400, "Invalid billing cycle");
  const rates = selection.billingCycle === "annual" ? config.annual : config.monthly;
  if (!rates) throw new CommandError(409, "Annual product prices have not been configured");
  integer(selection.doctorSeats, "Doctor seats", 1000);
  if (!Array.isArray(selection.locations) || !selection.locations.length || selection.locations.length > (plan.limits!.maxLocations as number)) throw new CommandError(409, "Selected locations exceed the configured location capacity");
  const locations = selection.locations.map(location => {
    if (!/^[a-f\d]{24}$/i.test(location.locationId) || typeof location.clinic !== "boolean" || typeof location.pharmacy !== "boolean" || !location.clinic && !location.pharmacy) throw new CommandError(400, "Each location needs an explicit clinic or pharmacy selection");
    integer(location.capabilityRevision, "Location capability revision");
    return { locationId: location.locationId.toLowerCase(), clinic: location.clinic, pharmacy: location.pharmacy, capabilityRevision: location.capabilityRevision };
  }).sort((a, b) => a.locationId.localeCompare(b.locationId));
  if (new Set(locations.map(location => location.locationId)).size !== locations.length) throw new CommandError(400, "Select each physical location once");
  const clinics = locations.filter(location => location.clinic).length;
  const pharmacies = locations.filter(location => location.pharmacy && !location.clinic).length;
  const includedDoctors = clinics ? config.includedDoctors + (clinics - 1) * config.doctorsPerAdditionalClinic : 0;
  const maxDoctors = Math.max(selection.doctorSeats, includedDoctors);
  if (maxDoctors > (plan.limits!.maxDoctors as number)) throw new CommandError(409, "Doctor seats exceed the configured capacity");
  const lines: CommercialQuote["lines"] = [];
  for (const location of locations) {
    if (location.clinic) lines.push({ id: `clinic:${location.locationId}`, kind: "clinic", locationId: location.locationId, quantity: 1, unitPricePaise: rates.clinicPaise, amountPaise: rates.clinicPaise });
    if (location.pharmacy) {
      const kind = location.clinic ? "pharmacy_addon" : "pharmacy";
      // Extra standalone-pharmacy pricing is a separate configuration decision.
      const earlierStandalone = locations.some(selected => selected.clinic && selected.pharmacy) || lines.some(line => line.kind === "pharmacy");
      const price = location.clinic ? rates.pharmacyAddonPaise : earlierStandalone ? rates.additionalPharmacyPaise : rates.pharmacyPaise;
      if (price == null) throw new CommandError(409, "Additional standalone pharmacy pricing has not been configured");
      lines.push({ id: `${kind}:${location.locationId}`, kind, locationId: location.locationId, quantity: 1, unitPricePaise: price, amountPaise: price });
    }
  }
  const extraDoctors = Math.max(0, selection.doctorSeats - includedDoctors);
  if (extraDoctors) lines.push({ id: "extra_doctor", kind: "extra_doctor", quantity: extraDoctors, unitPricePaise: rates.extraDoctorPaise, amountPaise: extraDoctors * rates.extraDoctorPaise });
  const amount = lines.reduce((sum, line) => sum + line.amountPaise, 0); integer(amount, "Quote amount", MAX_PAISE);
  const taxPaise = config.taxMode === "inclusive" ? amount - Math.round(amount * 10000 / (10000 + config.taxRateBps)) : Math.round(amount * config.taxRateBps / 10000);
  const totalPaise = config.taxMode === "inclusive" ? amount : amount + taxPaise; integer(totalPaise, "Total quote amount", MAX_PAISE);
  const result: Omit<CommercialQuote, "fingerprint"> = { version: 1, organizationId, planId: plan.id, priceRevision: config.revision,
    commercialFamily: clinics && (pharmacies || locations.some(location => location.clinic && location.pharmacy)) ? "mixed" : clinics ? "clinic" : "pharmacy",
    legacyTier: plan.legacyTier as CommercialQuote["legacyTier"], billingCycle: selection.billingCycle, currency: "INR", taxMode: config.taxMode, taxRateBps: config.taxRateBps,
    periodStart: now.toISOString(), periodEnd: addBillingPeriod(now, selection.billingCycle).toISOString(), expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    lines, subtotalPaise: totalPaise - taxPaise, taxPaise, totalPaise,
    entitlements: { maxLocations: locations.length, maxDoctors, maxStaff: plan.limits!.maxStaff as number, locations } };
  return { ...result, fingerprint: quoteFingerprint(result) };
}
