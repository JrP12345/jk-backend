import mongoose from "mongoose";
import type { TimelineQueryOptions } from "../../types/timeline.ts";

/** Select a bounded window before populating/serializing clinical records. */
export async function timelineWindow(model: any, filter: any, query: TimelineQueryOptions, dates: string[], prefix = "") {
  const match = Object.fromEntries(Object.entries(filter).map(([key, value]) => [key, typeof value === "string" && mongoose.isObjectIdOrHexString(value) ? new mongoose.Types.ObjectId(value) : value]));
  const pipeline: any[] = [{ $match: match }, { $addFields: {
    _timelineAt: dates.reduceRight<any>((fallback, field) => ({ $ifNull: [`$${field}`, fallback] }), "$createdAt"),
    _timelineId: { $concat: [prefix, { $toString: "$_id" }] },
  } }];
  if (query.cursor) {
    const [date, id] = Buffer.from(query.cursor, "base64").toString().split("__");
    const at = new Date(date);
    if (!id || !Number.isFinite(at.getTime())) throw Object.assign(new Error("Invalid timeline cursor"), { statusCode: 400 });
    pipeline.push({ $match: { $or: [{ _timelineAt: { $lt: at } }, { _timelineAt: at, _timelineId: { $lt: id } }] } });
  }
  pipeline.push({ $sort: { _timelineAt: -1, _timelineId: -1 } }, { $limit: Math.min(100, Math.max(1, query.limit || 20)) + 1 }, { $project: { _id: 1 } });
  const rows = await model.aggregate(pipeline).option({ maxTimeMS: 5_000 });
  return { query: model.find({ ...filter, _id: { $in: rows.map((row: any) => row._id) } }).setOptions({ bypassTenantFilter: query.isCrossOrgAllowed === true }) };
}
