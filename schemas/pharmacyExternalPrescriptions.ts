import { object, identifier, text, whole } from "./pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";

export function externalPrescriptionReference(raw: unknown) {
  const value = object(raw, ["id", "revision"]);
  return { id: identifier(value.id), revision: whole(value.revision, "prescription revision", Number.MAX_SAFE_INTEGER - 1) };
}
export function externalPrescriptionInput(raw: unknown) {
  const body = object(raw, ["locationId", "reference", "issuedOn", "validUntil", "patientName", "patientAddress", "patientPhone", "prescriberName", "prescriberAddress", "prescriberRegistration", "prescriberCouncil", "prescriberReviewReference", "sourceReference", "reviewConfirmed", "lines", "organizationId", "organization_id"]);
  const detail = (field: string, max = 300) => { const value = text(body[field], field, 2, max); if (!genuineDetail(value)) throw new CommandError(400, `Actual ${field} is required`); return value; };
  if (body.reviewConfirmed !== true) throw new CommandError(400, "Confirm review of the actual signed prescription, prescriber registration and permitted quantities");
  const issuedOn = text(body.issuedOn, "prescription date", 10, 10), validUntil = text(body.validUntil, "reviewed supply deadline", 10, 10);
  const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime()) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  if (!date(issuedOn) || !date(validUntil) || issuedOn > today || validUntil < today || validUntil < issuedOn) throw new CommandError(400, "Check prescription date and pharmacist-reviewed supply deadline");
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 100) throw new CommandError(400, "Review 1 to 100 distinct medicine lines");
  const ids = new Set<string>();
  const lines = body.lines.map(rawLine => {
    const line = object(rawLine, ["medicineId", "quantity", "expectedUnitVersion", "expectedDispensingRevision", "instructions"]), medicineId = identifier(line.medicineId), quantity = whole(line.quantity, "permitted base quantity", 1_000_000);
    if (!quantity || ids.has(medicineId)) throw new CommandError(400, "Use positive quantities and distinct prescribed medicines");
    ids.add(medicineId);
    return { medicineId, quantity, expectedUnitVersion: whole(line.expectedUnitVersion, "unit version"), expectedDispensingRevision: whole(line.expectedDispensingRevision, "classification revision"), instructions: text(line.instructions, "original prescription directions", 2, 1000) };
  });
  const patientPhone = body.patientPhone === undefined || body.patientPhone === "" ? undefined : text(body.patientPhone, "phone", 10, 20);
  if (patientPhone && !/^\+?[0-9 -]{10,20}$/.test(patientPhone)) throw new CommandError(400, "Invalid patient contact number");
  return { locationId: identifier(body.locationId), reference: detail("reference", 100), issuedOn, validUntil, patientName: detail("patientName", 150), patientAddress: detail("patientAddress", 500), patientPhone,
    prescriberName: detail("prescriberName", 150), prescriberAddress: detail("prescriberAddress", 500), prescriberRegistration: detail("prescriberRegistration", 100), prescriberCouncil: detail("prescriberCouncil", 150),
    prescriberReviewReference: detail("prescriberReviewReference"), sourceReference: detail("sourceReference"), lines };
}
