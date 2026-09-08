import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { escapeRegex, normalizePhone } from "../utilities/helpers.ts";

export interface MatchResult {
  highConfidence: any[];
  mediumConfidence: any[];
  lowConfidence: any[];
}

export class PatientMatchingService {
  /**
   * Find existing patient matches using normalized multi-signal criteria.
   */
  async findMatchingPatients(criteria: {
    name?: string;
    phone?: string;
    dob?: string | Date;
    gender?: string;
    email?: string;
    mrn?: string;
    organizationId?: string;
  }): Promise<MatchResult> {
    const highConfidence: any[] = [];
    const mediumConfidence: any[] = [];
    const lowConfidence: any[] = [];

    const normPhone = normalizePhone(criteria.phone || "");
    const normName = criteria.name ? criteria.name.trim().toLowerCase() : "";
    const normEmail = criteria.email ? criteria.email.trim().toLowerCase() : "";
    const dobStr = criteria.dob ? new Date(criteria.dob).toISOString().split("T")[0] : "";
    const normGender = criteria.gender ? criteria.gender.trim().toLowerCase() : "";

    // 1. Direct MRN match (High Confidence)
    if (criteria.mrn && criteria.mrn.trim()) {
      const mrnMatch = await Patient.findOne({ mrn: criteria.mrn.trim() })
        .populate("userId", "name email phone")
        .lean();
      if (mrnMatch) {
        highConfidence.push({ ...mrnMatch, matchReason: "Exact MRN Match" });
        return { highConfidence, mediumConfidence, lowConfidence };
      }
    }

    // Find candidate patients by phone, email, or name
    const filter: any = {};
    const orConditions: any[] = [];

    if (normPhone) {
      orConditions.push({ phone: { $regex: normPhone } });
    }
    if (normEmail) {
      orConditions.push({ email: normEmail });
    }
    if (normName) {
      orConditions.push({ name: { $regex: escapeRegex(normName), $options: "i" } });
    }

    // Also resolve matches against linked User account records
    if (normPhone || normEmail || normName) {
      const userOrConditions: any[] = [];
      if (normPhone) userOrConditions.push({ phone: { $regex: normPhone } });
      if (normEmail) userOrConditions.push({ email: normEmail });
      if (normName) userOrConditions.push({ name: { $regex: escapeRegex(normName), $options: "i" } });

      const matchingUsers = await User.find({
        role: "patient",
        $or: userOrConditions,
      }).select("_id");
      const userIds = matchingUsers.map((u) => u._id);

      if (userIds.length > 0) {
        orConditions.push({ userId: { $in: userIds } });
      }
    }

    if (orConditions.length === 0) {
      return { highConfidence, mediumConfidence, lowConfidence };
    }

    filter.$or = orConditions;

    const candidates = await Patient.find(filter)
      .populate("userId", "name email phone")
      .lean();

    const seenIds = new Set<string>();

    for (const c of candidates) {
      const idStr = c._id.toString();
      if (seenIds.has(idStr)) continue;
      seenIds.add(idStr);

      const user = (c as any).userId;
      const cPhone = normalizePhone(c.phone || user?.phone || "");
      const cName = (c.name || user?.name || "").trim().toLowerCase();
      const cEmail = (c.email || user?.email || "").trim().toLowerCase();
      const cDob = c.dob ? new Date(c.dob).toISOString().split("T")[0] : "";
      const cGender = (c.gender || "").trim().toLowerCase();

      let matchScore = 0;
      const matchReasons: string[] = [];

      if (normPhone && cPhone && normPhone === cPhone) {
        matchScore += 3;
        matchReasons.push("Phone match");
      }
      if (normName && cName && (cName.includes(normName) || normName.includes(cName))) {
        matchScore += 2;
        matchReasons.push("Name match");
      }
      if (dobStr && cDob && dobStr === cDob) {
        matchScore += 3;
        matchReasons.push("DOB match");
      }
      if (normEmail && cEmail && normEmail === cEmail) {
        matchScore += 2;
        matchReasons.push("Email match");
      }
      if (normGender && cGender && normGender === cGender) {
        matchScore += 1;
      }

      const formatted = { ...c, matchReasons, matchScore };

      if (matchScore >= 5) {
        highConfidence.push(formatted);
      } else if (matchScore >= 3) {
        mediumConfidence.push(formatted);
      } else if (matchScore >= 2) {
        lowConfidence.push(formatted);
      }
    }

    return { highConfidence, mediumConfidence, lowConfidence };
  }

}

export const patientMatchingService = new PatientMatchingService();
