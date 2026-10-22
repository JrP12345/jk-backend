import type { FastifyRequest, FastifyReply } from "fastify";
import { errorResponse, escapeRegex } from '../utilities/helpers.ts';
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkLocationAccess, getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { registerEvidenceStatus } from "../services/PharmacyRestrictedSupply.ts";

async function getRegisterScope(request: FastifyRequest) {
  const scope = resolveAuthorizedOrganizationScope(request);
  if (!scope.allowed) return scope;

  const { locationId } = request.query as { locationId?: string };
  const filter: Record<string, any> = {};
  if (locationId) {
    const locationAccess = await checkLocationAccess(request, locationId);
    if (!locationAccess.allowed) return locationAccess;
    if (scope.organizationId && scope.organizationId !== locationAccess.organizationId) {
      return { allowed: false as const, statusCode: 404 as const, message: "Location not found" };
    }
    filter.organizationId = locationAccess.organizationId;
    filter.locationId = locationId;
  } else {
    // Root support reads must deliberately select a tenant or a physical location.
    if (!scope.organizationId) {
      return { allowed: false as const, statusCode: 400 as const, message: "Organization or location context is required" };
    }
    filter.organizationId = scope.organizationId;
    const locationIds = await getRequestLocationIds(request);
    if (locationIds) filter.locationId = { $in: locationIds };
  }
  return { allowed: true as const, filter };
}

export async function getScheduleH1Entries(request: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  const query = request.query as {
    locationId?: string;
    scheduleType?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    page?: string | number;
    limit?: string | number;
  };

  const scope = await getRegisterScope(request);
  if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
  const filter = scope.filter;
  filter.scheduleType = query.scheduleType || "schedule_h1";
  if (!["schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(filter.scheduleType)) return reply.code(400).send(errorResponse("Invalid schedule type"));
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
    data: entries.map(registerEvidenceStatus),
    pagination: {
      total: totalCount,
      page: currentPage,
      limit: pageSize,
      totalPages,
    },
  });
}

export async function exportScheduleH1Register(request: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  const query = request.query as {
    locationId?: string;
    scheduleType?: string;
    startDate?: string;
    endDate?: string;
  };

  const scope = await getRegisterScope(request);
  if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
  const filter = scope.filter;
  filter.scheduleType = query.scheduleType || "schedule_h1";
  if (!["schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(filter.scheduleType)) return reply.code(400).send(errorResponse("Invalid schedule type"));
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
      statutoryAct: filter.scheduleType === "schedule_h1" ? "Drugs and Cosmetics Rules, 1945 (Rule 65 - Schedule H1 Register)" : "Drugs and Cosmetics Rules, 1945 (Rule 65 - prescription register)",
      scheduleType: filter.scheduleType,
      totalRecords: entries.length,
      records: entries.map(registerEvidenceStatus),
    },
  });
}
