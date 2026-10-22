import { CashierShift } from "../../models/CashierShift.ts";
import { Organization } from "../../models/Organization.ts";
import { Location } from "../../models/Location.ts";
import { User } from "../../models/User.ts";
import { Role } from "../../models/Role.ts";
import { OrgMember } from "../../models/OrgMember.ts";
import { Medicine } from "../../models/Medicine.ts";
import { createAuthSession } from "../../utilities/helpers.ts";
import { pharmacyTaxFixture } from "./pharmacyTaxFixture.ts";
import { receivePharmacyStock } from "../../services/PharmacyStockReceiptService.ts";
import crypto from "node:crypto";
const key = () => crypto.randomUUID();
export async function pharmacyRetailFixture(permissions = ["PHARMACY_SELL"]) {
  const organizationId = (await Organization.create({ name: "Synthetic retail", city: "Pune", countryCode: "IN", currency: "INR" })).id;
  const locationId = (await Location.create({ organizationId, name: "Retail branch", city: "Pune" })).id;
  const role = `retail_${key()}`; await Role.create({ organizationId, name: role, permissions });
  const user = await User.create({ name: "Counter operator", email: `${key()}@example.test`, role });
  await OrgMember.create({ organizationId, userId: user.id, role, locationAccess: { mode: "selected", locationIds: [locationId] } });
  const session = await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId });
  if (permissions.some(code => ["PHARMACY_COLLECT_PAYMENT", "PHARMACY_APPROVE_REFUND", "MANAGE_ORGANIZATION"].includes(code))) await CashierShift.create({ kind: "drawer", organizationId, locationId, cashierId: user.id, cashierName: user.name, organizationName: "Synthetic retail", locationName: "Retail branch", drawerCode: "SYNTHETIC-1", openingFloatPaise: 100000, collectionBasis: "drawer_v1", currency: "INR", timezone: "Asia/Kolkata", shiftDate: "2026-10-21", status: "active" });
  const medicine = await Medicine.create({ locationId, name: "Ordinary product", genericName: "Synthetic", stockQuantity: 0, price: 10, scheduleType: "general",
    unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 }, dispensingRevision: 1,
    dispensingReview: { scheduleType: "general", confirmedAt: new Date(), confirmedBy: user.id, reviewReference: "Synthetic reviewed ordinary product" } });
  await pharmacyTaxFixture(locationId, [medicine.id], user.id);
  const authority = { organizationId, locationId, actorId: user.id }, receiptKey = key();
  await receivePharmacyStock(authority, receiptKey, { medicineId: medicine.id, locationId, kind: "opening", receiptLineId: receiptKey, expectedUnitVersion: 1, packs: 1, looseUnits: 0,
    batchNumber: "ACTUAL-BATCH", expiry: { precision: "month", value: "2099-12" }, purchaseTotalPaise: 101, sellingPricePaise: 1000, mrpPaise: 1200, openingSourceReference: "Synthetic opening count" });
  return { organizationId, locationId, role, user, medicine, headers: { authorization: `Bearer ${session.accessToken}` }, input: { locationId, expectedProfileRevision: 1, expectedTotalPaise: 2000,
    lines: [{ lineId: key(), medicineId: medicine.id, quantity: 2, expectedUnitVersion: 1, expectedStockRevision: 1, discountPaise: 0 }] } };
}
