import { object, identifier, whole, text } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export function pharmacyCollectionInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedPaymentRevision", "expectedBalancePaise", "entries", "cashTenderedPaise", "manualConfirmed", "organizationId", "organization_id"]);
  if (body.manualConfirmed !== true || !Array.isArray(body.entries) || !body.entries.length || body.entries.length > 10) throw new CommandError(400, "Explicit confirmation and 1 to 10 actual receipt components are required");
  const ids = new Set<string>(); let cash = 0;
  const entries = body.entries.map((rawEntry: unknown) => {
    const entry = object(rawEntry, ["componentId", "amountPaise", "paymentMethod", "referenceNumber"]), componentId = text(entry.componentId, "receipt component", 8, 60);
    if (!/^[a-zA-Z0-9_-]+$/.test(componentId) || ids.has(componentId) || !["cash", "upi", "card"].includes(entry.paymentMethod)) throw new CommandError(400, "Receipt components need distinct references and a supported manual method");
    ids.add(componentId); const amountPaise = whole(entry.amountPaise, "collected paise");
    if (!amountPaise) throw new CommandError(400, "A collection component must be positive");
    const referenceNumber = entry.referenceNumber === undefined ? undefined : text(entry.referenceNumber, "actual payment evidence", 3, 200);
    if (entry.paymentMethod !== "cash" && !referenceNumber) throw new CommandError(400, "Record the actual terminal or UPI reference after confirming the payment");
    if (entry.paymentMethod === "cash") cash += amountPaise;
    return { componentId, amountPaise, paymentMethod: entry.paymentMethod as "cash" | "upi" | "card", ...(referenceNumber ? { referenceNumber } : {}) };
  });
  const cashTenderedPaise = whole(body.cashTenderedPaise, "cash tendered");
  if (!Number.isSafeInteger(cash) || cashTenderedPaise < cash || cash === 0 && cashTenderedPaise !== 0) throw new CommandError(400, "Cash tender must cover only the cash allocation; change is computed by the server");
  return { locationId: identifier(body.locationId), expectedPaymentRevision: whole(body.expectedPaymentRevision, "payment revision", Number.MAX_SAFE_INTEGER - 1),
    expectedBalancePaise: whole(body.expectedBalancePaise, "expected remaining balance"), entries, cashTenderedPaise, manualConfirmed: true };
}
