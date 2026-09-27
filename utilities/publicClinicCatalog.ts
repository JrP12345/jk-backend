import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Doctor } from "../models/Doctor.ts";
import { User } from "../models/User.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";

export function publicDoctorAssignments(): NonNullable<mongoose.PipelineStage.Lookup["$lookup"]["pipeline"]> {
  return [
    { $match: { isActive: true } },
    { $lookup: { from: User.collection.name, localField: "doctorId", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $match: { "user.isActive": true, "user.role": "doctor" } },
    { $lookup: { from: Doctor.collection.name, localField: "doctorId", foreignField: "userId", as: "profile" } },
    { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
    { $match: { "profile.isActive": { $ne: false } } },
  ];
}

/** Facets describe the full public directory, independent of pagination/filters. */
export async function getPublicClinicFacets(visibility: Record<string, unknown>) {
  const [result] = await Clinic.aggregate([
    { $match: visibility },
    { $facet: {
      cities: [
        { $group: { _id: "$city" } },
        { $match: { _id: { $type: "string", $ne: "" } } },
        { $sort: { _id: 1 } },
      ],
      specialties: [
        { $lookup: { from: DoctorAssignment.collection.name, localField: "_id", foreignField: "clinicId", pipeline: publicDoctorAssignments(), as: "assignments" } },
        { $unwind: "$assignments" },
        { $project: { specialty: { $trim: { input: { $ifNull: ["$assignments.profile.specialization", ""] } } } } },
        { $match: { specialty: { $ne: "" } } },
        { $group: { _id: "$specialty" } },
        { $sort: { _id: 1 } },
      ],
    } },
  ]);
  return {
    cities: (result?.cities || []).map((item: { _id: string }) => item._id),
    specialties: (result?.specialties || []).map((item: { _id: string }) => item._id),
  };
}

/** Sort before limiting, so a highly rated/low-fee clinic cannot be hidden on a later page. */
export async function getSortedPublicClinicPage(
  filter: Record<string, unknown>, sort: "rating" | "fee_low", limit: number, cursor?: string,
) {
  const metricStages: mongoose.PipelineStage[] = sort === "fee_low" ? [
    { $lookup: { from: DoctorAssignment.collection.name, localField: "_id", foreignField: "clinicId", pipeline: [...publicDoctorAssignments(), { $group: { _id: null, value: { $min: "$fees" } } }], as: "metric" } },
  ] : [
    { $lookup: { from: PatientFeedback.collection.name, localField: "_id", foreignField: "clinicId", pipeline: [{ $match: { rating: { $gte: 1, $lte: 5 } } }, { $group: { _id: null, value: { $avg: "$rating" } } }], as: "metric" } },
  ];
  const pipeline: mongoose.PipelineStage[] = [
    { $match: filter }, ...metricStages,
    { $set: { value: { $ifNull: [{ $first: "$metric.value" }, null] } } },
    { $set: { hasValue: { $cond: [{ $ne: ["$value", null] }, 1, 0] } } },
  ];
  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || decoded.sort !== sort || typeof decoded.id !== "string" || !mongoose.isValidObjectId(decoded.id) || ![0, 1].includes(decoded.hasValue) ||
      (decoded.hasValue === 1 && !Number.isFinite(decoded.value)) || (decoded.hasValue === 0 && decoded.value !== null)) {
      throw new Error("Invalid sorted clinic cursor");
    }
    pipeline.push({ $match: { $or: [
      { hasValue: { $lt: decoded.hasValue } },
      ...(decoded.hasValue ? [{ hasValue: decoded.hasValue, value: { [sort === "rating" ? "$lt" : "$gt"]: decoded.value } }] : []),
      { hasValue: decoded.hasValue, value: decoded.value, _id: { $gt: new mongoose.Types.ObjectId(decoded.id) } },
    ] } });
  }
  pipeline.push({ $sort: { hasValue: -1, value: sort === "rating" ? -1 : 1, _id: 1 } }, { $limit: limit + 1 }, { $project: { _id: 1, value: 1, hasValue: 1 } });
  const ranked = await Clinic.aggregate(pipeline);
  const hasNextPage = ranked.length > limit;
  const page = ranked.slice(0, limit);
  const records = await Clinic.find({ _id: { $in: page.map(item => item._id) } });
  const byId = new Map(records.map(item => [String(item._id), item]));
  const last = page.at(-1);
  return {
    items: page.map(item => byId.get(String(item._id))!).filter(Boolean),
    hasNextPage, limit,
    nextCursor: hasNextPage && last ? Buffer.from(JSON.stringify({ sort, id: String(last._id), value: last.value, hasValue: last.hasValue })).toString("base64url") : null,
  };
}
