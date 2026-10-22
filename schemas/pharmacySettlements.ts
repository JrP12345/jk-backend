import { object, identifier, text, whole, calendarDate } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export type SettlementKind = "supplier_credit" | "supplier_payment" | "supplier_refund" | "customer_refund";
export interface SettlementInput { locationId: string; amountPaise: number; paymentMethod: "none" | "cash" | "upi" | "card" | "bank"; referenceNumber: string; normalizedReference: string; reviewReference: string; manualConfirmed: boolean; invoiceId?: string; expectedPaymentRevision?: number; expectedRefundPayablePaise?: number; supplierId?: string; sourceDate?: string; allocations: Array<{ purchaseId?: string; purchaseReturnId?: string; openingBalanceId?: string; amountPaise: number; expectedSettlementRevision: number }> }
export function settlementInput(raw: unknown, kind: SettlementKind): SettlementInput {
  const customer = kind === "customer_refund", credit = kind === "supplier_credit";
  const body = object(raw, ["locationId", "amountPaise", "paymentMethod", "referenceNumber", "reviewReference", "manualConfirmed", "allocations", ...(customer ? ["invoiceId", "expectedPaymentRevision", "expectedRefundPayablePaise"] : ["supplierId"]), ...(credit ? ["sourceDate"] : []), "organizationId", "organization_id"]);
  const amountPaise = whole(body.amountPaise, "confirmed amount"), paymentMethod = credit ? "none" : body.paymentMethod;
  if (!amountPaise || body.manualConfirmed !== true || credit && body.paymentMethod !== undefined && body.paymentMethod !== "none" || !credit && !["cash", "upi", "card", "bank"].includes(paymentMethod)) throw new CommandError(400, "Confirm actual supplier credit or money movement and its exact amount/method");
  const referenceNumber = text(body.referenceNumber, "actual document/payment reference", 3, 200).normalize("NFKC"), normalizedReference = referenceNumber.toUpperCase().replace(/\s+/g, "");
  if (/[\p{Cc}\p{Cf}]/u.test(referenceNumber)) throw new CommandError(400, "Reference cannot contain hidden format/control characters");
  const common = { locationId: identifier(body.locationId), amountPaise, paymentMethod: paymentMethod as "none" | "cash" | "upi" | "card" | "bank", referenceNumber, normalizedReference, reviewReference: text(body.reviewReference, "actual settlement review", 3, 200), manualConfirmed: true };
  if (customer) {
    if (body.allocations !== undefined) throw new CommandError(400, "Customer refund source is its exact invoice");
    return { ...common, invoiceId: identifier(body.invoiceId), expectedPaymentRevision: whole(body.expectedPaymentRevision, "payment revision", Number.MAX_SAFE_INTEGER - 1), expectedRefundPayablePaise: whole(body.expectedRefundPayablePaise, "refund payable"), allocations: [] as Array<{ purchaseId?: string; purchaseReturnId?: string; amountPaise: number; expectedSettlementRevision: number }> };
  }
  if (!Array.isArray(body.allocations) || !body.allocations.length || body.allocations.length > 100) throw new CommandError(400, "Allocate the actual amount to 1 to 100 supplier sources");
  const ids = new Set<string>(), allocations = body.allocations.map((rawLine: unknown) => {
    const line = object(rawLine, [credit ? "purchaseReturnId" : "purchaseId", "openingBalanceId", "amountPaise", "expectedSettlementRevision"]);
    const sourceId = credit ? line.purchaseReturnId : line.purchaseId;
    if ((sourceId !== undefined) === (line.openingBalanceId !== undefined)) throw new CommandError(400, "Select exactly one purchase/return or opening balance source");
    const id = identifier(sourceId ?? line.openingBalanceId), amountPaise = whole(line.amountPaise, "allocated amount");
    if (!amountPaise || ids.has(id)) throw new CommandError(400, "Use distinct source allocations and positive amounts"); ids.add(id);
    return { ...(line.openingBalanceId !== undefined ? { openingBalanceId: id } : credit ? { purchaseReturnId: id } : { purchaseId: id }), amountPaise, expectedSettlementRevision: whole(line.expectedSettlementRevision, "settlement revision", Number.MAX_SAFE_INTEGER - 1) };
  });
  if (allocations.reduce((sum: bigint, row: { amountPaise: number }) => sum + BigInt(row.amountPaise), 0n) !== BigInt(amountPaise)) throw new CommandError(400, "Supplier allocations must sum to the actual amount");
  return { ...common, supplierId: identifier(body.supplierId), allocations, ...(credit ? { sourceDate: calendarDate(body.sourceDate) } : {}) };
}
