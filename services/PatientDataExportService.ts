import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { getOrganizationPatient } from "./PatientRecordAccessService.ts";
import { patientAdministrativeDTO } from "./PatientAdministrativeDTO.ts";
import { getPatientConsents } from "./PatientConsentService.ts";
import { CommandError } from "./CommandReceiptService.ts";

export interface ExportContext { actorId: string; locationIds?: mongoose.Types.ObjectId[]; cursors?: Record<string, string>; includeClinical: boolean; resources?: string[] }
export async function exportPatientData(patientId: string, organizationId: string, context: ExportContext) {
  if (!organizationId || !context?.actorId) throw new CommandError(403, "Organization and actual actor are required for export");
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new CommandError(404, "Patient not found in this organization");
  const resources: [string, any, string][] = [
    ["appointments", Appointment, "_id appointmentTime appointmentType status locationId"],
    ["invoices", Invoice, "_id invoiceNumber status subtotal totalAmount amountPaid balanceDue createdAt locationId"],
    ...(context.includeClinical ? [
      ["encounters", Encounter, "_id encounterType status startedAt endedAt locationId"],
      ["prescriptions", Prescription, "_id medicineName dosage frequency duration instructions status createdAt locationId"],
      ["labOrders", LabOrder, "_id testId status clinicalReason result.value result.unit result.referenceRange result.interpretation result.isAbnormal result.notes createdAt locationId"],
    ] as [string, any, string][] : []),
  ];
  const records: Record<string, any[]> = {}, nextCursors: Record<string, string | null> = {};
  if (context.resources && (context.resources.length > 5 || context.resources.some(name => !resources.some(([key]) => key === name)))) throw new CommandError(400, "Choose available export resources");
  for (const [name, model, fields] of resources) {
    if (context.resources && !context.resources.includes(name)) continue;
    const cursor = context.cursors?.[name];
    if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) throw new CommandError(400, "Invalid export cursor");
    const filter = { patientId, organizationId, ...(context.locationIds ? { locationId: { $in: context.locationIds } } : {}), ...(cursor ? { _id: { $gt: cursor } } : {}) };
    const rows = await model.find(filter).select(fields).sort({ _id: 1 }).limit(101).maxTimeMS(5000).lean();
    records[name] = rows.slice(0, 100);
    nextCursors[name] = rows.length > 100 ? String(rows[99]._id) : null;
  }
  const relationship = await PatientRelationship.findOne({ patientId, organizationId }).lean() as any;
  await AuditLog.create({ userId: context.actorId, organizationId, action: "DPDP_DATA_EXPORTED", targetId: patientId, targetModel: "Patient", category: "COMPLIANCE_DPDP",
    details: { recordCounts: Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length])), includeClinical: context.includeClinical } });
  return { metadata: { format: "EKAVYU_DPDP_EXPORT", organizationId, exportedAt: new Date().toISOString(), pageSize: 100,
    nextCursors, truncated: Object.values(nextCursors).some(Boolean), scope: context.includeClinical ? "organization_records" : "organization_administrative_records" },
    patientProfile: patientAdministrativeDTO({ ...patient.toObject(), phone: relationship?.contact?.phone ?? patient.phone, email: relationship?.contact?.email ?? patient.email }),
    clinicalRecords: records, consentLedger: (await getPatientConsents(patientId, organizationId)).purposes };
}
