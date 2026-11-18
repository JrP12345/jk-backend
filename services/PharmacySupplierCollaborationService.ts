import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyPurchaseOrder } from "../models/PharmacyPurchaseOrder.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { supplierOrderChanges, supplierOrderProgress } from "./PharmacyPurchaseOrderService.ts";
import { CommandError, commandHash, executeRecordedCommand } from "./CommandReceiptService.ts";
import { purchaseOrderAction } from "../schemas/pharmacyPurchaseOrders.ts";
import { identifier, object } from "../schemas/pharmacyPurchases.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";
import { validateUploadMetadata, prepareUploadBytes } from "../utilities/uploadPolicy.ts";
import { storeVerifiedObject, deleteObjectFromStorage, generatePresignedDownloadUrl } from "../utilities/r2.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";
import { enqueueTransactionalEmail } from "./CommunicationOutbox.ts";
import { supplierProviderReadiness } from "../utilities/pharmacySupplierReadiness.ts";

type Scope = Awaited<ReturnType<typeof purchaseScope>>;
type OrderUpdate = mongoose.UpdateQuery<mongoose.InferSchemaType<typeof PharmacyPurchaseOrder.schema>>;
const maxBytes = 4 * 1024 * 1024;
const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const key = (req: FastifyRequest) => { const value = req.headers["idempotency-key"]; if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new CommandError(428, "Keep the original request reference when retrying"); return value; };
const owner = (scope: Scope, id: string) => ({ _id: identifier(id), organizationId: scope.organizationId, locationId: scope.locationId });
async function staffOrder(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), order = await PharmacyPurchaseOrder.findOne(owner(scope, id));
  if (!order) throw new CommandError(404, "Order not found at this branch"); return { scope, order };
}
async function available(order: any, session: mongoose.ClientSession | null = null) {
  const location = await Location.findOne({ _id: order.locationId, organizationId: order.organizationId, isActive: { $ne: false }, "pharmacyCapability.enabled": { $ne: false } }).session(session);
  const supplier = await PharmacyParty.exists({ _id: order.supplierId, organizationId: order.organizationId, locationIds: order.locationId, archived: false, kinds: "supplier" }).session(session);
  if (!location || !supplier || !await isModuleEnabledForOrganization(String(order.organizationId), "pharmacy")) throw new CommandError(404, "Supplier order link is unavailable");
}
async function publicOrder(token: unknown, session: mongoose.ClientSession | null = null) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new CommandError(404, "Supplier order link is unavailable");
  const order = await PharmacyPurchaseOrder.findOne({ "supplierAccess.tokenHash": hash(token), "supplierAccess.expiresAt": { $gt: new Date() }, "supplierAccess.revokedAt": null }).session(session);
  if (!order) throw new CommandError(404, "Supplier order link is unavailable or expired");
  await available(order, session); return order;
}
const documentView = (doc: any) => ({ id: doc.documentId, name: doc.name, kind: doc.kind, contentType: doc.contentType, size: doc.size, source: doc.source, supplierVisible: doc.supplierVisible, createdAt: doc.createdAt });
const publicView = async (order: any) => ({ reference: order.reference, revision: order.revision, state: order.state, ...await supplierOrderProgress(order), buyer: order.buyerSnapshot, supplierName: order.supplierSnapshot.name, notes: order.notes,
  canRespond: !order.invoiceCount && ["submitted", "accepted", "partially_accepted", "rejected"].includes(order.state), canDispatch: ["submitted", "accepted", "partially_accepted", "dispatched"].includes(order.state), canUpload: !["draft", "cancelled", "closed"].includes(order.state), uploadsAvailable: supplierProviderReadiness().storageAvailable,
  expiresAt: order.supplierAccess.expiresAt, lines: order.lines.map((line: any) => ({ lineId: line.lineId, name: line.medicineSnapshot.name, strength: line.medicineSnapshot.strength, manufacturer: line.medicineSnapshot.manufacturer, quantity: line.quantity, unit: line.unitSnapshot.baseUnit, packUnit: line.unitSnapshot.packUnit, unitsPerPack: line.unitSnapshot.unitsPerPack })),
  response: order.response ? { reference: order.response.reference, recordedAt: order.response.recordedAt, lines: order.response.lines.map((line: any) => ({ lineId: line.lineId, acceptedQuantity: line.acceptedQuantity, quotedUnitPricePaise: line.quotedUnitPricePaise, note: line.note })) } : undefined,
  dispatch: order.dispatch ? { reference: order.dispatch.reference, expectedDelivery: order.dispatch.expectedDelivery, recordedAt: order.dispatch.recordedAt } : undefined,
  documents: order.documents.filter((doc: any) => doc.supplierVisible || doc.source === "supplier_link").map(documentView) });
