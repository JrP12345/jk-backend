import { buildOfflinePharmacyDocument } from "./pharmacyOfflineDocument.ts";
import { PHARMACY_CALCULATION_ENGINE_SHA256 } from "./pharmacyCalculationVersion.ts";
import { PHARMACY_OFFLINE_DOCUMENT_SHA256 } from "./pharmacyOfflineDocumentVersion.ts";
import { buildOfflinePharmacyDocument as original } from "./offlinePolicies/v1/pharmacyOfflineDocument.ts";

/** An invoice already handed to a customer must remain importable after code
 * deployment. Frozen protocol sources are append-only; issuing a new version
 * must not remove the original verifier/rebuilder for outstanding receipts.
 */
export const ORIGINAL_OFFLINE_POLICY = {
  calculation: "d406a8156e78a35629d8a33d6129655978d3b80d4be8773454da4c9450bf83ad",
  document: "7e2921323d7eb7187fbef66a670a778c4c03c877743fb68e655fffea550be35e",
} as const;
export function offlineDocumentPolicy(calculation: string, document: string) {
  if (calculation === ORIGINAL_OFFLINE_POLICY.calculation && document === ORIGINAL_OFFLINE_POLICY.document) return original;
  if (calculation === PHARMACY_CALCULATION_ENGINE_SHA256 && document === PHARMACY_OFFLINE_DOCUMENT_SHA256) return buildOfflinePharmacyDocument;
  return null;
}
