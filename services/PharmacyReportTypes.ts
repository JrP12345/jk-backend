import type mongoose from "mongoose";
import type { PharmacyReportInput } from "../schemas/pharmacyReports.ts";
import { CommandError } from "./CommandReceiptService.ts";
export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell> & { id: string };
export type ReportColumn = { key: string; label: string; format: "text" | "integer" | "paise" | "date" };
export interface ReportContext { input: PharmacyReportInput; scope: { organizationId: string; locationId: string; actorId: string }; session: mongoose.ClientSession; asOf: Date; start: Date; end: Date; cashKinds: string[] }
export interface ReportResult { columns: ReportColumn[]; rows: ReportRow[]; nextCursor: string | null; scanned: number; basis: string }
export const reportColumns = (columns: Array<[string, string, ReportColumn["format"]?]>): ReportColumn[] => columns.map(([key, label, format]) => ({ key, label, format: format || "text" }));
export const reportNumber = (value: bigint) => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new CommandError(409, "Report amounts exceed supported precision"); return Number(value); };
export const reportDate = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
export function requireReportBound(rows: unknown[], maximum = 2000) { if (rows.length > maximum) throw new CommandError(409, "Report source exceeds its read budget; reduce the page size or date range"); }
export function sourcePage<T extends { _id: unknown }>(rows: T[], input: PharmacyReportInput) { const page = rows.slice(0, input.limit); return { page, nextCursor: rows.length > input.limit ? String(page.at(-1)!._id) : null }; }
