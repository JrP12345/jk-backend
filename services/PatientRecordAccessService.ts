import crypto from "node:crypto";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { PatientRecordAccess } from "../models/PatientRecordAccess.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";

export const recordTokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function getOrganizationPatient(patientId: string, organizationId: string) {
  const patient = await Patient.findById(patientId).setOptions({ bypassTenantFilter: true }).populate("userId", "name phone email");
  if (!patient) return null;
  const userId = (patient.userId as any)?._id || patient.userId;
  if (patient.organizationId?.toString() === organizationId) return patient;
  // This helper validates an explicit candidate organization, including patient
  // self-service selection. Do not let a different request tenant rewrite it.
  const related = await Appointment.exists({ patientId, organizationId }).setOptions({ bypassTenantFilter: true }) ||
    await PatientRelationship.exists({ patientId, organizationId, status: "active" }).setOptions({ bypassTenantFilter: true });
  if (related || (userId && await OrgMember.exists({ userId, organizationId }))) return patient;
  return null;
}

export async function hasPatientRecordAccess(token: string | undefined, patientId: string, userId: string | undefined, organizationId: string, sessionId: string | undefined) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !userId || !sessionId) return false;
  return Boolean(await PatientRecordAccess.exists({ tokenHash: recordTokenHash(token), patientId, userId, organizationId, sessionId, expiresAt: { $gt: new Date() } }));
}
