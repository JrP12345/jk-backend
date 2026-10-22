import { object, identifier, whole, text } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export function purchaseReturnInput(raw: unknown, commit = false) {
  const body = object(raw, ["locationId", "lines", "reason", "reviewReference", ...(commit ? ["expectedPurchaseRevision", "expectedSettlementRevision", "expectedCreditPaise"] : []), "organizationId", "organization_id"]);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) throw new CommandError(400, "Select 1 to 100 actual received source lots");
  const ids = new Set<string>(), lines = body.lines.map((rawLine: unknown) => {
    const line = object(rawLine, ["receiptId", "receiptLineId", "quantity", ...(commit ? ["expectedStockRevision"] : [])]);
    const receiptId = identifier(line.receiptId), receiptLineId = text(line.receiptLineId, "received source line", 8, 100), quantity = whole(line.quantity, "returned base units", Number.MAX_SAFE_INTEGER);
    if (!quantity || !/^[a-zA-Z0-9_-]+$/.test(receiptLineId) || ids.has(`${receiptId}:${receiptLineId}`)) throw new CommandError(400, "Return distinct received source lots with positive whole quantities"); ids.add(`${receiptId}:${receiptLineId}`);
    return { receiptId, receiptLineId, quantity, ...(commit ? { expectedStockRevision: whole(line.expectedStockRevision, "stock revision", Number.MAX_SAFE_INTEGER - 1) } : {}) };
  });
  return { locationId: identifier(body.locationId), reason: text(body.reason, "supplier return reason", 3, 500), reviewReference: text(body.reviewReference, "supplier return source/approval", 3, 200), lines,
    ...(commit ? { expectedPurchaseRevision: whole(body.expectedPurchaseRevision, "purchase revision", Number.MAX_SAFE_INTEGER - 1), expectedSettlementRevision: whole(body.expectedSettlementRevision, "settlement revision", Number.MAX_SAFE_INTEGER - 1), expectedCreditPaise: whole(body.expectedCreditPaise, "confirmed expected credit") } : {}) };
}
