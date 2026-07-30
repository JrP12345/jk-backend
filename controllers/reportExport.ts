import type { FastifyRequest, FastifyReply } from "fastify";
import { generateCsvReport } from "../services/ReportExportService.ts";
import { errorResponse } from "../utilities/helpers.ts";

export async function exportReport(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { reportType, clinicId } = req.query as {
      reportType: "billing" | "clinical" | "pharmacy";
      clinicId?: string;
    };

    const type = reportType || "billing";
    const csvContent = await generateCsvReport(type, clinicId);

    const filename = `ananta_${type}_report_${new Date().toISOString().split("T")[0]}.csv`;

    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.code(200).send(csvContent);
  } catch (err) {
    console.error("exportReport error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
