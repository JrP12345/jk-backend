import { PharmacyInvoiceNumbering, PharmacyInvoicePrefix } from "../models/PharmacyInvoiceNumbering.ts";
import { Counter } from "../models/Counter.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyOfflineDevice } from "../models/PharmacyOfflineDevice.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { indiaFinancialYear } from "../utilities/indiaFinancialYear.ts";
import { pharmacyNumberPrefix, type PharmacyNumberFormat, type PharmacyNumberSnapshot } from "../utilities/pharmacyInvoiceNumberFormat.ts";

export interface PharmacyNumberingInput extends PharmacyNumberFormat { expectedRevision: number; expectedFinancialYear: string; nextNumber: number; reviewReference: string }
const counterId = (organizationId: string, prefix: string) => `pharmacy-number-v3:${organizationId}:${prefix}`;
export async function requirePharmacyNumberingIndexes() {
  for (const [model, fields] of [[PharmacyInvoiceNumbering, ["locationId"]], [PharmacyInvoicePrefix, ["organizationId", "prefix"]], [Counter, ["id"]], [Invoice, ["organizationId", "invoiceNumber"]]] as const) {
    let indexes;
    try { indexes = await model.collection.listIndexes().toArray(); } catch { throw new CommandError(503, "Prepare invoice-numbering collections and indexes before configuring a series"); }
    if (!indexes.some(index => index.unique === true && fields.every(field => index.key[field] === 1) && Object.keys(index.key).length === fields.length && !index.partialFilterExpression && !index.sparse))
      throw new CommandError(503, "Prepare invoice-numbering unique indexes before configuring a series");
    if (model.modelName === "Invoice" && indexes.some(index => index.unique && index.key.invoiceNumber === 1 && Object.keys(index.key).length === 1))
      throw new CommandError(503, "Review and remove the obsolete global invoice-number index after preparing the organization-scoped index");
  }
}
export async function readPharmacyNumbering(organizationId: string, locationId: string) {
  const year = indiaFinancialYear(), config = await PharmacyInvoiceNumbering.findOne({ organizationId, locationId }).lean();
  if (!config) return { organizationId, locationId, revision: 0, financialYear: year.label, configuration: null, nextNumber: null, preview: null };
  const prefix = pharmacyNumberPrefix(config, year.label), counter = await Counter.findOne({ id: counterId(organizationId, prefix) }).lean();
  const nextNumber = (counter?.seq ?? 0) + 1;
  return { organizationId, locationId, revision: config.revision, financialYear: year.label,
    configuration: { prefixTemplate: config.prefixTemplate, digits: config.digits, resetPolicy: config.resetPolicy, reviewReference: config.reviewReference }, nextNumber,
    preview: nextNumber < 10 ** config.digits ? `${prefix}${String(nextNumber).padStart(config.digits, "0")}` : null };
}
export async function savePharmacyNumbering(organizationId: string, locationId: string, actorId: string, value: PharmacyNumberingInput) {
  const input = { ...value, prefixTemplate: value.prefixTemplate.trim().toUpperCase(), reviewReference: value.reviewReference.trim() }, year = indiaFinancialYear();
  const prefix = pharmacyNumberPrefix(input, year.label);
  if (input.expectedFinancialYear !== year.label) throw new CommandError(409, "Financial year changed; reload invoice numbering before saving");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(input.nextNumber) || input.nextNumber < 1 || input.nextNumber >= 10 ** input.digits || input.reviewReference.length < 3 || input.reviewReference.length > 500)
    throw new CommandError(409, "Enter a valid next number, revision and review reference");
  await requirePharmacyNumberingIndexes();
  try {
    await withTransaction(async session => {
      if (!session?.inTransaction()) throw new CommandError(503, "Invoice numbering requires a transaction-capable database");
      if (indiaFinancialYear().label !== input.expectedFinancialYear) throw new CommandError(409, "Financial year changed; reload invoice numbering before saving");
      const branch = await Location.findOneAndUpdate({ _id: locationId, organizationId, isActive: true }, { $inc: { __v: 1 } });
      const organization = await Organization.findById(organizationId).select("countryCode currency").lean();
      if (!branch || organization?.countryCode !== "IN" || organization.currency !== "INR") throw new CommandError(409, "Invoice numbering requires an active India/INR branch");
      const config = await PharmacyInvoiceNumbering.findOne({ organizationId, locationId });
      if ((config?.revision ?? 0) !== input.expectedRevision) throw new CommandError(409, "Invoice numbering changed; reload before saving");
      const enrolled = await PharmacyOfflineDevice.findOne({ organizationId, locationId }).select("enrollmentId").lean();
      if (enrolled && (await PharmacyOfflineAuthority.exists({ organizationId, locationId, state: "held" }) ||
          !await PharmacyOfflineAuthority.exists({ organizationId, locationId, enrollmentId: enrolled.enrollmentId, state: "closed" }))) throw new CommandError(409, "Reconcile the enrolled PC's reserved numbers before changing branch numbering");
      // Reserve every supported fiscal expansion. A later-year prefix cannot be
      // claimed by another branch as a literal while this template is in use.
      const prefixes = input.resetPolicy === "financial_year" ? Array.from({ length: 99 }, (_, i) => pharmacyNumberPrefix(input, `${2000 + i}-${String(2001 + i).slice(-2)}`)) : [prefix];
      const owned = await PharmacyInvoicePrefix.find({ organizationId, prefix: { $in: prefixes } }).lean();
      if (owned.some(row => String(row.locationId) !== locationId || String(row.organizationId) !== organizationId)) throw new CommandError(409, "This invoice prefix is reserved by another branch. Choose a distinct branch prefix.");
      const used = new Set(owned.map(row => row.prefix));
      const missing = prefixes.filter(value => !used.has(value));
      if (missing.length) await PharmacyInvoicePrefix.insertMany(missing.map(value => ({ prefix: value, organizationId, locationId })));
      const counter = await Counter.findOne({ id: counterId(organizationId, prefix) });
      if (counter && (!Number.isSafeInteger(counter.seq) || counter.seq < 0 || input.nextNumber <= counter.seq)) throw new CommandError(409, "Next number has already been used or reserved. Reload and choose a higher number.");
      if (counter) await Counter.updateOne({ _id: counter._id, seq: counter.seq }, { $set: { seq: input.nextNumber - 1 } });
      else await Counter.create({ id: counterId(organizationId, prefix), seq: input.nextNumber - 1 });
      const fields = { organizationId, locationId, prefixTemplate: input.prefixTemplate, digits: input.digits, resetPolicy: input.resetPolicy, reviewReference: input.reviewReference,
        revision: input.expectedRevision + 1, confirmedBy: actorId, confirmedAt: new Date() };
      const saved = config ? await PharmacyInvoiceNumbering.findOneAndUpdate({ _id: config._id, revision: input.expectedRevision }, { $set: fields }, { returnDocument: "after", runValidators: true }) : await PharmacyInvoiceNumbering.create(fields);
      if (!saved) throw new CommandError(409, "Invoice numbering changed; reload before saving");
      await AuditLog.create({ organizationId, userId: actorId, action: "PHARMACY_INVOICE_NUMBERING_REVIEWED", category: "BILLING", targetModel: "PharmacyInvoiceNumbering", targetId: saved._id,
        details: { locationId, revision: fields.revision, prefixTemplate: input.prefixTemplate, digits: input.digits, resetPolicy: input.resetPolicy, nextNumber: input.nextNumber, reviewReference: input.reviewReference } });
    }, { writeConcern: { w: "majority" } });
  } catch (failure) {
    if ((failure as { code?: number }).code === 11000) throw new CommandError(409, "Invoice numbering was reserved concurrently. Reload before saving.");
    throw failure;
  }
  return readPharmacyNumbering(organizationId, locationId);
}

