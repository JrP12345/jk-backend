import { CommandError } from "../services/CommandReceiptService.ts";
import { object, identifier, whole, text, calendarDate } from "./pharmacyPurchases.ts";
const plain = (value: unknown, name: string, min: number, max: number) => {
  const result = text(value, name, min, max);
  if (/[\p{Cc}\p{Cf}]/u.test(result)) throw new CommandError(400, `Use plain text for ${name}`);
  return result;
};
const lineId = (value: unknown) => { const id = text(value, "order line", 8, 100); if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new CommandError(400, "Invalid order line reference"); return id; };
export function purchaseOrderInput(raw: unknown, editing: boolean) {
  const row = object(raw, ["locationId", "supplierId", "expectedSupplierRevision", "expectedRevision", "reference", "notes", "lines", "organizationId", "organization_id"]);
  if (!Array.isArray(row.lines) || !row.lines.length || row.lines.length > 100) throw new CommandError(400, "An order needs 1 to 100 product lines");
  const lines = row.lines.map((value: unknown) => {
    const line = object(value, ["lineId", "medicineId", "expectedUnitVersion", "packs", "looseUnits"]);
    return { lineId: lineId(line.lineId), medicineId: identifier(line.medicineId), expectedUnitVersion: whole(line.expectedUnitVersion, "unit revision"),
      packs: whole(line.packs, "packs", 1_000_000_000), looseUnits: whole(line.looseUnits, "loose units", 1_000_000_000) };
  });
  if (new Set(lines.map(line => line.lineId)).size !== lines.length || new Set(lines.map(line => line.medicineId)).size !== lines.length) throw new CommandError(400, "Use one distinct line per product");
  return { locationId: identifier(row.locationId), supplierId: identifier(row.supplierId), expectedSupplierRevision: whole(row.expectedSupplierRevision, "supplier revision"),
    ...(editing ? { expectedRevision: whole(row.expectedRevision, "order revision", Number.MAX_SAFE_INTEGER - 1) } : {}),
    reference: row.reference ? plain(row.reference, "order reference", 1, 80) : "", notes: row.notes ? plain(row.notes, "notes", 0, 1000) : "", lines };
}
export function purchaseOrderAction(raw: unknown) {
  const row = object(raw, ["locationId", "expectedRevision", "action", "reference", "channel", "expectedDelivery", "lines", "purchaseId", "confirmed", "confirmVariance", "organizationId", "organization_id"]);
  if (row.confirmed !== true || !["submit", "respond", "dispatch", "cancel", "link_invoice", "close_remainder"].includes(row.action)) throw new CommandError(400, "Confirm the exact order action");
  const base = { locationId: identifier(row.locationId), expectedRevision: whole(row.expectedRevision, "order revision", Number.MAX_SAFE_INTEGER - 1), action: row.action as "submit" | "respond" | "dispatch" | "cancel" | "link_invoice" | "close_remainder",
    reference: plain(row.reference, "communication / review reference", 3, 300) };
  if (row.action === "submit" && !["whatsapp", "email", "phone", "other"].includes(row.channel)) throw new CommandError(400, "Record how staff actually sent this order");
  let lines;
  if (row.action === "respond") {
    if (!Array.isArray(row.lines) || !row.lines.length || row.lines.length > 100) throw new CommandError(400, "Record a response for every order line");
    lines = row.lines.map((value: unknown) => {
      const line = object(value, ["lineId", "acceptedQuantity", "quotedUnitPricePaise", "note"]);
      return { lineId: lineId(line.lineId), acceptedQuantity: whole(line.acceptedQuantity, "accepted base units", 1_000_000_000),
        ...(line.quotedUnitPricePaise === undefined ? {} : { quotedUnitPricePaise: whole(line.quotedUnitPricePaise, "actual quoted unit price", 100_000_000_000) }), note: line.note ? plain(line.note, "supplier line note", 0, 300) : "" };
    });
    if (new Set(lines.map(line => line.lineId)).size !== lines.length) throw new CommandError(400, "Duplicate response lines");
  }
  return { ...base, ...(row.action === "submit" ? { channel: row.channel as string } : {}),
    ...(row.action === "dispatch" && row.expectedDelivery ? { expectedDelivery: calendarDate(row.expectedDelivery) } : {}),
    ...(row.action === "link_invoice" ? { purchaseId: identifier(row.purchaseId), confirmVariance: row.confirmVariance === true } : {}), ...(lines ? { lines } : {}) };
}
