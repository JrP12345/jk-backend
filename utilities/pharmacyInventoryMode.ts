import type { ClientSession } from "mongoose";
import { Location } from "../models/Location.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { lotExpiry } from "./pharmacyLot.ts";
import { Organization } from "../models/Organization.ts";

export type PharmacyInventoryMode = "tracked" | "billing_only";
export async function pharmacyInventoryMode(locationId: string, session: ClientSession | null = null) {
  const branch = await Location.findOne({ _id: locationId, isActive: { $ne: false } }).select("pharmacyCapability timezone organizationId").session(session).lean();
  if (!branch) throw new CommandError(404, "Pharmacy branch not found");
  const mode = (branch.pharmacyCapability?.inventoryMode || "tracked") as PharmacyInventoryMode;
  const organization = mode === "billing_only" && !branch.timezone ? await Organization.findById(branch.organizationId).select("timezone").session(session).lean() : null;
  return { mode, timezone: branch.timezone || organization?.timezone || "Asia/Kolkata" };
}

/** Printed supply evidence, deliberately independent of stock receipts and balances. */
export function normalizeBillingSupply(raw: unknown) {
  const row = raw as { batchNumber?: unknown; expiry?: { precision?: unknown; value?: unknown }; mrpPaise?: unknown } | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["batchNumber", "expiry", "mrpPaise"].includes(key)) ||
      typeof row.batchNumber !== "string" || !row.batchNumber.trim() || row.batchNumber.trim().length > 100 || /[\p{Cc}\p{Cf}]/u.test(row.batchNumber) ||
      !row.expiry || typeof row.expiry !== "object" || Array.isArray(row.expiry) || Object.keys(row.expiry).some(key => !["precision", "value"].includes(key)) ||
      !["day", "month"].includes(String(row.expiry.precision)) || typeof row.expiry.value !== "string" ||
      typeof row.mrpPaise !== "number" || !Number.isSafeInteger(row.mrpPaise) || row.mrpPaise < 0 || row.mrpPaise > 100_000_000_000) throw new CommandError(400, "Record the actual supply batch, printed expiry and MRP per base unit");
  const expiry = { precision: row.expiry.precision as "day" | "month", value: row.expiry.value };
  lotExpiry(expiry, "Asia/Kolkata");
  return { batchNumber: row.batchNumber.trim(), expiry, mrpPaise: row.mrpPaise };
}

export async function requireTrackedInventory(locationId: string, session: ClientSession | null) {
  if ((await pharmacyInventoryMode(locationId, session)).mode !== "tracked") throw new CommandError(409, "Stock operations are unavailable in billing-only mode. Existing stock history is preserved.");
}
