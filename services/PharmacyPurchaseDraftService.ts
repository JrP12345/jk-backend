import type { FastifyRequest } from "fastify";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { Organization } from "../models/Organization.ts";
import { Medicine } from "../models/Medicine.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { normalizeUnitDefinition, toBaseUnits } from "../utilities/medicineCatalogue.ts";
import { getLocationTimezone, locationDateKey } from "../utilities/locationTime.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { partyInput, draftInput, identifier } from "../schemas/pharmacyPurchases.ts";
import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";

export async function purchaseScope(req: FastifyRequest, locationId: unknown) {
  const location = identifier(locationId), access = await checkLocationAccess(req, location);
  if (!access.allowed) throw new CommandError(access.statusCode, access.message);
  return { organizationId: access.organizationId!, locationId: location, actorId: req.user!.id };
}
export async function scopedParty(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId);
  const party = await PharmacyParty.findOne({ _id: identifier(id), organizationId: scope.organizationId, locationIds: scope.locationId });
  if (!party) throw new CommandError(404, "Business party not found");
  return { scope, party };
}
export async function scopedPurchase(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId);
  const draft = await PharmacyPurchase.findOne({ _id: identifier(id), organizationId: scope.organizationId, locationId: scope.locationId });
  if (!draft) throw new CommandError(404, "Purchase draft not found");
  return { scope, draft };
}
function requestKey(req: FastifyRequest) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required to create a party or draft");
  return key;
}
export async function savePharmacyParty(req: FastifyRequest, id?: string) {
  const input = partyInput(req.body, Boolean(id)), scope = await purchaseScope(req, input.locationId);
  const { locationId, expectedRevision, ...fields } = input;
  const save = () => withTransaction(async session => {
    requireStockTransaction(session);
    const current = id ? (await scopedParty(req, id, locationId)).party : null;
    // Serialize business identities independently of deployment-time index preparation.
    const ownerLock = await Organization.updateOne({ _id: scope.organizationId }, { $inc: { __v: 1 } }, { session, timestamps: false });
    if (ownerLock.matchedCount !== 1) throw new CommandError(404, "Organization not found");
    if (fields.gstin && await PharmacyParty.exists({ organizationId: scope.organizationId, gstin: fields.gstin, ...(current ? { _id: { $ne: current._id } } : {}) }).session(session)) throw new CommandError(409, "This GST identity already exists in the business; retain the existing party");
    if (current?.gstin && current.gstin !== fields.gstin && await PharmacyPurchase.exists({ organizationId: scope.organizationId, supplierId: current._id }).session(session)) throw new CommandError(409, "Supplier GST identity is linked to purchase history; retain it and review a separate legal identity");
    // Sharing or editing a company-wide party requires authority over every affected branch.
    const branches = new Set([...fields.locationIds, ...(current?.locationIds.map(String) ?? [])]);
    for (const branch of branches) { const access = await purchaseScope(req, branch); if (access.organizationId !== scope.organizationId) throw new CommandError(404, "Branch not found"); }
    const values = { ...fields, normalizedName: fields.name.normalize("NFKC").toLowerCase().replace(/\s+/g, " "), updatedBy: scope.actorId };
    let result;
    if (current) {
      const { gstin, licence, ...present } = values;
      result = await PharmacyParty.findOneAndUpdate({ _id: current._id, organizationId: scope.organizationId, locationIds: scope.locationId, revision: expectedRevision },
        { $set: { ...present, ...(gstin ? { gstin } : {}), ...(licence ? { licence } : {}) }, $unset: { ...(!gstin ? { gstin: 1 } : {}), ...(!licence ? { licence: 1 } : {}) }, $inc: { revision: 1 } }, { session, returnDocument: "after", runValidators: true });
      if (!result) throw new CommandError(409, "Business party changed; reload before saving");
    } else result = await createWithSession<InstanceType<typeof PharmacyParty>>(PharmacyParty, { ...values, organizationId: scope.organizationId, createdBy: scope.actorId }, session);
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: current ? "PHARMACY_PARTY_UPDATED" : "PHARMACY_PARTY_CREATED", targetModel: "PharmacyParty", targetId: result._id, category: "ADMIN", details: { revision: result.revision, archived: result.archived, kinds: result.kinds } }, session);
    for (const branch of branches) await pinActivePharmacyLocation(branch, session);
    return String(result._id);
  });
  const resultId = id ? await save() : (await executeRecordedCommand(`pharmacy-party:${scope.organizationId}:${scope.locationId}`, requestKey(req), { actorId: scope.actorId, ...input }, save)).resultId;
  return (await scopedParty(req, resultId, scope.locationId)).party;
}
export async function savePharmacyPurchaseDraft(req: FastifyRequest, id?: string) {
  const input = draftInput(req.body, Boolean(id)), scope = await purchaseScope(req, input.locationId);
  const save = () => withTransaction(async session => {
    requireStockTransaction(session);
    const organization = await Organization.findById(scope.organizationId).select("currency countryCode").session(session);
    if (organization?.currency !== "INR" || organization.countryCode !== "IN") throw new CommandError(409, "Purchase drafts require an explicitly configured India/INR organization");
    const current = id ? (await scopedPurchase(req, id, input.locationId)).draft : null;
    if (current && (current.status !== "draft" || current.revision !== input.expectedRevision)) throw new CommandError(409, "Purchase draft changed; reload before saving");
    const supplier = (await scopedParty(req, input.supplierId, input.locationId)).party;
    const today = locationDateKey(new Date(), await getLocationTimezone(input.locationId));
    if (supplier.archived || !supplier.kinds.includes("supplier") || !supplier.licence?.number || supplier.licence.validUntil && supplier.licence.validUntil < today) throw new CommandError(409, "Choose an active supplier with recorded licence details and no recorded expiry in the past");
    if (supplier.revision !== input.expectedSupplierRevision) throw new CommandError(409, "Supplier changed; reload before selecting it");
    const supplierLock = await PharmacyParty.updateOne({ _id: supplier._id, organizationId: scope.organizationId, revision: input.expectedSupplierRevision, archived: false }, { $inc: { __v: 1 } }, { session, timestamps: false });
    if (supplierLock.matchedCount !== 1) throw new CommandError(409, "Supplier changed; reload before selecting it");
    if (await PharmacyPurchase.exists({ organizationId: scope.organizationId, supplierId: input.supplierId, invoiceFY: input.invoiceFY, normalizedInvoiceNumber: input.normalizedInvoiceNumber,
      ...(current ? { _id: { $ne: current._id } } : {}) }).session(session)) throw new CommandError(409, "This supplier invoice already exists in the business; reopen the existing record");
    const medicines = await Medicine.find({ _id: { $in: input.lines.map(line => line.medicineId) }, locationId: input.locationId, deletedAt: null }).session(session);
    const lines = input.lines.map(line => {
      const medicine = medicines.find(row => String(row._id) === line.medicineId), unit = medicine?.unitDefinition;
      if (!medicine || !unit || unit.version !== line.expectedUnitVersion) throw new CommandError(409, "A product or its units changed; reload the draft products");
      normalizeUnitDefinition(unit, unit.version);
      if (line.looseUnits >= unit.unitsPerPack || line.freeLooseUnits >= unit.unitsPerPack) throw new CommandError(400, "Loose quantities must be smaller than one pack");
      const billedBaseUnits = toBaseUnits(line.packs, unit.unitsPerPack) + line.looseUnits, freeBaseUnits = toBaseUnits(line.freePacks, unit.unitsPerPack) + line.freeLooseUnits;
      if (!Number.isSafeInteger(billedBaseUnits + freeBaseUnits) || billedBaseUnits + freeBaseUnits <= 0 || billedBaseUnits === 0 && line.baseAmountPaise !== 0) throw new CommandError(400, "Enter a positive safe received quantity; free-only lines cannot have a billed base amount");
      const { expectedUnitVersion: _version, ...captured } = line;
      return { ...captured, billedBaseUnits, freeBaseUnits, medicineSnapshot: { name: medicine.name, genericName: medicine.genericName, strength: medicine.strength },
        unitSnapshot: { version: unit.version, baseUnit: unit.baseUnit, packUnit: unit.packUnit, unitsPerPack: unit.unitsPerPack } };
    });
    const supplierSnapshot = current && String(current.supplierId) === input.supplierId ? current.supplierSnapshot : {
      partyId: supplier._id, revision: supplier.revision, name: supplier.name, address: supplier.address, phone: supplier.phone, email: supplier.email,
      gstRegistration: supplier.gstRegistration, gstin: supplier.gstin, licence: supplier.licence ? { number: supplier.licence.number, validUntil: supplier.licence.validUntil } : undefined,
    };
    const { expectedRevision: _revision, expectedSupplierRevision: _supplierRevision, ...fields } = input;
    // Source bill rates are unreviewed draft evidence. Do not guess its place of supply/tax split.
    const calculation = calculatePharmacyDocument({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "exclusive", taxMode: "unallocated",
      lines: lines.map(line => ({ lineId: line.lineId, quantity: line.billedBaseUnits + line.freeBaseUnits,
        unitPrice: { numeratorPaise: line.baseAmountPaise, denominatorUnits: line.billedBaseUnits + line.freeBaseUnits },
        lineDiscountPaise: line.discountPaise, gstRateBps: line.gstRateBps })) });
    const values = { ...fields, supplierSnapshot, lines, calculation, currency: "INR", updatedBy: scope.actorId };
    let result;
    if (current) {
      result = await PharmacyPurchase.findOneAndUpdate({ _id: current._id, organizationId: scope.organizationId, locationId: scope.locationId, status: "draft", revision: input.expectedRevision },
        { $set: values, $inc: { revision: 1 } }, { session, returnDocument: "after", runValidators: true });
      if (!result) throw new CommandError(409, "Purchase draft changed; reload before saving");
    } else result = await createWithSession<InstanceType<typeof PharmacyPurchase>>(PharmacyPurchase, { ...values, organizationId: scope.organizationId, createdBy: scope.actorId }, session);
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_PURCHASE_DRAFT_SAVED", targetId: result._id, targetModel: "PharmacyPurchase", category: "BILLING", details: { revision: result.revision, lineCount: lines.length, status: "draft", stockPosted: false } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    return String(result._id);
  });
  const resultId = id ? await save() : (await executeRecordedCommand(`pharmacy-purchase-draft:${scope.organizationId}:${scope.locationId}`, requestKey(req), { actorId: scope.actorId, ...input }, save)).resultId;
  return (await scopedPurchase(req, resultId, scope.locationId)).draft;
}
