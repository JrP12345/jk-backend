import type { FastifyRequest, FastifyReply } from "fastify";
import { generateCsvReport } from "../services/ReportExportService.ts";
import { errorResponse } from "../utilities/helpers.ts";
import {
  getRequestOrganizationId,
  isRootRequest,
  checkClinicAccess,
} from "../utilities/tenant.ts";

export async function exportReport(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { reportType, clinicId, organizationId: queryOrgId } = req.query as {
      reportType: "billing" | "clinical" | "pharmacy";
      clinicId?: string;
      organizationId?: string;
    };

    const isRoot = isRootRequest(req);
    let targetOrgId = getRequestOrganizationId(req);

    if (isRoot && queryOrgId) {
      targetOrgId = queryOrgId;
    }

    if (!isRoot && !targetOrgId) {
      return reply.code(403).send(errorResponse("Organization context is required for report export"));
    }

    // If clinicId is provided, verify it belongs to caller's organization
    if (clinicId) {
      const accessCheck = await checkClinicAccess(req, clinicId);
      if (!accessCheck.allowed) {
        return reply.code(accessCheck.statusCode).send(errorResponse(accessCheck.message));
      }
    }

    const type = reportType || "billing";
    const csvContent = await generateCsvReport(type, targetOrgId, clinicId);

    const filename = `ananta_${type}_report_${new Date().toISOString().split("T")[0]}.csv`;

    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.code(200).send(csvContent);
  } catch (err) {
    console.error("exportReport error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
