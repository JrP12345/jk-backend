import { object, identifier, whole, text } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export function pharmacyReturnInput(raw: unknown, commit = false) {
  const body = object(raw, ["locationId", "lines", "reason", "reviewReference", "confirmedQuarantine", ...(commit ? ["expectedReturnRevision", "expectedPaymentRevision", "expectedCreditPaise"] : []), "organizationId", "organization_id"]);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100 || body.confirmedQuarantine !== true) throw new CommandError(400, "Confirm physical quarantine and select 1 to 100 returned source lots");
  const seen = new Set<string>(), lines = body.lines.map((rawLine: unknown) => {
    const line = object(rawLine, ["sourceLineId", "sourceBatchId", "quantity", "condition"]), sourceLineId = identifier(line.sourceLineId), sourceBatchId = identifier(line.sourceBatchId), quantity = whole(line.quantity, "returned base quantity", Number.MAX_SAFE_INTEGER);
    if (!quantity || seen.has(`${sourceLineId}:${sourceBatchId}`) || !["unopened", "opened", "damaged", "expired", "unknown"].includes(line.condition)) throw new CommandError(400, "Return distinct source lots with positive whole quantities and actual condition");
    seen.add(`${sourceLineId}:${sourceBatchId}`); return { sourceLineId, sourceBatchId, quantity, condition: line.condition as string };
  });
  return { locationId: identifier(body.locationId), reason: text(body.reason, "return reason", 3, 500), reviewReference: text(body.reviewReference, "return approval reference", 3, 200), confirmedQuarantine: true as const, lines,
    ...(commit ? { expectedReturnRevision: whole(body.expectedReturnRevision, "return revision", Number.MAX_SAFE_INTEGER - 1), expectedPaymentRevision: whole(body.expectedPaymentRevision, "payment revision", Number.MAX_SAFE_INTEGER - 1), expectedCreditPaise: whole(body.expectedCreditPaise, "confirmed credit") } : {}) };
}
