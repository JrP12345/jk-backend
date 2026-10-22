import type { FastifyReply, FastifyRequest } from "fastify";
import { PharmacyImport } from "../models/PharmacyImport.ts";
import { object, identifier } from "../schemas/pharmacyPurchases.ts";
import { PHARMACY_IMPORT_FIELDS, type PharmacyImportKind } from "../schemas/pharmacyImports.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { inspectPharmacyImport, previewPharmacyImport, readPharmacyImport, requireImportScope } from "../services/PharmacyImportPreviewService.ts";
import { commitPharmacyImport, exportPharmacyImport } from "../services/PharmacyImportService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

const failure = (reply: FastifyReply, error: unknown) => reply.code(error instanceof CommandError ? error.statusCode : 500).send(errorResponse(error instanceof CommandError ? error.message : "Import outcome could not be confirmed. Retain the reviewed manifest and check its source results before retrying."));
export const postPharmacyImport = (operation: "inspect" | "preview" | "commit") => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try {
    const result = operation === "inspect" ? await inspectPharmacyImport(req) : operation === "preview" ? await previewPharmacyImport(req) : await commitPharmacyImport(req, (req.params as { id: string }).id);
    return reply.send(successResponse(result));
  } catch (error) { return failure(reply, error); }
};
export const getPharmacyImport = (exporting = false) => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "organizationId", "organization_id"]), id = (req.params as { id: string }).id;
    if (exporting) {
      const csv = await exportPharmacyImport(req, id, query.locationId);
      return reply.type("text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="pharmacy-import-reconciliation.csv"').send(csv);
    }
    return reply.send(successResponse(await readPharmacyImport(req, id, query.locationId)));
  } catch (error) { return failure(reply, error); }
};
export async function listPharmacyImports(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const kinds: PharmacyImportKind[] = [];
    for (const kind of Object.keys(PHARMACY_IMPORT_FIELDS) as Array<keyof typeof PHARMACY_IMPORT_FIELDS>) {
      try { await requireImportScope(req, scope.locationId, kind); kinds.push(kind); } catch (error) { if (!(error instanceof CommandError) || error.statusCode !== 403) throw error; }
    }
    if (!kinds.length) throw new CommandError(403, "Current import source permissions are required");
    const rows = await PharmacyImport.find({ ...scope, kind: { $in: kinds }, ...(query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {}) }).select("kind digest fileHash createdAt").sort({ _id: -1 }).limit(21).lean();
    return reply.send(successResponse({ items: rows.slice(0, 20).map(row => ({ id: String(row._id), kind: row.kind, digest: row.digest, fileHash: row.fileHash, createdAt: row.createdAt })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null }));
  } catch (error) { return failure(reply, error); }
}
