import { CommandError } from "../services/CommandReceiptService.ts";
export type TransferAction = "create" | "approve" | "dispatch" | "receive" | "resolve" | "cancel";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
export interface TransferInput {
  locationId: string; expectedRevision?: number; destinationLocationId?: string; sourceMedicineId?: string; destinationMedicineId?: string; sourceBatchId?: string;
  quantity?: number; disposition?: "saleable" | "quarantined" | "lost" | "return_to_source"; reviewReference: string; transportReference?: string;
}
export function transferInput(value: unknown, action: TransferAction): TransferInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommandError(400, "A branch transfer command is required");
  const row = value as Record<string, unknown>, keys = ["locationId", "reviewReference", ...(action === "create" ? ["destinationLocationId", "sourceMedicineId", "destinationMedicineId", "sourceBatchId", "quantity", "transportReference"] : ["expectedRevision", ...(["receive", "resolve"].includes(action) ? ["quantity", "disposition"] : [])])];
  if (Object.keys(row).some(key => !keys.includes(key)) || !identifier(row.locationId) || typeof row.reviewReference !== "string" || row.reviewReference.trim().length < 10 || row.reviewReference.length > 300 ||
      action !== "create" && (!Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0 || (row.expectedRevision as number) >= Number.MAX_SAFE_INTEGER - 1) ||
      ["create", "receive", "resolve"].includes(action) && (!Number.isSafeInteger(row.quantity) || (row.quantity as number) < 1 || (row.quantity as number) > 1_000_000) ||
      action === "create" && (![row.destinationLocationId, row.sourceMedicineId, row.destinationMedicineId, row.sourceBatchId].every(identifier) || typeof row.transportReference !== "string" || row.transportReference.trim().length < 3 || row.transportReference.length > 120 || row.locationId === row.destinationLocationId) ||
      action === "receive" && !["saleable", "quarantined"].includes(row.disposition as string) || action === "resolve" && !["lost", "return_to_source"].includes(row.disposition as string)) throw new CommandError(400, "Provide explicit branches, source lot, compatible product map, quantities and actual review/document references");
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, typeof item === "string" ? (key.endsWith("Id") ? item.toLowerCase() : item.trim()) : item])) as unknown as TransferInput;
}
