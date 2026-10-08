import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { publicSlugs } from "../utilities/publicLinks.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

/** A bounded sitemap feed; no live queue, subscription, or patient queries. */
export async function getPublicDiscovery(req: FastifyRequest, reply: FastifyReply) {
  const { cursor } = req.query as { cursor?: string };
  if (cursor && !/^[a-f0-9]{24}$/.test(cursor)) return reply.code(400).send(errorResponse("Invalid discovery cursor"));
  const pageSize = 200;
  const locations = await Location.aggregate([
    { $match: { isActive: true, isPublished: { $ne: false }, ...(cursor ? { _id: { $gt: new mongoose.Types.ObjectId(cursor) } } : {}) } },
    { $sort: { _id: 1 } },
    { $lookup: { from: Organization.collection.name, localField: "organizationId", foreignField: "_id", pipeline: [{ $match: { isActive: true, status: { $ne: "inactive" } } }, { $project: { _id: 1 } }], as: "organization" } },
    { $match: { "organization.0": { $exists: true } } },
    { $limit: pageSize + 1 },
    { $project: { _id: 1, name: 1, organizationId: 1 } },
  ]);
  const page = locations.slice(0, pageSize);
  const owners = new Map(page.map((location) => [String(location._id), String(location.organizationId)]));
  const assignments = await DoctorAssignment.find({ locationId: { $in: page.map((location) => location._id) }, isActive: true }).select("doctorId locationId organizationId").lean();
  const scoped = assignments.filter((item) => owners.get(String(item.locationId)) === String(item.organizationId));
  const doctorIds = scoped.map((item) => item.doctorId);
  const [users, disabled] = await Promise.all([
    User.find({ _id: { $in: doctorIds }, isActive: true }).select("name").lean(),
    Doctor.find({ userId: { $in: doctorIds }, isActive: false }).select("userId").lean(),
  ]);
  const disabledIds = new Set(disabled.map((item) => String(item.userId)));
  const doctors = users.filter((user) => !disabledIds.has(String(user._id)));
  const links = await publicSlugs([
    ...page.map((location) => ({ kind: "location" as const, targetId: String(location._id), name: location.name })),
    ...doctors.map((user) => ({ kind: "doctor" as const, targetId: String(user._id), name: user.name })),
  ]);
  const paths = page.map((location) => `/browse/${links.get(`location:${location._id}`)}`);
  const doctorSlugs = new Map(doctors.map((user) => [String(user._id), links.get(`doctor:${user._id}`)]));
  for (const item of scoped) {
    const doctor = doctorSlugs.get(String(item.doctorId));
    if (doctor) paths.push(`/doctor/${doctor}?location=${links.get(`location:${item.locationId}`)}`);
  }
  reply.header("Cache-Control", "no-store");
  return reply.send(successResponse({ paths: [...new Set(paths)], nextCursor: locations.length > pageSize ? String(page.at(-1)!._id) : null }));
}
