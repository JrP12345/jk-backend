import mongoose from "mongoose";
import { Location } from "../models/Location.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Doctor } from "../models/Doctor.ts";
import { User } from "../models/User.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";

export function publicDoctorAssignments(): NonNullable<mongoose.PipelineStage.Lookup["$lookup"]["pipeline"]> {
  return [
    { $match: { isActive: true, $expr: { $eq: ["$organizationId", "$$organizationId"] } } },
    { $lookup: { from: User.collection.name, localField: "doctorId", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $match: { "user.isActive": true } },
    { $lookup: { from: Doctor.collection.name, localField: "doctorId", foreignField: "userId", as: "profile" } },
    { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
    { $match: { "profile.isActive": { $ne: false } } },
  ];
}

/** Facets describe the full public directory, independent of pagination/filters. */
export async function getPublicLocationFacets(visibility: Record<string, unknown>) {
  const [result] = await Location.aggregate([
    { $match: visibility },
    { $facet: {
      cities: [
        { $group: { _id: "$city" } },
        { $match: { _id: { $type: "string", $ne: "" } } },
        { $sort: { _id: 1 } },
      ],
      specialties: [
        { $lookup: { from: DoctorAssignment.collection.name, localField: "_id", foreignField: "locationId", let: { organizationId: "$organizationId" }, pipeline: publicDoctorAssignments(), as: "assignments" } },
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

export interface LocationOrigin { latitude: number; longitude: number }

/** Great-circle distance, with invalid/unmapped locations retained after mapped locations. */
function distanceStages(origin: LocationOrigin): mongoose.PipelineStage[] {
  const radians = Math.PI / 180;
  return [
    { $set: { validCoordinates: { $and: [
      { $isNumber: "$latitude" }, { $isNumber: "$longitude" },
      { $gte: ["$latitude", -90] }, { $lte: ["$latitude", 90] },
      { $gte: ["$longitude", -180] }, { $lte: ["$longitude", 180] },
    ] } } },
    { $set: { value: { $cond: ["$validCoordinates", { $multiply: [6371, { $acos: { $max: [-1, { $min: [1, { $add: [
      { $multiply: [Math.sin(origin.latitude * radians), { $sin: { $multiply: ["$latitude", radians] } }] },
      { $multiply: [Math.cos(origin.latitude * radians), { $cos: { $multiply: ["$latitude", radians] } }, { $cos: { $multiply: [{ $subtract: ["$longitude", origin.longitude] }, radians] } }] },
    ] }] }] } }] }, null] } } },
  ];
}

/** Rank the full visible directory before limiting, including across city boundaries. */
export async function getSortedPublicLocationPage(
  filter: Record<string, unknown>, sort: "rating" | "fee_low" | "nearby", limit: number, cursor?: string, origin?: LocationOrigin,
) {
  if (sort === "nearby" && !origin) throw new Error("Nearby sort needs coordinates");
  const metricStages: mongoose.PipelineStage[] = sort === "fee_low" ? [
    { $lookup: { from: DoctorAssignment.collection.name, localField: "_id", foreignField: "locationId", let: { organizationId: "$organizationId" }, pipeline: [...publicDoctorAssignments(), { $match: { $or: [{ feeType: "free" }, { fees: { $gt: 0 } }] } }, { $group: { _id: null, value: { $min: "$fees" } } }], as: "metric" } },
  ] : [
    { $lookup: { from: PatientFeedback.collection.name, localField: "_id", foreignField: "locationId", pipeline: [{ $match: { rating: { $gte: 1, $lte: 5 } } }, { $group: { _id: null, value: { $avg: "$rating" } } }], as: "metric" } },
  ];
  const pipeline: mongoose.PipelineStage[] = [
    { $match: filter }, ...(sort === "nearby" ? distanceStages(origin!) : [
      ...metricStages, { $set: { value: { $ifNull: [{ $first: "$metric.value" }, null] } } } as mongoose.PipelineStage,
    ]),
    { $set: { hasValue: { $cond: [{ $ne: ["$value", null] }, 1, 0] } } },
  ];
  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || decoded.sort !== sort || typeof decoded.id !== "string" || !mongoose.isValidObjectId(decoded.id) || ![0, 1].includes(decoded.hasValue) ||
      (decoded.hasValue === 1 && !Number.isFinite(decoded.value)) || (decoded.hasValue === 0 && decoded.value !== null) ||
      (sort === "nearby" && (decoded.origin?.latitude !== origin!.latitude || decoded.origin?.longitude !== origin!.longitude))) {
      throw new Error("Invalid sorted location cursor");
    }
    pipeline.push({ $match: { $or: [
      { hasValue: { $lt: decoded.hasValue } },
      ...(decoded.hasValue ? [{ hasValue: decoded.hasValue, value: { [sort === "rating" ? "$lt" : "$gt"]: decoded.value } }] : []),
      { hasValue: decoded.hasValue, value: decoded.value, _id: { $gt: new mongoose.Types.ObjectId(decoded.id) } },
    ] } });
  }
  pipeline.push({ $sort: { hasValue: -1, value: sort === "rating" ? -1 : 1, _id: 1 } }, { $limit: limit + 1 }, { $project: { _id: 1, value: 1, hasValue: 1 } });
  const ranked = await Location.aggregate(pipeline);
  const hasNextPage = ranked.length > limit;
  const page = ranked.slice(0, limit);
  const records = await Location.find({ _id: { $in: page.map(item => item._id) } });
  const byId = new Map(records.map(item => [String(item._id), item]));
  const last = page.at(-1);
  return {
    items: page.map(item => byId.get(String(item._id))!).filter(Boolean),
    hasNextPage, limit,
    distances: new Map<string, number | null>(sort === "nearby" ? page.map(item => [String(item._id), item.value]) : []),
    nextCursor: hasNextPage && last ? Buffer.from(JSON.stringify({ sort, id: String(last._id), value: last.value, hasValue: last.hasValue, ...(sort === "nearby" ? { origin } : {}) })).toString("base64url") : null,
  };
}
