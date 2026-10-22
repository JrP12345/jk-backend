import { calendarDate, identifier, object } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export const pharmacyReportKinds = ["stock", "low_stock", "expiry", "valuation", "dead_stock", "movements", "purchases", "sales", "collections", "sales_returns", "purchase_returns", "supplier_dues", "customer_dues", "tax", "cash_events"] as const;
export type PharmacyReportKind = typeof pharmacyReportKinds[number];
export function pharmacyReportInput(raw: unknown, rawKind: unknown) {
  const query = object(raw, ["locationId", "startDate", "endDate", "cursor", "limit", "days", "expectedDigest", "organizationId", "organization_id"]);
  if (!pharmacyReportKinds.includes(rawKind as PharmacyReportKind)) throw new CommandError(400, "Unsupported pharmacy report");
  const limit = query.limit === undefined ? 25 : Number(query.limit), days = query.days === undefined ? 90 : Number(query.days);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25 || !Number.isSafeInteger(days) || days < 1 || days > 365 || query.limit !== undefined && !/^\d+$/.test(String(query.limit)) || query.days !== undefined && !/^\d+$/.test(String(query.days))) throw new CommandError(400, "Report page size must be 1 to 25 and lookback/expiry days 1 to 365");
  const kind = rawKind as PharmacyReportKind;
  let cursor: string | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string") throw new CommandError(400, "Invalid report cursor");
    if (kind === "supplier_dues") {
      if (!/^(p:[a-f\d]{24}|o:(start|[a-f\d]{24}))$/i.test(query.cursor)) throw new CommandError(400, "Invalid supplier report cursor"); cursor = query.cursor.toLowerCase();
    } else cursor = identifier(query.cursor);
  }
  if ((query.startDate === undefined) !== (query.endDate === undefined)) throw new CommandError(400, "Choose both report dates");
  const startDate = query.startDate === undefined ? undefined : calendarDate(query.startDate), endDate = query.endDate === undefined ? undefined : calendarDate(query.endDate);
  if (startDate && endDate && (startDate > endDate || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 92)) throw new CommandError(400, "Report dates must be ordered within 93 calendar days");
  if (query.expectedDigest !== undefined && (typeof query.expectedDigest !== "string" || !/^[a-f\d]{64}$/.test(query.expectedDigest))) throw new CommandError(400, "Invalid report review digest");
  return { kind, locationId: identifier(query.locationId), limit, days, cursor, startDate, endDate, expectedDigest: query.expectedDigest as string | undefined };
}
export type PharmacyReportInput = ReturnType<typeof pharmacyReportInput>;
