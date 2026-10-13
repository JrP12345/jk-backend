import crypto from "node:crypto";
import { Patient } from "../models/Patient.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { Counter } from "../models/Counter.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { normalizePhone } from "../utilities/helpers.ts";
import { patientMatchingService } from "./PatientMatchingService.ts";
import { patientAdministrativeDTO } from "./PatientAdministrativeDTO.ts";
import { CommandError, commandHash, executeRecordedCommand } from "./CommandReceiptService.ts";

export async function registerOrganizationPatient(organizationId: string, actorId: string, input: any, requestId: string) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const phone = input.phone ? normalizePhone(input.phone) : undefined;
  const email = typeof input.email === "string" && input.email.trim() ? input.email.trim().toLowerCase() : undefined;
  if (!name || name.length > 120 || (!phone && !email)) throw new CommandError(400, "Patient name and either phone or email are required");
  if (phone && !/^\d{10}$/.test(phone)) throw new CommandError(400, "Enter a valid Indian contact phone number");
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new CommandError(400, "Enter a valid contact email");
  const dob = input.dob ? new Date(input.dob) : undefined;
  if (dob && (!Number.isFinite(dob.getTime()) || dob > new Date())) throw new CommandError(400, "Enter a valid date of birth");
  if (input.gender && !["male", "female", "other"].includes(input.gender)) throw new CommandError(400, "Invalid gender");
  const distinctPersonReason = typeof input.distinctPersonReason === "string" ? input.distinctPersonReason.trim() : "";
  if (input.ignoreDuplicate && !distinctPersonReason) throw new CommandError(400, "Record why this is a different patient before creating a separate record");
  if (distinctPersonReason.length > 500) throw new CommandError(400, "The identity review reason is too long");
  const data: any = { name, phone, email, dob: dob?.toISOString(), gender: input.gender, distinctPersonReason };
  if (input.locationId) data.locationId = input.locationId;
  // Additional registration fields remain in the existing canonical Patient model.
  for (const key of ["bloodGroup", "address", "city", "state", "pincode", "nationality", "allergies", "conditions", "medicalNotes", "emergencyContacts"]) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  const receipt = await executeRecordedCommand(`patient-registration:${organizationId}:${actorId}`, requestId, data, async () => {
    // A write to the same fingerprint serializes matching + creation for different
    // request identifiers; phone itself deliberately has no unique identity constraint.
    await Counter.findOneAndUpdate({ id: `patient-registration:${organizationId}:${commandHash({ name: name.toLowerCase(), phone, email })}` },
      { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
    const matches = await patientMatchingService.findMatchingPatients({ name, phone, email, dob, organizationId });
    if (!distinctPersonReason && (matches.highConfidence.length || matches.mediumConfidence.length)) {
      throw new CommandError(409, "Possible existing patient. Verify the person before selecting or creating a separate record.", {
        highConfidenceMatches: matches.highConfidence, mediumConfidenceMatches: matches.mediumConfidence, truncated: matches.truncated,
      });
    }
    const { distinctPersonReason: _reason, locationId, ...patientData } = data;
    const patient = await Patient.create({ ...patientData, accountType: "walkin", createdBy: actorId,
      organizationId, personalVaultId: `pvt_${crypto.randomUUID()}` });
    await PatientRelationship.create({ organizationId, patientId: patient._id, locationId });
    await CrmActivity.create({ organizationId, patientId: patient._id, locationId, actorId, kind: "patient_registered",
      ...(distinctPersonReason ? { outcome: "distinct_person_reviewed", note: distinctPersonReason } : {}) });
    await AuditLog.create({ organizationId, userId: actorId, targetId: patient._id, targetModel: "Patient", action: "PATIENT_REGISTERED",
      category: "ADMIN", details: { distinctPersonReviewed: Boolean(distinctPersonReason), requestId } });
    return patient.id;
  });
  const patient = await Patient.findById(receipt.resultId).setOptions({ bypassTenantFilter: true }).lean();
  if (!patient) throw new CommandError(409, "The registered patient requires review; do not create another record");
  return { patient: patientAdministrativeDTO(patient), replayed: receipt.replayed };
}