async function audit(order: any, action: string, details: Record<string, unknown>, session: mongoose.ClientSession, actorId?: string) {
  await createWithSession(AuditLog, { organizationId: order.organizationId, userId: actorId, category: "BILLING", targetModel: "PharmacyPurchaseOrder", targetId: order._id, action,
    details: { ...details, actorType: actorId ? "staff" : "supplier_link_holder", stockChanged: false } }, session);
}
async function pin(order: any, session: mongoose.ClientSession) {
  const result = await Location.updateOne({ _id: order.locationId, organizationId: order.organizationId, isActive: { $ne: false }, "pharmacyCapability.enabled": { $ne: false } }, { $inc: { __v: 1 } }, { session, timestamps: false });
  if (!result.matchedCount) throw new CommandError(409, "Pharmacy branch is unavailable");
  const party = await PharmacyParty.updateOne({ _id: order.supplierId, organizationId: order.organizationId, locationIds: order.locationId, archived: false, kinds: "supplier" }, { $inc: { __v: 1 } }, { session, timestamps: false });
  if (!party.matchedCount) throw new CommandError(409, "Supplier is unavailable");
}

export async function supplierCollaboration(req: FastifyRequest, id: string) {
  const query = object(req.query, ["locationId", "organizationId", "organization_id"]), { order } = await staffOrder(req, id, query.locationId);
  const email = order.supplierEmail?.messageId ? await OutboundMessage.findById(order.supplierEmail.messageId).select("status error acceptedAt sentAt").lean() : null;
  return { orderId: id, revision: order.revision, access: order.supplierAccess ? { expiresAt: order.supplierAccess.expiresAt, revokedAt: order.supplierAccess.revokedAt, active: !order.supplierAccess.revokedAt && order.supplierAccess.expiresAt! > new Date() } : null,
    documents: order.documents.map(documentView), email: email ? { status: email.status, queuedAt: order.supplierEmail!.queuedAt } : null,
    emailAvailable: supplierProviderReadiness().emailAvailable, storageAvailable: supplierProviderReadiness().storageAvailable, publicLinkOrigin: supplierProviderReadiness().appOrigin, supplierEmail: order.supplierSnapshot.email || "" };
}
export async function manageSupplierLink(req: FastifyRequest, id: string) {
  const input = object(req.body, ["locationId", "expectedRevision", "action", "confirmed", "expiresInHours"]), { scope } = await staffOrder(req, id, input.locationId), requestKey = key(req);
  if (input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision) || !["issue", "revoke"].includes(input.action) || input.action === "issue" && (!Number.isSafeInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > 168)) throw new CommandError(400, "Confirm a current order and a link duration between 1 and 168 hours");
  await executeRecordedCommand(`pharmacy-supplier-link:${scope.organizationId}:${scope.locationId}:${id}`, requestKey, { ...input, actorId: scope.actorId }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const order = await PharmacyPurchaseOrder.findOne(owner(scope, id)).session(session);
    if (!order || order.revision !== input.expectedRevision) throw new CommandError(409, "Order changed; refresh before sharing");
    await available(order, session); await pin(order, session!);
    if (input.action === "issue" && ["draft", "cancelled", "closed"].includes(order.state)) throw new CommandError(409, "Record the order as sent before sharing its supplier response link");
    const token = crypto.randomBytes(32).toString("hex"), access = input.action === "issue" ? { tokenHash: hash(token), tokenCiphertext: encryptField(token), issuedKey: requestKey, createdBy: scope.actorId, expiresAt: new Date(Date.now() + input.expiresInHours * 3600000) } : undefined;
    const change = access ? { $set: { supplierAccess: access }, $inc: { revision: 1 } } : { $set: { "supplierAccess.revokedAt": new Date() }, $inc: { revision: 1 } };
    if (!access && !order.supplierAccess) throw new CommandError(409, "No supplier link exists for this order");
    await PharmacyPurchaseOrder.updateOne(owner(scope, id), change as OrderUpdate, { session, runValidators: true });
    await audit(order, `PHARMACY_SUPPLIER_LINK_${input.action.toUpperCase()}`, { revision: order.revision + 1 }, session!, scope.actorId); return id;
  }), { writeConcern: { w: "majority" } });
  const order = (await staffOrder(req, id, input.locationId)).order;
  if (input.action === "issue" && (order.supplierAccess?.issuedKey !== requestKey || order.supplierAccess.revokedAt || order.supplierAccess.expiresAt! <= new Date())) throw new CommandError(409, "This original link was replaced, revoked or expired. Refresh before issuing another link");
  return { revision: order.revision, ...(input.action === "issue" ? { token: decryptField(order.supplierAccess!.tokenCiphertext!), expiresAt: order.supplierAccess!.expiresAt, publicLinkOrigin: supplierProviderReadiness().appOrigin } : { revoked: true }) };
}
export async function readPublicSupplierOrder(req: FastifyRequest) { const input = object(req.body, ["token"]); return publicView(await publicOrder(input.token)); }
export async function respondPublicSupplierOrder(req: FastifyRequest) {
  const raw = object(req.body, ["token", "input"]), initial = await publicOrder(raw.token);
  const input = purchaseOrderAction({ ...object(raw.input, ["expectedRevision", "action", "reference", "confirmed", "lines", "expectedDelivery"]), locationId: String(initial.locationId) });
  if (!["respond", "dispatch"].includes(input.action)) throw new CommandError(403, "Supplier links can only record quantities or dispatch");
  await executeRecordedCommand(`pharmacy-supplier-response:${initial._id}:${hash(raw.token)}`, key(req), input, () => withTransaction(async session => {
    requireStockTransaction(session);
    const order = await publicOrder(raw.token, session); await pin(order, session!);
    if (order.revision !== input.expectedRevision) throw new CommandError(409, "Order changed; refresh before confirming supplier details");
    const changes = supplierOrderChanges(order, input, { reference: input.reference, recordedAt: new Date() });
    const updated = await PharmacyPurchaseOrder.updateOne({ _id: order._id, revision: input.expectedRevision, "supplierAccess.tokenHash": hash(raw.token), "supplierAccess.revokedAt": null }, { $set: changes, $inc: { revision: 1 } } as OrderUpdate, { session, runValidators: true });
    if (!updated.modifiedCount) throw new CommandError(409, "Order changed; refresh before confirming");
    await audit(order, `PHARMACY_ORDER_SUPPLIER_${input.action.toUpperCase()}`, { revision: order.revision + 1, ...input }, session!); return String(order._id);
  }), { writeConcern: { w: "majority" } });
  return publicView(await publicOrder(raw.token));
}

