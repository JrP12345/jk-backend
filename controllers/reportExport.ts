import type { FastifyRequest, FastifyReply } from "fastify";
import { generateCsvReport } from "../services/ReportExportService.ts";
import { errorResponse } from "../utilities/helpers.ts";
import {
  getRequestOrganizationId,
  isRootRequest,
  checkLocationAccess,
} from "../utilities/tenant.ts";
import { MAX_REPORT_RANGE_DAYS } from "../utilities/scalability.ts";
import { requestHasAnyPermission } from '../utilities/permissions.ts';

export async function exportReport(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { reportType, locationId, organizationId: queryOrgId, startDate, endDate } = req.query as {
      reportType: "billing" | "clinical" | "pharmacy";
      locationId?: string;
      organizationId?: string;
      startDate?: string;
      endDate?: string;
    };

    const required = reportType === 'clinical' ? ['VIEW_EHR'] : reportType === 'pharmacy' ? ['MANAGE_MEDICINES'] : ['VIEW_BILLING', 'MANAGE_BILLING'];
    if (!await requestHasAnyPermission(req, ...required)) return reply.code(403).send(errorResponse('Report permission is required'));

    if (startDate && endDate) {
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      if (isNaN(start) || isNaN(end)) {
        return reply.code(400).send(errorResponse("Invalid startDate or endDate format"));
      }
      if (start > end) {
        return reply.code(400).send(errorResponse("startDate cannot be after endDate"));
      }
      const diffDays = (end - start) / (1000 * 60 * 60 * 24);
      if (diffDays > MAX_REPORT_RANGE_DAYS) {
        return reply.code(400).send(errorResponse(`Report date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`));
      }
    }

    const isRoot = isRootRequest(req);
    let targetOrgId = getRequestOrganizationId(req);

    if (isRoot && queryOrgId) {
      targetOrgId = queryOrgId;
    }

    if (!isRoot && !targetOrgId) {
      return reply.code(403).send(errorResponse("Organization context is required for report export"));
    }

    // If locationId is provided, verify it belongs to caller's organization
    if (locationId) {
      const accessCheck = await checkLocationAccess(req, locationId);
      if (!accessCheck.allowed) {
        return reply.code(accessCheck.statusCode).send(errorResponse(accessCheck.message));
      }
    }

    const type = reportType || "billing";
    const csvContent = await generateCsvReport(type, targetOrgId, locationId, startDate, endDate);

    const filename = `ekavyu_${type}_report_${new Date().toISOString().split("T")[0]}.csv`;

    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.code(200).send(csvContent);
  } catch (err) {
    console.error("exportReport error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
