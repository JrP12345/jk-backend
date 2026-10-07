import type { FastifyRequest, FastifyReply } from "fastify";
import { escapeRegex } from '../utilities/helpers.ts';
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function getScheduleH1Entries(request: FastifyRequest, reply: FastifyReply) {
  const { organization_id } = request.user as { organization_id?: string };
  const query = request.query as {
    locationId?: string;
    scheduleType?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    page?: string | number;
    limit?: string | number;
  };

  const filter: any = {};
  if (organization_id) {
    filter.organizationId = organization_id;
  }
  if (query.locationId) {
    filter.locationId = query.locationId;
  }
  if (query.scheduleType) {
    filter.scheduleType = query.scheduleType;
  }
  if (query.startDate || query.endDate) {
    filter.dispensedAt = {};
    if (query.startDate) filter.dispensedAt.$gte = new Date(query.startDate);
    if (query.endDate) filter.dispensedAt.$lte = new Date(query.endDate);
  }
    if (query.search) {
      const search = escapeRegex(String(query.search).slice(0, 200));
      filter.$or = [
        { medicineName: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
        { doctorName: { $regex: search, $options: "i" } },
        { batchNumber: { $regex: search, $options: "i" } },
    ];
  }

  const totalCount = await ScheduleH1Register.countDocuments(filter);
  const { page: currentPage, limit: pageSize, skip } = getPaginationParams(query);
  const totalPages = Math.ceil(totalCount / pageSize);

  const entries = await ScheduleH1Register.find(filter)
    .sort({ dispensedAt: -1 })
    .skip(skip)
    .limit(pageSize)
    .lean();

  setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
  return reply.send({
    success: true,
    data: entries,
    pagination: {
      total: totalCount,
      page: currentPage,
      limit: pageSize,
      totalPages,
    },
  });
}

export async function exportScheduleH1Register(request: FastifyRequest, reply: FastifyReply) {
  const { organization_id } = request.user as { organization_id?: string };
  const query = request.query as {
    locationId?: string;
    scheduleType?: string;
    startDate?: string;
    endDate?: string;
  };

  const filter: any = {};
  if (organization_id) {
    filter.organizationId = organization_id;
  }
  if (query.locationId) {
    filter.locationId = query.locationId;
  }
  if (query.scheduleType) {
    filter.scheduleType = query.scheduleType;
  }
  if (query.startDate || query.endDate) {
    filter.dispensedAt = {};
    if (query.startDate) filter.dispensedAt.$gte = new Date(query.startDate);
    if (query.endDate) filter.dispensedAt.$lte = new Date(query.endDate);
  }

  const entries = await ScheduleH1Register.find(filter).sort({ dispensedAt: -1 }).lean();

  return reply.send({
    success: true,
    data: {
      generatedAt: new Date().toISOString(),
      statutoryAct: "Drugs and Cosmetics Rules, 1945 (Rule 65 - Schedule H1 Register)",
      totalRecords: entries.length,
      records: entries,
    },
  });
}