export async function uploadSupplierDocument(req: FastifyRequest, id?: string) {
  const raw = object(req.body, id ? ["locationId", "name", "kind", "contentType", "base64Data", "supplierVisible", "confirmed"] : ["token", "name", "kind", "contentType", "base64Data", "confirmed"]);
  const staff = id ? await staffOrder(req, id, raw.locationId) : null, initial = staff?.order || await publicOrder(raw.token), source = staff ? "staff" : "supplier_link";
  if (raw.confirmed !== true || !["invoice", "credit_note", "statement", "dispatch", "other"].includes(raw.kind) || !["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(raw.contentType) || validateUploadMetadata(raw.name, raw.contentType, "other") || staff && typeof raw.supplierVisible !== "boolean") throw new CommandError(400, "Confirm a PDF or image document and its visibility");
  if (typeof raw.base64Data !== "string" || raw.base64Data.length > Math.ceil(maxBytes / 3) * 4 || Buffer.from(raw.base64Data, "base64").toString("base64") !== raw.base64Data) throw new CommandError(400, "Choose a PDF or image up to 4 MB");
  let bytes: Buffer; try { ({ buffer: bytes } = await prepareUploadBytes(Buffer.from(raw.base64Data, "base64"), raw.contentType, maxBytes, "other")); } catch { throw new CommandError(400, "Document is empty, too large, has a mismatched signature or contains active content"); }
  if (raw.contentType === "application/pdf" && /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia|Encrypt|XFA)\b/i.test(bytes.toString("latin1"))) throw new CommandError(400, "Use a flattened PDF without active content, attachments or encryption");
  const digest = hash(bytes), requestKey = key(req), commandScope = `pharmacy-supplier-document:${initial._id}:${staff ? staff.scope.actorId : hash(raw.token)}`;
  const payload = { name: raw.name, kind: raw.kind, contentType: raw.contentType, supplierVisible: staff ? raw.supplierVisible : true, digest, source };
  const prior = await OperationReceipt.findOne({ scope: commandScope, key: requestKey }).lean();
  if (prior && prior.requestHash !== commandHash(payload)) throw new CommandError(409, "This original document request has different details");
  let stored: string | undefined;
  try {
    const alreadyRetained = initial.documents.some(doc => doc.sha256 === digest && doc.kind === raw.kind && doc.source === source && doc.name === raw.name && doc.supplierVisible === payload.supplierVisible);
    if (!prior && !alreadyRetained && initial.documents.length >= 25) throw new CommandError(409, "At most 25 documents may be retained per order");
    if (!prior && !alreadyRetained) stored = await storeVerifiedObject(bytes, raw.contentType, String(initial.organizationId));
    await executeRecordedCommand(commandScope, requestKey, payload, () => withTransaction(async session => {
      requireStockTransaction(session);
      const order = staff ? await PharmacyPurchaseOrder.findOne(owner(staff.scope, id!)).session(session) : await publicOrder(raw.token, session);
      if (!order) throw new CommandError(404, "Order not found"); await available(order, session); await pin(order, session!);
      if (!staff && ["draft", "cancelled", "closed"].includes(order.state)) throw new CommandError(409, "Supplier uploads are closed for this order");
      const duplicate = order.documents.find(doc => doc.sha256 === digest && doc.kind === raw.kind && doc.source === source && doc.name === raw.name && doc.supplierVisible === payload.supplierVisible);
      if (duplicate) return String(order._id);
      if (order.documents.length >= 25) throw new CommandError(409, "At most 25 documents may be retained per order");
      if (!stored) throw new CommandError(409, "Document outcome is uncertain; retry the original file and reference");
      const documentId = crypto.randomUUID();
      await PharmacyPurchaseOrder.updateOne({ _id: order._id, organizationId: order.organizationId, locationId: order.locationId }, { $push: { documents: { documentId, ...payload, sha256: digest, objectKey: stored, size: bytes.length, createdAt: new Date(), createdBy: staff?.scope.actorId } }, $inc: { revision: 1 } } as OrderUpdate, { session, runValidators: true });
      await audit(order, "PHARMACY_SUPPLIER_DOCUMENT_ATTACHED", { documentId, kind: raw.kind, source, supplierVisible: payload.supplierVisible, inventoryPosted: false }, session!, staff?.scope.actorId); return String(order._id);
    }), { writeConcern: { w: "majority" } });
  } finally {
    // Never delete a possibly committed file after an uncertain transaction outcome.
    if (stored) { const retained = await PharmacyPurchaseOrder.exists({ _id: initial._id, "documents.objectKey": stored }).catch(() => true); if (!retained) await deleteObjectFromStorage(stored).catch(() => undefined); }
  }
  return staff ? supplierCollaboration({ ...req, query: { locationId: String(initial.locationId) } } as FastifyRequest, String(initial._id)) : publicView(await publicOrder(raw.token));
}
export async function supplierDocumentDownload(req: FastifyRequest, id?: string) {
  const raw = object(id ? req.query : req.body, id ? ["locationId", "documentId"] : ["token", "documentId"]), order = id ? (await staffOrder(req, id, raw.locationId)).order : await publicOrder(raw.token);
  const doc = order.documents.find(value => value.documentId === raw.documentId && (id || value.supplierVisible || value.source === "supplier_link"));
  if (!doc) throw new CommandError(404, "Document not found");
  return { url: await generatePresignedDownloadUrl(doc.objectKey, id ? 60 : Math.max(1, Math.min(60, Math.floor((order.supplierAccess!.expiresAt!.getTime() - Date.now()) / 1000)))), name: doc.name };
}
export async function emailSupplierLink(req: FastifyRequest, id: string) {
  const input = object(req.body, ["locationId", "expectedRevision", "confirmed"]), { scope } = await staffOrder(req, id, input.locationId), requestKey = key(req);
  if (input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision)) throw new CommandError(400, "Confirm sending the current supplier link by email");
  const readiness = supplierProviderReadiness();
  if (!readiness.emailAvailable) throw new CommandError(503, "Supplier email needs SMTP and a public HTTPS APP_URL. Copy the supplier link for manual sharing meanwhile");
  const appUrl = new URL(readiness.appOrigin!);
  await executeRecordedCommand(`pharmacy-supplier-email:${scope.organizationId}:${scope.locationId}:${id}`, requestKey, { ...input, actorId: scope.actorId }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const order = await PharmacyPurchaseOrder.findOne(owner(scope, id)).session(session);
    if (!order || order.revision !== input.expectedRevision || !order.supplierAccess || order.supplierAccess.revokedAt || order.supplierAccess.expiresAt! <= new Date()) throw new CommandError(409, "Refresh and issue a current supplier link before sending email");
    await available(order, session); await pin(order, session!);
    const supplier = await PharmacyParty.findOne({ _id: order.supplierId, organizationId: scope.organizationId, locationIds: scope.locationId }).session(session);
    if (!supplier?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email)) throw new CommandError(409, "Record the supplier's current email address first");
    const url = `${appUrl.origin}/supplier-order#${decryptField(order.supplierAccess.tokenCiphertext!)}`, plain = `Purchase order ${order.reference} from ${order.buyerSnapshot!.name}. Review quantities, respond and upload your invoice: ${url}\nThis private link expires ${order.supplierAccess.expiresAt!.toISOString()}. Forward only to the intended supplier. Stock is received only after pharmacy review.`;
    const message = await enqueueTransactionalEmail({ to: supplier.email, subject: `Purchase order ${order.reference}`, text: plain, html: `<p>${plain.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("\n", "<br>")}</p>`, idempotencyKey: `pharmacy-supplier-email:${order._id}:${requestKey}`, session });
    await PharmacyPurchaseOrder.updateOne(owner(scope, id), { $set: { supplierEmail: { messageId: message._id, queuedAt: new Date(), requestedBy: scope.actorId } }, $inc: { revision: 1 } } as OrderUpdate, { session });
    await audit(order, "PHARMACY_SUPPLIER_EMAIL_QUEUED", { messageId: String(message._id), deliveryConfirmed: false }, session!, scope.actorId); return id;
  }), { writeConcern: { w: "majority" } });
  return supplierCollaboration({ ...req, query: { locationId: input.locationId } } as FastifyRequest, id);
}
export async function supplierArchive(req: FastifyRequest, id: string) {
  const query = object(req.query, ["locationId", "cursor", "section"]), scope = await purchaseScope(req, query.locationId), supplierId = identifier(id);
  if (!await PharmacyParty.exists({ _id: supplierId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "supplier" })) throw new CommandError(404, "Supplier not found");
  const position = query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {}, filter = { organizationId: scope.organizationId, locationId: scope.locationId, ...position };
  if (query.section === "events") {
    const rows = await PharmacyCashEvent.find({ ...filter, partyId: supplierId, kind: { $in: ["supplier_payment", "supplier_credit", "supplier_refund"] } }).select("kind amountPaise currency paymentMethod referenceNumber recordedAt allocations").sort({ _id: -1 }).limit(26).maxTimeMS(5000).lean();
    return { items: rows.slice(0, 25).map(({ _id, ...row }) => ({ ...row, id: String(_id) })), nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
  }
  if (query.section !== "documents") throw new CommandError(400, "Choose supplier documents or financial events");
  const rows = await PharmacyPurchaseOrder.find({ ...filter, supplierId, "documents.0": { $exists: true } }).select("reference documents").sort({ _id: -1 }).limit(26).maxTimeMS(5000).lean();
  return { items: rows.slice(0, 25).map(row => ({ orderId: String(row._id), reference: row.reference, documents: row.documents.map(documentView) })), nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
}