/** Called inside the sale transaction; config write fences settings edits. */
export async function allocateConfiguredPharmacyNumber(locationId: string, at: Date, count = 1) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new CommandError(400, "Invalid invoice-number allocation size");
  const config = await PharmacyInvoiceNumbering.findOneAndUpdate({ locationId }, { $inc: { allocationRevision: 1 } }, { returnDocument: "after", timestamps: false });
  if (!config) return null;
  const year = indiaFinancialYear(at), prefix = pharmacyNumberPrefix(config, year.label);
  const reservation = await PharmacyInvoicePrefix.findOne({ prefix, locationId, organizationId: config.organizationId }).lean();
  if (!reservation) throw new CommandError(409, "Invoice prefix ownership needs review before issuing");
  const orgId = String(config.organizationId);
  await Counter.updateOne({ id: counterId(orgId, prefix) }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  const counter = await Counter.findOneAndUpdate({ id: counterId(orgId, prefix), seq: { $gte: 0, $lte: 10 ** config.digits - 1 - count } }, { $inc: { seq: count } }, { returnDocument: "after" });
  if (!counter || !Number.isSafeInteger(counter.seq)) throw new CommandError(409, "Invoice series is exhausted. Review the branch numbering before another bill.");
  const snapshot: PharmacyNumberSnapshot = { version: 1, prefixTemplate: config.prefixTemplate, digits: config.digits, resetPolicy: config.resetPolicy, prefix,
    sequence: counter.seq, configurationRevision: config.revision };
  return { invoiceNumber: `${prefix}${String(counter.seq).padStart(config.digits, "0")}`, numberingVersion: 3, financialYear: year.label, invoiceSeries: prefix, numberingSnapshot: snapshot };
}
