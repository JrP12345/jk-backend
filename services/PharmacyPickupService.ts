import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { PharmacyPickup, type StoredPharmacyPickup } from "../models/PharmacyPickup.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Location } from "../models/Location.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { invoiceBalancePaise } from "./InvoicePaymentService.ts";
import { ordinaryPublicProducts, publicPharmacyFlags, publicPharmacyLocation } from "./PharmacyStorefrontService.ts";
import { object, identifier, text, whole } from "../schemas/pharmacyPurchases.ts";
import { resolvePublicId } from "../utilities/publicLinks.ts";
import { encryptField, decryptField, computeBlindIndex } from "../utilities/cryptoEnvelope.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const requestKey = (req: FastifyRequest) => { const key = req.headers["idempotency-key"]; if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "Keep the same request reference when retrying"); return key; };
function ticketToken(raw: unknown) { if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) throw new CommandError(400, "Invalid pickup ticket"); return raw; }
function pickupView(row: StoredPharmacyPickup) {
  return { id: String(row._id), locationId: String(row.locationId), reference: row.reference, status: ["requested", "ready"].includes(row.status) && row.expiresAt <= new Date() ? "expired" : row.status, revision: row.revision,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), readyAt: row.readyAt?.toISOString(), collectedAt: row.collectedAt?.toISOString(), invoiceNumber: row.invoiceNumber,
    items: row.items.map(item => ({ medicineId: String(item.medicineId), name: item.name, strength: item.strength || "", baseUnit: item.baseUnit, quantity: item.quantity })) };
}
const staffView = (row: StoredPharmacyPickup) => ({ ...pickupView(row), invoiceId: row.invoiceId ? String(row.invoiceId) : undefined, customerName: decryptField(row.customerNameCiphertext), phone: decryptField(row.phoneCiphertext) });

export async function requestPublicPickup(req: FastifyRequest) {
  const body = object(req.body, ["name", "phone", "items", "ticketSecret"]), key = requestKey(req), token = ticketToken(body.ticketSecret);
  const name = text(body.name, "customer name", 1, 100), phone = text(body.phone, "phone", 7, 32).replace(/[\s().-]/g, "");
  if (!/^\+?\d{7,15}$/.test(phone) || !Array.isArray(body.items) || !body.items.length || body.items.length > 25) throw new CommandError(400, "Enter a valid phone and 1 to 25 medicines");
  const items = body.items.map(raw => { const item = object(raw, ["medicineId", "quantity", "unitVersion"]), quantity = whole(item.quantity, "quantity", 1000); if (!quantity) throw new CommandError(400, "Select a positive whole quantity"); return { medicineId: identifier(item.medicineId), quantity, unitVersion: whole(item.unitVersion, "unit version", Number.MAX_SAFE_INTEGER) }; });
  if (new Set(items.map(item => item.medicineId)).size !== items.length) throw new CommandError(400, "Select each medicine once");
  const slug = (req.params as { slug: string }).slug, locationId = await resolvePublicId("location", slug);
  if (!locationId) throw new CommandError(404, "Pharmacy not found");
  const tokenHash = hash(token), phoneHash = computeBlindIndex(`${locationId}:${phone}`);
  const result = await executeRecordedCommand(`public-pharmacy-pickup:${locationId}`, key, { name, phoneHash, tokenHash, items }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const location = await publicPharmacyLocation(slug);
    if (!publicPharmacyFlags(location).pickupEnabled || !await isModuleEnabledForOrganization(String(location.organizationId), "pharmacy")) throw new CommandError(409, "This pharmacy is not accepting pickup requests");
    // Serializes public requests with publication/capability changes and other requests at this branch.
    await pinActivePharmacyLocation(locationId, session, true, true);
    if (await PharmacyPickup.countDocuments({ locationId, phoneHash, status: { $in: ["requested", "ready"] }, expiresAt: { $gt: new Date() } }).session(session) >= 5) throw new CommandError(429, "You already have pending requests here. Contact the pharmacy for help");
    const medicines = await Medicine.find({ ...ordinaryPublicProducts(location._id), _id: { $in: items.map(item => item.medicineId) } }).session(session).lean();
    const lots = await MedicineBatch.aggregate([{ $match: { organizationId: location.organizationId, locationId: location._id, medicineId: { $in: medicines.map(item => item._id) }, lotVersion: 1, status: "active", "saleControl.blocked": { $ne: true }, quantity: { $gt: 0 }, expiryDate: { $gt: new Date() } } }, { $group: { _id: "$medicineId", quantity: { $sum: "$quantity" } } }]).session(session);
    const available = new Map(lots.map(row => [String(row._id), row.quantity as number]));
    const captured = items.map(item => { const medicine = medicines.find(row => String(row._id) === item.medicineId); if (!medicine?.unitDefinition || medicine.unitDefinition.version !== item.unitVersion || !Number.isSafeInteger(available.get(item.medicineId)) || (available.get(item.medicineId) || 0) < item.quantity) throw new CommandError(409, "A medicine, quantity or unit is no longer available. Refresh the list"); return { ...item, name: medicine.name, strength: medicine.strength, baseUnit: medicine.unitDefinition.baseUnit }; });
    const createdAt = new Date(), row = await createWithSession<InstanceType<typeof PharmacyPickup>>(PharmacyPickup, { organizationId: location.organizationId, locationId, reference: `PK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`, tokenHash, phoneHash, customerNameCiphertext: encryptField(name), phoneCiphertext: encryptField(phone), status: "requested", revision: 0, items: captured, createdAt, expiresAt: new Date(createdAt.getTime() + 48 * 3600000) }, session);
    await createWithSession(AuditLog, { organizationId: location.organizationId, category: "ADMIN", action: "PHARMACY_PICKUP_REQUESTED", targetModel: "PharmacyPickup", targetId: row._id, details: { itemCount: items.length } }, session);
    return String(row._id);
  }), { writeConcern: { w: "majority" } });
  const saved = await PharmacyPickup.findOne({ _id: result.resultId, locationId, tokenHash }).lean();
  if (!saved) throw new CommandError(409, "Keep the original pickup request reference");
  return pickupView(saved);
}

