import type { FastifyReply, FastifyRequest } from "fastify";
import { CommandError } from "../services/CommandReceiptService.ts";
import { reportCatalogue, readPharmacyReport, pharmacyReportCsv } from "../services/PharmacyReportService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 50) return reply.code(409).send(errorResponse("Report exceeded its query budget; narrow the period or page size"));
  return reply.code(500).send(errorResponse("The report could not be confirmed. Refresh the source and try again."));
}
export async function getPharmacyReportCatalogue(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await reportCatalogue(req, (req.query as { locationId?: string }).locationId))); } catch (error) { return failure(reply, error); }
}
export const getPharmacyReport = (exporting = false, basicAlert = false) => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try {
    const page = await readPharmacyReport(req, (req.params as { kind: string }).kind, exporting, basicAlert);
    if (!exporting) return reply.send(successResponse(page));
    return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="pharmacy-${page.kind}-${page.endDate}.csv"`).header("X-Report-Digest", page.digest).send(pharmacyReportCsv(page));
  } catch (error) { return failure(reply, error); }
};
