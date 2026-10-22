import type { FastifyRequest } from "fastify";
import { PharmacyImport } from "../models/PharmacyImport.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { Medicine } from "../models/Medicine.ts";
import { Organization } from "../models/Organization.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { importCommitInput } from "../schemas/pharmacyImports.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { loadPharmacyImport, readPharmacyImport, requireImportScope, importOperationScope } from "./PharmacyImportPreviewService.ts";
import { receivePharmacyOpeningGroup, requireReceiptIndexes } from "./PharmacyStockReceiptService.ts";
import { createOpeningBalance } from "./PharmacyOpeningBalanceService.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { normalizeStockReceipt } from "../utilities/pharmacyLot.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { escapeCsv } from "./ReportExportService.ts";

export async function commitPharmacyImport(req: FastifyRequest, id: string) {
  const input = importCommitInput(req.body), { scope, manifest, payload } = await loadPharmacyImport(req, id, input.locationId);
  if (manifest.digest !== input.expectedDigest) throw new CommandError(409, "Import review changed; reload the manifest before posting");
  const selected = input.sourceKeys.map(key => payload.units.find(unit => unit.sourceKey === key));
  if (selected.some(unit => !unit || unit.invalid)) throw new CommandError(409, "Choose only valid reviewed source units; invalid rows cannot enter stock or dues");
  if (payload.kind === "opening_stock") {
    // Index commands cannot run inside stock transactions. No request changes indexes.
    for (const unit of selected) for (const receipt of unit!.facts as Record<string, unknown>[]) await requireReceiptIndexes(normalizeStockReceipt(receipt));
  }
  for (const unit of selected) {
    await requireImportScope(req, scope.locationId, payload.kind);
    const rows = payload.rows.filter(row => unit!.rows.includes(row.sourceLine));
    try {
      await executeRecordedCommand(importOperationScope(scope, payload.kind), unit!.sourceKey, {
        version: 1, kind: payload.kind, sourceReference: payload.sourceReference, facts: unit!.facts,
      }, () => withTransaction(async session => {
        requireStockTransaction(session);
        const organization = await Organization.findOneAndUpdate({ _id: scope.organizationId, countryCode: "IN", currency: "INR", isActive: { $ne: false }, status: { $ne: "inactive" } }, { $inc: { __v: 1 } }, { session });
        if (!organization) throw new CommandError(409, "New import sources require an active explicit India/INR organization; existing source recovery remains available");
        let resultId: string, data: Record<string, unknown>;
        if (payload.kind === "catalogue") {
          const record = await createWithSession<InstanceType<typeof Medicine>>(Medicine, { ...rows[0].data!, locationId: scope.locationId, stockQuantity: 0 }, session);
          await pinActivePharmacyLocation(scope.locationId, session);
          resultId = record.id; data = { medicineId: resultId, sourceId: rows[0].sourceId, stockQuantity: 0, classificationReviewRequired: true, taxReviewRequired: true };
        } else if (payload.kind === "opening_stock") {
          const receipts = rows.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0).map(row => {
            const { quantity: _quantity, unit: _unit, ...receipt } = row.data!;
            return normalizeStockReceipt(receipt);
          });
          const results = await receivePharmacyOpeningGroup(scope, unit!.sourceKey, receipts, session);
          resultId = results[0].batchId;
          data = { medicineId: receipts[0].medicineId, lots: results.map((result, index) => ({ sourceId: rows[index].sourceId, batchId: result.batchId, quantity: result.receivedQuantity })),
            receivedQuantity: results.reduce((sum, result) => sum + result.receivedQuantity, 0), purchaseTotalPaise: receipts.reduce((sum, receipt) => sum + receipt.purchaseTotalPaise, 0) };
        } else {
          // Reuse the existing immutable source, statement numbering, invoice and receipt transaction.
          const commandRequest = Object.assign(Object.create(req), { body: rows[0].data, headers: { ...req.headers, "idempotency-key": unit!.sourceKey } }) as FastifyRequest;
          const opening = await createOpeningBalance(commandRequest);
          resultId = opening.openingBalanceId; data = opening;
        }
        await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_IMPORT_SOURCE_POSTED", category: payload.kind.endsWith("dues") ? "BILLING" : "ADMIN", targetModel: "PharmacyImport", targetId: manifest._id,
          details: { digest: manifest.digest, sourceKey: unit!.sourceKey, kind: payload.kind, sourceLines: unit!.rows, resultId } }, session);
        const saved = await OperationReceipt.updateOne({ scope: importOperationScope(scope, payload.kind), key: unit!.sourceKey }, { $set: { responseCiphertext: JSON.stringify({ version: 1, data }) } }).session(session);
        if (saved.matchedCount !== 1) throw new CommandError(409, "Import source reservation changed; retain this manifest");
        return resultId;
      }), { writeConcern: { w: "majority" } });
    } catch (error) {
      const known = error instanceof CommandError || (error as { code?: number }).code === 11000;
      const message = error instanceof CommandError ? error.message : known ? "Source identity or barcode already exists; review its original result" : "Source outcome needs reconciliation; retain this manifest and check before retrying";
      await PharmacyImport.updateOne({ _id: manifest._id, actorId: scope.actorId }, { $set: { [`sourceErrors.${unit!.sourceKey}`]: message } });
      if (!known) break;
    }
  }
  return readPharmacyImport(req, manifest.id, scope.locationId);
}

/** Results are source reconciliation, never historical turnover or a replacement balance ledger. */
export async function exportPharmacyImport(req: FastifyRequest, id: string, locationId: unknown) {
  const view = await readPharmacyImport(req, id, locationId), scope = await requireImportScope(req, locationId, view.kind);
  await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_IMPORT_RECONCILIATION_EXPORTED", category: "ADMIN", targetModel: "PharmacyImport", targetId: id,
    details: { digest: view.digest, fileHash: view.fileHash, ...view.counts } }, null);
  const header = ["manifest", "digest", "kind", "source_reference", "source_line", "source_id", "status", "error", "result"];
  const lines = view.rows.map(row => {
    const unit = view.units.find(item => item.sourceKey === row.sourceKey)!;
    return [view.id, view.digest, view.kind, view.sourceReference, String(row.sourceLine), row.sourceId, unit.status, row.error || unit.error || "", unit.result ? JSON.stringify(unit.result) : ""].map(escapeCsv).join(",");
  });
  return `\uFEFF${header.map(escapeCsv).join(",")}\r\n${lines.join("\r\n")}\r\n`;
}
