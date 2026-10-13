import type { FastifyReply, FastifyRequest } from 'fastify';
import { Location } from '../models/Location.ts';
import { Organization } from '../models/Organization.ts';
import { crmAuthority } from '../services/CrmAuthorityService.ts';
import { CommandError } from '../services/CommandReceiptService.ts';
import { errorResponse, successResponse, setPaginationHeaders } from '../utilities/helpers.ts';

// CRM branch choices expose labels and scheduling timezone, without requiring
// facility administration or returning payment/contact/configuration fields.
export async function listCrmLocations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req);
    const { page = 1, limit = 200 } = req.query as { page?: number; limit?: number };
    const filter = { organizationId: authority.organizationId, isActive: { $ne: false },
      ...(authority.allLocations ? {} : { _id: { $in: authority.locationIds } }) };
    const [rows, totalCount, organization] = await Promise.all([
      Location.find(filter).select('_id name timezone').sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).maxTimeMS(5000).lean(),
      Location.countDocuments(filter).maxTimeMS(5000),
      Organization.findById(authority.organizationId).select('timezone').lean(),
    ]);
    setPaginationHeaders(reply, { totalCount, totalPages: Math.ceil(totalCount / limit), currentPage: page, pageSize: limit });
    return reply.send(successResponse(rows.map(row => ({ id: String(row._id), name: row.name,
      effectiveTimezone: row.timezone || organization?.timezone || 'Asia/Kolkata' }))));
  } catch (error) {
    if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error({ err: error }, 'CRM branch choices failed');
    return reply.code(503).send(errorResponse('Authorized CRM branches could not be loaded. Retry the branch list.'));
  }
}
