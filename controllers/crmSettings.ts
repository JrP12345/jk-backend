import type { FastifyRequest, FastifyReply } from 'fastify';
import { Organization } from '../models/Organization.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { crmAuthority } from '../services/CrmAuthorityService.ts';
import { crmEntitlementActive } from '../services/CrmEntitlementService.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';

export function crmSettingsDTO(value: any) {
  return { revision: value?.revision || 0, automationEnabled: value?.automationEnabled === true, campaignsEnabled: false,
    defaultInquiryHours: value?.defaultInquiryHours ?? 1, defaultTaskHours: value?.defaultTaskHours ?? 24,
    reminderStartHour: value?.reminderStartHour ?? 8, reminderEndHour: value?.reminderEndHour ?? 20,
    feedbackRecoveryRating: value?.feedbackRecoveryRating ?? 2 };
}
function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, 'CRM settings could not be saved'); return reply.code(503).send(errorResponse('The settings result could not be confirmed. Retry the submitted request.'));
}
export async function getCrmSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), org = await Organization.findById(authority.organizationId).select('crmSettings').lean();
    if (!org) throw new CommandError(404, 'Organization not found');
    return reply.send(successResponse({ ...crmSettingsDTO(org.crmSettings), entitlementActive: await crmEntitlementActive(authority.organizationId), organizationWideAccess: authority.allLocations }));
  } catch (error) { return failure(req, reply, error); }
}
export async function updateCrmSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), input = req.body as any;
    if (!authority.allLocations) throw new CommandError(403, 'Organization settings require reviewed access to all branches');
    if (input.reminderStartHour >= input.reminderEndHour) throw new CommandError(400, 'The reminder window must end after it starts');
    const result = await executeRecordedCommand(`crm-settings:${authority.organizationId}:${authority.actorId}`, input.clientRequestId, input, async () => {
      const currentAuthority = await crmAuthority(req);
      if (!currentAuthority.allLocations) throw new CommandError(403, 'Your branch authority changed');
      if (input.automationEnabled && !await crmEntitlementActive(authority.organizationId)) throw new CommandError(409, 'An active persisted subscription is required to enable reminders');
      const org = await Organization.findOneAndUpdate({ _id: authority.organizationId, ...(input.expectedRevision === 0 ? { $or: [{ 'crmSettings.revision': 0 }, { 'crmSettings.revision': { $exists: false } }] } : { 'crmSettings.revision': input.expectedRevision }) }, { $set: {
        'crmSettings.automationEnabled': input.automationEnabled, 'crmSettings.defaultInquiryHours': input.defaultInquiryHours, 'crmSettings.defaultTaskHours': input.defaultTaskHours,
        'crmSettings.reminderStartHour': input.reminderStartHour, 'crmSettings.reminderEndHour': input.reminderEndHour, 'crmSettings.feedbackRecoveryRating': input.feedbackRecoveryRating,
      }, $inc: { 'crmSettings.revision': 1 } }, { returnDocument: 'after', runValidators: true }).select('crmSettings');
      if (!org) throw new CommandError(409, 'Settings changed. Reload before saving.');
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: 'CRM_SETTINGS_CHANGED', targetId: org._id, targetModel: 'Organization', category: 'ADMIN', details: crmSettingsDTO(org.crmSettings) });
      return org.id;
    });
    const org = await Organization.findById(result.resultId).select('crmSettings').lean();
    return reply.send(successResponse({ ...crmSettingsDTO(org?.crmSettings), replayed: result.replayed, entitlementActive: await crmEntitlementActive(authority.organizationId), organizationWideAccess: authority.allLocations }));
  } catch (error) { return failure(req, reply, error); }
}
