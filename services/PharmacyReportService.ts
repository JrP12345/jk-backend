import type { FastifyRequest } from "fastify";
import { Organization } from "../models/Organization.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { pharmacyReportInput, pharmacyReportKinds, type PharmacyReportKind } from "../schemas/pharmacyReports.ts";
import { getEffectivePermissions } from "../utilities/permissions.ts";
import { pharmacyAllows, type PharmacyAction } from "../utilities/pharmacyPermissions.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { getLocationTimezone, locationDateKey, locationDayRange } from "../utilities/locationTime.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, commandHash } from "./CommandReceiptService.ts";
import { stockReport } from "./PharmacyStockReportService.ts";
import { financeReport } from "./PharmacyFinanceReportService.ts";
import { reportNumber, type ReportRow, type ReportColumn } from "./PharmacyReportTypes.ts";
import { escapeCsv } from "./ReportExportService.ts";
const grants: Record<PharmacyReportKind, PharmacyAction[]> = {
  stock: ["viewStock"], low_stock: ["viewStock"], expiry: ["viewStock"], dead_stock: ["viewStock"], valuation: ["viewStock", "viewCost"], movements: ["readMovements"],
  purchases: ["viewPurchases"], purchase_returns: ["viewPurchases"], supplier_dues: ["viewPurchases"], sales: ["viewSales"], collections: ["viewSales"], tax: ["viewSales"], sales_returns: ["viewReturns"], customer_dues: ["viewReturns"], cash_events: ["viewSettlements"],
};
export const pharmacyReportLabels: Record<PharmacyReportKind, string> = { stock: "Stock and eligible units", low_stock: "Low saleable stock", expiry: "Expiry and expired stock", valuation: "Captured stock cost", dead_stock: "Stock without recent supply", movements: "Stock movements", purchases: "Posted supplier bills", sales: "Original pharmacy supplies", collections: "Actual pharmacy collections", sales_returns: "Customer return credits", purchase_returns: "Supplier goods returns", supplier_dues: "Supplier dues and credits pending", customer_dues: "Customer dues and refunds payable", tax: "Captured supply tax", cash_events: "Cash movements and supplier documents" };
async function reportAuthority(req: FastifyRequest) {
  if (!req.user || ["patient", "family_member", "guest"].includes(req.user.role)) throw new CommandError(403, "Pharmacy reports require authorized staff");
  const permissions = await getEffectivePermissions(req.user.role, req.user.organization_id, req.user.authVersion, true);
  return (action: PharmacyAction) => pharmacyAllows(permissions, action, req.user!.role === "root");
}
export async function reportCatalogue(req: FastifyRequest, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), allows = await reportAuthority(req);
  if (!allows("viewReports")) throw new CommandError(403, "Pharmacy report permission is required");
  return { locationId: scope.locationId, items: pharmacyReportKinds.filter(kind => grants[kind].every(allows)).map(kind => ({ kind, label: pharmacyReportLabels[kind] })) };
}
export async function readPharmacyReport(req: FastifyRequest, rawKind: unknown, exporting = false, basicAlert = false) {
  const input = pharmacyReportInput(req.query, rawKind), scope = await purchaseScope(req, input.locationId), allows = await reportAuthority(req);
  if (basicAlert && !["low_stock", "expiry"].includes(input.kind) || !basicAlert && !allows("viewReports") || !grants[input.kind].every(allows)) throw new CommandError(403, "The report requires current stock, cost or financial-source permission");
  if (exporting && (basicAlert || !input.expectedDigest)) throw new CommandError(428, "Review the report page before requesting its export");
  if (!exporting && input.expectedDigest) throw new CommandError(400, "Review digests apply only to exports");
  const current = ["stock", "low_stock", "expiry", "valuation", "dead_stock", "supplier_dues", "customer_dues"].includes(input.kind);
  if (current && input.startDate) throw new CommandError(400, "Current stock and dues do not reconstruct historical balances; use the explicit expiry or inactivity window");
  const timezone = await getLocationTimezone(scope.locationId), asOf = new Date(), today = locationDateKey(asOf, timezone), defaultStart = new Date(`${today}T12:00:00Z`); defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
  const startDate = input.startDate || (current ? today : defaultStart.toISOString().slice(0, 10)), endDate = input.endDate || today;
  if (endDate > today) throw new CommandError(400, "Report period cannot end in the future");
  const start = locationDayRange(startDate, timezone).start, end = new Date(Math.min(locationDayRange(endDate, timezone).end.getTime(), asOf.getTime()));
  return withTransaction(async session => {
    if (!session) throw new CommandError(503, "Consistent pharmacy reports require a transaction-capable database");
    const org = await Organization.findById(scope.organizationId).select("currency countryCode").session(session).lean();
    if (org?.currency !== "INR" || org.countryCode !== "IN") throw new CommandError(409, "Pharmacy reports require the configured India/INR source currency");
    const cashKinds = ["cash_in", "cash_out", ...(allows("viewPurchases") ? ["supplier_credit", "supplier_payment", "supplier_refund"] : []), ...(allows("viewReturns") ? ["customer_refund"] : [])];
    const context = { input, scope, session, asOf, start, end, cashKinds };
    const result = ["stock", "low_stock", "expiry", "valuation", "dead_stock"].includes(input.kind) ? await stockReport(context) : await financeReport(context);
    const totals: Record<string, number | null> = {};
    for (const column of result.columns.filter(column => column.format === "paise" && !(input.kind === "cash_events" && column.key === "amountPaise"))) {
      const values = result.rows.map(row => row[column.key]);
      if (values.some(value => value === null)) totals[column.key] = null;
      else if (values.some(value => typeof value !== "number" || !Number.isSafeInteger(value))) throw new CommandError(409, "Report financial source requires review");
      else totals[column.key] = reportNumber(values.reduce<bigint>((sum, value) => sum + BigInt(value as number), 0n));
    }
    if (result.rows.length > 500 || result.rows.some(row => Object.values(row).some(value => value !== null && (typeof value !== "string" && typeof value !== "number" || typeof value === "number" && !Number.isSafeInteger(value))))) throw new CommandError(409, "Report source is incomplete or exceeds its row budget");
    // Bind export to exactly the reviewed projection, including cursors and source scan scope.
    const digest = commandHash({ kind: input.kind, locationId: scope.locationId, startDate, endDate, days: input.days, limit: input.limit, cursor: input.cursor || null, ...result, totals });
    if (exporting && input.expectedDigest !== digest) throw new CommandError(409, "Report changed; reload and review this page before exporting");
    if (exporting) await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_REPORT_EXPORTED", category: "ADMIN", targetModel: "Location", targetId: scope.locationId, details: { kind: input.kind, digest, startDate, endDate, timezone, rowCount: result.rows.length, scanned: result.scanned, cursor: input.cursor || null } }, session);
    return { kind: input.kind, label: pharmacyReportLabels[input.kind], locationId: scope.locationId, currency: "INR", timezone, asOf: asOf.toISOString(), startDate, endDate, days: input.days, limit: input.limit, cursor: input.cursor || null, digest, totalScope: "page" as const, totals, ...result };
  }, exporting ? { writeConcern: { w: "majority" } } : { readConcern: { level: "snapshot" } });
}
export type PharmacyReportPage = Awaited<ReturnType<typeof readPharmacyReport>>;
function csvValue(value: ReportRow[string], format: ReportColumn["format"]) {
  if (typeof value !== "number") return escapeCsv(value);
  if (format !== "paise") return String(value);
  const amount = BigInt(value), abs = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}
export function pharmacyReportCsv(page: PharmacyReportPage) {
  const metadata = [page.kind, page.locationId, page.currency, page.timezone, page.asOf, page.startDate, page.endDate, page.basis, page.digest];
  const header = ["report_kind", "location_id", "currency", "timezone", "read_at", "start_date", "end_date", "basis", "review_digest", "source_id", ...page.columns.map(column => column.label)];
  const lines = page.rows.map(row => [...metadata.map(escapeCsv), escapeCsv(row.id), ...page.columns.map(column => csvValue(row[column.key] ?? null, column.format))].join(","));
  return "\uFEFF" + [header.map(escapeCsv).join(","), ...lines].join("\r\n") + "\r\n";
}
