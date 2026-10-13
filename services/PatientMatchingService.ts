import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { Appointment } from "../models/Appointment.ts";
import { escapeRegex, normalizePhone } from "../utilities/helpers.ts";
import { patientAdministrativeDTO } from "./PatientAdministrativeDTO.ts";

export interface MatchResult {
  highConfidence: any[]; mediumConfidence: any[]; lowConfidence: any[]; truncated: boolean;
}
export function organizationPatientPipeline(organizationId: string): any[] {
  const org = new mongoose.Types.ObjectId(organizationId);
  return [
    { $match: { organizationId: org } }, { $project: { _id: 1 } },
    { $unionWith: { coll: PatientRelationship.collection.name, pipeline: [
      { $match: { organizationId: org, status: "active" } }, { $project: { _id: "$patientId" } },
    ] } },
    { $unionWith: { coll: Appointment.collection.name, pipeline: [
      { $match: { organizationId: org } }, { $group: { _id: "$patientId" } },
    ] } },
    { $group: { _id: "$_id" } },
    { $lookup: { from: Patient.collection.name, localField: "_id", foreignField: "_id", as: "patient" } },
    { $unwind: "$patient" }, { $replaceWith: "$patient" },
  ];
}
export class PatientMatchingService {
  async findMatchingPatients(criteria: { name?: string; phone?: string; dob?: string | Date;
    gender?: string; email?: string; mrn?: string; organizationId?: string }): Promise<MatchResult> {
    const result: MatchResult = { highConfidence: [], mediumConfidence: [], lowConfidence: [], truncated: false };
    // Contact possession does not authorize a global patient directory.
    if (!criteria.organizationId || !mongoose.isValidObjectId(criteria.organizationId)) return result;
    const phone = normalizePhone(criteria.phone || "");
    const phones = phone ? [phone, `+91${phone}`, `91${phone}`] : [];
    const name = criteria.name?.trim().toLowerCase().slice(0, 120) || "";
    const email = criteria.email?.trim().toLowerCase().slice(0, 200) || "";
    const conditions: any[] = [];
    if (criteria.mrn) conditions.push({ mrn: criteria.mrn.trim() });
    if (phone) conditions.push({ phone: { $in: phones } }, { "linkedUser.phone": { $in: phones } });
    if (email) conditions.push({ email }, { "linkedUser.email": email });
    if (name) conditions.push({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } },
      { "linkedUser.name": { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
    if (!conditions.length) return result;
    const candidateStages: any[] = [
      { $lookup: { from: User.collection.name, localField: "userId", foreignField: "_id",
        pipeline: [{ $match: { isActive: true } }, { $project: { name: 1, phone: 1, email: 1 } }], as: "linkedUser" } },
      { $match: { $or: conditions } }, { $sort: { _id: 1 } }, { $limit: 21 },
      { $project: { name: 1, phone: 1, email: 1, dob: 1, gender: 1, mrn: 1, accountType: 1,
        userId: { $arrayElemAt: ["$linkedUser", 0] } } },
    ];
    const org = new mongoose.Types.ObjectId(criteria.organizationId);
    // $unionWith cannot run in a transaction. Each indexed organization source
    // returns at most 21 candidates; no global User scan or unbounded ID array.
    const home = await Patient.aggregate([{ $match: { organizationId: org } }, ...candidateStages]).option({ maxTimeMS: 5000 });
    const associated = await PatientRelationship.aggregate([
      { $match: { organizationId: org, status: "active" } },
      { $lookup: { from: Patient.collection.name, localField: "patientId", foreignField: "_id", pipeline: candidateStages, as: "patient" } },
      { $unwind: "$patient" }, { $replaceWith: "$patient" }, { $sort: { _id: 1 } }, { $limit: 21 },
    ]).option({ maxTimeMS: 5000 });
    const visited = await Appointment.aggregate([
      { $match: { organizationId: org } }, { $group: { _id: "$patientId" } },
      { $lookup: { from: Patient.collection.name, localField: "_id", foreignField: "_id", pipeline: candidateStages, as: "patient" } },
      { $unwind: "$patient" }, { $replaceWith: "$patient" }, { $sort: { _id: 1 } }, { $limit: 21 },
    ]).option({ maxTimeMS: 5000 });
    const candidates = [...new Map([...home, ...associated, ...visited].map(patient => [String(patient._id), patient])).values()]
      .sort((a, b) => String(a._id).localeCompare(String(b._id)));
    result.truncated = candidates.length > 20;
    for (const c of candidates.slice(0, 20)) {
      const dto = patientAdministrativeDTO(c);
      const reasons: string[] = [];
      let score = 0;
      if (criteria.mrn && c.mrn === criteria.mrn.trim()) { reasons.push("Patient identifier"); score += 10; }
      if (phone && phone === normalizePhone(dto.phone)) { reasons.push("Shared contact number"); score += 3; }
      if (name && name === dto.name.toLowerCase()) { reasons.push("Name"); score += 2; }
      if (email && email === dto.email.toLowerCase()) { reasons.push("Contact email"); score += 2; }
      if (criteria.dob && c.dob && new Date(criteria.dob).toISOString().slice(0, 10) === new Date(c.dob).toISOString().slice(0, 10)) { reasons.push("Date of birth"); score += 3; }
      const candidate = { ...dto, matchReasons: reasons, identityVerified: false };
      if (score >= 5) result.highConfidence.push(candidate);
      else if (score >= 3) result.mediumConfidence.push(candidate);
      else result.lowConfidence.push(candidate);
    }
    return result;
  }
}
export const patientMatchingService = new PatientMatchingService();