export async function readPublicPickup(req: FastifyRequest) {
  const body = object(req.body, ["token"]), row = await PharmacyPickup.findOne({ tokenHash: hash(ticketToken(body.token)) }).lean();
  if (!row) throw new CommandError(404, "Pickup ticket not found. Check whether the request was confirmed");
  const location = await Location.findById(row.locationId).select("name phone city").lean();
  return { ...pickupView(row), location: location ? { name: location.name, phone: location.phone || "", city: location.city } : null };
}

export async function pickupPage(req: FastifyRequest) {
  const query = object(req.query, ["locationId", "cursor", "status", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
  if (query.status !== undefined && !["requested", "ready", "collected", "cancelled"].includes(query.status)) throw new CommandError(400, "Invalid pickup status");
  const rows = await PharmacyPickup.find({ organizationId: scope.organizationId, locationId: scope.locationId, ...(query.status ? { status: query.status } : { status: { $in: ["requested", "ready"] }, expiresAt: { $gt: new Date() } }), ...(query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {}) }).select("+customerNameCiphertext +phoneCiphertext").sort({ _id: -1 }).limit(26).lean();
  return { items: rows.slice(0, 25).map(staffView), nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
}
export async function scanPickup(req: FastifyRequest) {
  const body = object(req.body, ["locationId", "ticket"]), scope = await purchaseScope(req, body.locationId), ticket = text(body.ticket, "pickup ticket", 1, 300);
  const filter = /^PK-[A-F0-9]{10}$/.test(ticket) ? { reference: ticket } : { tokenHash: hash(ticketToken(ticket)) };
  const row = await PharmacyPickup.findOne({ ...filter, organizationId: scope.organizationId, locationId: scope.locationId }).select("+customerNameCiphertext +phoneCiphertext").lean();
  if (!row) throw new CommandError(404, "No pickup matches this ticket at this branch");
  return staffView(row);
}

export async function transitionPickup(req: FastifyRequest) {
  const body = object(req.body, ["locationId", "expectedRevision", "action", "invoiceNumber"]), scope = await purchaseScope(req, body.locationId), id = identifier((req.params as { id: string }).id), key = requestKey(req);
  if (!await pharmacyRequestAllows(req, "sell")) throw new CommandError(403, "Counter sales permission is required for pickup preparation and handover");
  if (!["ready", "collect", "cancel"].includes(body.action)) throw new CommandError(400, "Invalid pickup action");
  const expected = whole(body.expectedRevision, "pickup revision", Number.MAX_SAFE_INTEGER - 1), invoiceNumber = body.action === "ready" ? text(body.invoiceNumber, "saved bill number", 1, 100) : undefined;
  await executeRecordedCommand(`pharmacy-pickup:${scope.organizationId}:${scope.locationId}`, key, { id, expected, action: body.action, invoiceNumber: invoiceNumber || null, actorId: scope.actorId }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const row = await PharmacyPickup.findOne({ _id: id, organizationId: scope.organizationId, locationId: scope.locationId }).session(session);
    if (!row) throw new CommandError(404, "Pickup not found");
    if (row.revision !== expected || !["requested", "ready"].includes(row.status)) throw new CommandError(409, "Pickup already changed. Reload its current status");
    if (body.action !== "cancel" && row.expiresAt <= new Date()) throw new CommandError(409, "This pickup ticket expired. Review a new request");
    const patch: Record<string, unknown> = {};
    if (body.action === "ready" || body.action === "collect") {
      if (body.action === "ready" && row.status !== "requested" || body.action === "collect" && row.status !== "ready") throw new CommandError(409, "Prepare the parcel before handover");
      const products = await Medicine.find({ ...ordinaryPublicProducts(scope.locationId), _id: { $in: row.items.map(item => item.medicineId) } }).select("unitDefinition").session(session).lean();
      if (products.length !== row.items.length || row.items.some(item => !products.some(product => String(product._id) === String(item.medicineId) && product.unitDefinition?.version === item.unitVersion && product.unitDefinition.baseUnit === item.baseUnit))) throw new CommandError(409, "A requested product now needs pharmacist or unit review. Review the parcel before handover");
      // Conflict with simultaneous classification/unit edits; this does not deduct stock again.
      const pinnedProducts = await Medicine.updateMany({ ...ordinaryPublicProducts(scope.locationId), _id: { $in: products.map(product => product._id) } }, { $inc: { __v: 1 } }, { session, timestamps: false });
      if (pinnedProducts.matchedCount !== row.items.length) throw new CommandError(409, "Pickup products changed during preparation");
      const invoice = await Invoice.findOne({ ...(body.action === "ready" ? { invoiceNumber } : { _id: row.invoiceId }), organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy", documentVersion: { $in: [1, 2] }, status: { $nin: ["cancelled", "refunded"] }, deletedAt: null }).session(session);
      const source = invoice ? await PharmacyDispense.findOne({ invoiceId: invoice._id, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy" }).session(session).lean() : null;
      if (!invoice || !source || !invoice.issuedAt || invoice.issuedAt < row.createdAt || source.lines.length !== row.items.length || row.items.some(item => !source.lines.some(line => String(line.medicineId) === String(item.medicineId) && line.quantity === item.quantity && line.unitSnapshot?.baseUnit === item.baseUnit && line.unitSnapshot.version === item.unitVersion))) throw new CommandError(409, "Use a saved counter bill issued for exactly this pickup's medicines and quantities");
      const balance = invoiceBalancePaise(invoice, true);
      if (source.lines.some(line => !line.pricingAllocations.length || line.pricingAllocations.some(lot => !lot.expiryDate || lot.expiryDate <= new Date()))) throw new CommandError(409, "A billed batch has expired. Review the parcel before handover");
      // A later exact-batch hold applies even when the parcel was billed earlier.
      // Pin the original lots to serialize handover with a simultaneous hold.
      const batchIds = [...new Set(source.lines.flatMap(line => line.batches.map(lot => String(lot.batchId))))];
      if (batchIds.length) {
        const batches = await MedicineBatch.updateMany({ _id: { $in: batchIds }, organizationId: scope.organizationId, locationId: scope.locationId, "saleControl.blocked": { $ne: true } },
          { $inc: { __v: 1 } }, { session, timestamps: false });
        if (batches.matchedCount !== batchIds.length) throw new CommandError(409, "A billed batch is on a sale hold or is unavailable. Review the parcel before handover");
      }
      if (balance.creditedPaise || balance.refundedPaise) throw new CommandError(409, "This bill has corrections. Review the parcel before using another bill");
      if (body.action === "collect" && (invoice.status !== "paid" || balance.balancePaise !== 0)) throw new CommandError(409, "Record the bill's payment before handing over this parcel");
      const pinned = await Invoice.updateOne({ _id: invoice._id, paymentRevision: invoice.paymentRevision }, { $inc: { __v: 1 } }, { session, timestamps: false });
      if (pinned.matchedCount !== 1 || await PharmacyPickup.exists({ invoiceId: invoice._id, _id: { $ne: row._id } }).session(session)) throw new CommandError(409, "This bill is already linked or changed. Review the current pickup");
      Object.assign(patch, body.action === "ready" ? { status: "ready", invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber, preparedBy: scope.actorId, readyAt: new Date() } : { status: "collected", collectedBy: scope.actorId, collectedAt: new Date() });
    } else Object.assign(patch, { status: "cancelled", cancelledBy: scope.actorId, cancelledAt: new Date() });
    const changed = await PharmacyPickup.updateOne({ _id: row._id, revision: expected, status: row.status }, { $set: patch, $inc: { revision: 1 } }, { session, runValidators: true });
    if (changed.modifiedCount !== 1) throw new CommandError(409, "Pickup changed while processing");
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, category: "ADMIN", action: `PHARMACY_PICKUP_${String(body.action).toUpperCase()}`, targetModel: "PharmacyPickup", targetId: row._id, details: { revision: expected + 1, invoiceId: patch.invoiceId || row.invoiceId } }, session);
    return id;
  }), { writeConcern: { w: "majority" } });
  const result = await PharmacyPickup.findOne({ _id: id, organizationId: scope.organizationId, locationId: scope.locationId }).select("+customerNameCiphertext +phoneCiphertext").lean();
  if (!result) throw new CommandError(404, "Pickup not found");
  return staffView(result);
}
