import type { FastifyReply, FastifyRequest } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PharmacyExternalPrescription } from "../models/PharmacyExternalPrescription.ts";
import { externalPrescriptionDocument, readExternalPrescription, recordExternalPrescription, reviewedExternalMedicine } from "../services/PharmacyExternalPrescriptionService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { object, identifier, text, whole } from "../schemas/pharmacyPurchases.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
import { PharmacyInventoryError, requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { postCounterInvoice, postCounterQuote, getCounterInvoice } from "./pharmacySales.ts";

export function externalPrescriptionController(action: "list" | "read" | "bill" | "record" | "cancel" | "products" | "quote" | "supply") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (action === "record") return reply.code(201).send(successResponse(await recordExternalPrescription(req)));
      if (action === "quote" || action === "supply") {
        if (!(req.body as { externalPrescription?: unknown })?.externalPrescription) throw new CommandError(400, "An external prescription source and revision are required");
        return action === "quote" ? postCounterQuote(req, reply) : postCounterInvoice(req, reply);
      }
      const query = object(action === "cancel" ? req.body : req.query, ["locationId", "cursor", "search", "expectedRevision", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
      if (action === "bill") {
        const id = identifier((req.params as { id: string }).id);
        if (!await PharmacyDispense.exists({ invoiceId: id, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy", externalPrescriptionId: { $exists: true } })) throw new CommandError(404, "External prescription bill not found");
        await AuditLog.create({ userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_EXTERNAL_PRESCRIPTION_BILL_READ", category: "CLINICAL_READ", targetModel: "Invoice", targetId: id });
        return getCounterInvoice(req, reply);
      }
      if (action === "products") {
        const search = query.search === undefined ? "" : text(query.search, "medicine search", 0, 100), escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rows = await Medicine.find({ locationId: scope.locationId, deletedAt: null, ...(search ? { $or: [{ name: new RegExp(`^${escaped}`, "i") }, { genericName: new RegExp(`^${escaped}`, "i") }] } : {}) }).select("name genericName scheduleType unitDefinition dispensingRevision dispensingReview").sort({ name: 1, _id: 1 }).limit(50).lean();
        return reply.send(successResponse({ items: rows.filter(reviewedExternalMedicine).map(row => ({ id: String(row._id), name: row.name, genericName: row.genericName, scheduleType: row.scheduleType, baseUnit: row.unitDefinition!.baseUnit, unitVersion: row.unitDefinition!.version, dispensingRevision: row.dispensingRevision })) }));
      }
      if (action === "list") {
        const rows = await PharmacyExternalPrescription.find({ organizationId: scope.organizationId, locationId: scope.locationId, ...(query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {}) }).select("+evidenceCiphertext").sort({ _id: -1 }).limit(26);
        const page = rows.slice(0, 25);
        await AuditLog.create({ userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_EXTERNAL_PRESCRIPTIONS_READ", category: "CLINICAL_READ", details: { locationId: scope.locationId, count: page.length } });
        return reply.send(successResponse({ items: page.map(row => { const doc = externalPrescriptionDocument(row); return { id: doc.id, revision: doc.revision, reference: doc.reference, patientName: doc.patientName, status: doc.status, validUntil: doc.validUntil }; }), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
      }
      const id = identifier((req.params as { id: string }).id);
      if (action === "cancel") {
        const expectedRevision = whole(query.expectedRevision, "prescription revision", Number.MAX_SAFE_INTEGER - 1);
        await withTransaction(async session => {
          requireStockTransaction(session);
          const changed = await PharmacyExternalPrescription.updateOne({ _id: id, organizationId: scope.organizationId, locationId: scope.locationId, status: "approved", revision: expectedRevision }, { $set: { status: "cancelled" }, $inc: { revision: 1 } });
          if (!changed.modifiedCount) throw new CommandError(409, "Prescription changed or is already closed; reload it");
          await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_EXTERNAL_PRESCRIPTION_CANCELLED", category: "CLINICAL_WRITE", targetModel: "PharmacyExternalPrescription", targetId: id, details: { expectedRevision } }, session);
        });
      }
      const row = await readExternalPrescription(scope, id);
      await AuditLog.create({ userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_EXTERNAL_PRESCRIPTION_READ", category: "CLINICAL_READ", targetModel: "PharmacyExternalPrescription", targetId: row._id });
      return reply.send(successResponse(externalPrescriptionDocument(row)));
    } catch (error) {
      if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
      if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("This prescription reference is already recorded for this prescriber at this branch. Open the existing record."));
      req.log.error({ err: error }, "External prescription operation failed");
      return reply.code(500).send(errorResponse("Prescription operation could not be confirmed. Retry the same operation before creating another."));
    }
  };
}
