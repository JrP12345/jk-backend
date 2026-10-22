import { CashierShift } from "../../models/CashierShift.ts";
import crypto from "node:crypto";
import { expect } from "vitest";
import { app } from "../../index.ts";
import { Organization } from "../../models/Organization.ts";
import { Location } from "../../models/Location.ts";
import { User } from "../../models/User.ts";
import { Role } from "../../models/Role.ts";
import { OrgMember } from "../../models/OrgMember.ts";
import { Medicine } from "../../models/Medicine.ts";
import { createAuthSession } from "../../utilities/helpers.ts";
import { pharmacyTaxFixture } from "./pharmacyTaxFixture.ts";
const key = () => crypto.randomUUID();
export async function pharmacyPurchaseFixture(permissions = ["PHARMACY_PURCHASE", "PHARMACY_RECEIVE_STOCK"]) {
  const organizationId = (await Organization.create({ name: "Synthetic purchase posting", city: "Pune", countryCode: "IN", currency: "INR" })).id;
  const locationId = (await Location.create({ organizationId, name: "Synthetic receiving branch", city: "Pune" })).id;
  const role = `purchase_${key()}`; await Role.create({ organizationId, name: role, permissions });
  const user = await User.create({ name: "Synthetic receiver", email: `${key()}@example.test`, role });
  await OrgMember.create({ organizationId, userId: user.id, role, locationAccess: { mode: "selected", locationIds: [locationId] } });
  const auth = await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId });
  if (permissions.some(code => ["PHARMACY_COLLECT_PAYMENT", "PHARMACY_APPROVE_REFUND", "MANAGE_ORGANIZATION"].includes(code))) await CashierShift.create({ kind: "drawer", organizationId, locationId, cashierId: user.id, cashierName: user.name, organizationName: "Synthetic purchase posting", locationName: "Synthetic receiving branch", drawerCode: "SYNTHETIC-1", openingFloatPaise: 100000, collectionBasis: "drawer_v1", currency: "INR", timezone: "Asia/Kolkata", shiftDate: "2026-10-21", status: "active" });
  const medicine = await Medicine.create({ locationId, name: "Synthetic purchase units", genericName: "Synthetic", price: 10, stockQuantity: 0,
    unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
  await pharmacyTaxFixture(locationId, [medicine.id], user.id);
  const f = { organizationId, locationId, user, role, medicine, headers: { authorization: `Bearer ${auth.accessToken}` } };
  const supplier = await post(f, "parties", { locationId, name: "Synthetic registered supplier", address: "Synthetic supplier address", kinds: ["supplier"],
    gstRegistration: "registered", gstin: "27ABCDE1234F1Z5", licence: { number: "SYNTHETIC-LICENCE", validUntil: "2099-12-31" } });
  expect(supplier.statusCode, supplier.body).toBe(201); const party = supplier.json().data;
  const body = { locationId, supplierId: party.id, expectedSupplierRevision: 0, supplierInvoiceNumber: `BILL-${key()}`, invoiceDate: "2026-10-20", statedTotalPaise: 118,
    lines: [{ lineId: key(), medicineId: medicine.id, expectedUnitVersion: 1, packs: 0, looseUnits: 3, freePacks: 0, freeLooseUnits: 1,
      baseAmountPaise: 100, discountPaise: 0, gstRateBps: 1800, hsnCode: "300490", sellingPricePaise: 1000, mrpPaise: 1200 }] };
  const response = await post(f, "purchases", body); expect(response.statusCode, response.body).toBe(201);
  return { ...f, party, body, purchase: response.json().data };
}
const post = (f: { headers: { authorization: string } }, path: string, body: object, requestKey = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: body });
