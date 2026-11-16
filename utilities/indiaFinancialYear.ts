import { CommandError } from "../services/CommandReceiptService.ts";

export function indiaFinancialYear(at = new Date()) {
  if (!Number.isFinite(at.getTime())) throw new CommandError(409, "Invalid invoice issue date");
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric" }).formatToParts(at);
  const year = Number(parts.find(part => part.type === "year")!.value), month = Number(parts.find(part => part.type === "month")!.value);
  const start = month >= 4 ? year : year - 1;
  if (start < 2000 || start > 2098) throw new CommandError(409, "Invoice financial year needs a reviewed numbering version");
  return { start, label: `${start}-${String(start + 1).slice(-2)}`, code: `${String(start).slice(-2)}${String(start + 1).slice(-2)}` };
}
