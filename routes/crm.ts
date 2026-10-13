import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { inquiryCreateSchema, inquiryUpdateSchema, inquiryConversionSchema } from "../schemas/crmInquiry.ts";
import { convertInquiry } from "../controllers/crmConversion.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { getPatientRelationship, updatePatientRelationship } from "../controllers/crmRelationship.ts";
import { relationshipReadSchema, relationshipUpdateSchema } from "../schemas/crmRelationship.ts";
import { listCrmTasks, getCrmTask, captureCrmTask, updateCrmTask } from "../controllers/crmTask.ts";
import { taskCreateSchema, taskUpdateSchema, crmTaskParams, taskListSchema } from "../schemas/crmTask.ts";
import { convertPatientTask } from "../controllers/crmTaskConversion.ts";
import { reviewCareFollowUp } from "../controllers/crmCareReview.ts";
import { listCrmCalls, recordCrmCall } from '../controllers/crmCallHistory.ts';
import { listPatientMessages, queuePatientMessage, previewPatientMessage } from '../controllers/crmCommunication.ts';
import { listInboundMessages, routeInboundMessage } from '../controllers/crmInbound.ts';
import { createInquiry, listInquiries, getInquiry, updateInquiry, listCrmAssignees } from "../controllers/crmInquiry.ts";
import { getCrmAnalytics } from '../controllers/crmAnalytics.ts';
import { getCrmSettings, updateCrmSettings } from '../controllers/crmSettings.ts';
import { listCrmLocations } from '../controllers/crmLocations.ts';
import { listFamilyAuthorizations, reviewFamilyAuthorization, listFamilyRecipients } from '../controllers/crmFamilyAuthority.ts';

export default async function crmRoutes(app: FastifyInstance) {
  const callRef = crmTaskParams.properties.id;
  const callSubject = { patientId: callRef, inquiryId: callRef, locationId: callRef };
  const read = { preHandler: [authenticate, checkAnyPermission("VIEW_CRM")] };
  const familyReview = { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('ADMINISTRATIVE_GOVERNANCE'), checkAnyPermission('REVIEW_PATIENT_IDENTITY')] };
  app.get('/api/crm/patients/:id/family-recipients', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('MANAGE_PATIENTS')], schema: { params: crmTaskParams, querystring: { type: 'object', additionalProperties: false, properties: { cursor: callRef } } } }, listFamilyRecipients);
  app.get('/api/crm/patients/:id/family-authorizations', { ...familyReview, schema: { params: crmTaskParams, querystring: { type: 'object', additionalProperties: false, properties: { cursor: callRef } } } }, listFamilyAuthorizations);
  app.put('/api/crm/patients/:id/family-authorizations/:familyId', { ...familyReview, schema: { params: { type: 'object', required: ['id', 'familyId'], properties: { id: callRef, familyId: callRef } }, body: { type: 'object', additionalProperties: false, required: ['clientRequestId', 'expectedRevision', 'identityVerified', 'reason', 'grants'], properties: {
    clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, identityVerified: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 500 }, grants: { type: 'object', additionalProperties: false, required: ['communication', 'consent', 'dataRights'], properties: { communication: { type: 'boolean' }, consent: { type: 'boolean' }, dataRights: { type: 'boolean' } } },
  } } } }, reviewFamilyAuthorization);
  app.get('/api/crm/locations', { ...read, schema: { querystring: { type: 'object', additionalProperties: false,
    properties: { page: { type: 'integer', minimum: 1, maximum: 5000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 200 } } } } }, listCrmLocations);
  const write = { preHandler: [authenticate, checkAnyPermission("MANAGE_CRM_INQUIRIES")] };
  app.get('/api/crm/analytics', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('VIEW_CRM_ANALYTICS')], config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { querystring: { type: 'object', additionalProperties: false, properties: { locationId: callRef, startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' } } } } }, getCrmAnalytics);
  app.get('/api/crm/settings', read, getCrmSettings);
  app.patch('/api/crm/settings', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('MANAGE_CRM_SETTINGS')], schema: { body: { type: 'object', additionalProperties: false, required: ['clientRequestId', 'expectedRevision', 'automationEnabled', 'defaultInquiryHours', 'defaultTaskHours', 'reminderStartHour', 'reminderEndHour', 'feedbackRecoveryRating'], properties: {
    clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, automationEnabled: { type: 'boolean' }, defaultInquiryHours: { type: 'integer', minimum: 1, maximum: 168 }, defaultTaskHours: { type: 'integer', minimum: 1, maximum: 168 }, reminderStartHour: { type: 'integer', minimum: 0, maximum: 23 }, reminderEndHour: { type: 'integer', minimum: 1, maximum: 24 }, feedbackRecoveryRating: { type: 'integer', minimum: 1, maximum: 3 }, campaignsEnabled: { type: 'boolean', enum: [false] },
  } } } }, updateCrmSettings);
  app.get('/api/crm/communications/inbound', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('COMMUNICATE_PATIENTS')], schema: { querystring: { type: 'object', additionalProperties: false, properties: { cursor: callRef, shared: { type: 'boolean' }, organizationId: callRef, inquiryId: callRef, patientId: callRef } } } }, listInboundMessages);
  app.post('/api/crm/communications/inbound/:id/route', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('COMMUNICATE_PATIENTS'), checkAnyPermission('MANAGE_CRM_INQUIRIES')], schema: { params: crmTaskParams, body: { type: 'object', additionalProperties: false, required: ['clientRequestId', 'expectedRevision', 'inquiryId', 'subjectVerified', 'reason'], properties: { clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, inquiryId: callRef, organizationId: callRef, subjectVerified: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } } } }, routeInboundMessage);
  app.get('/api/crm/communications/messages', { ...read, schema: { querystring: { type: 'object', additionalProperties: false, required: ['patientId'], properties: { patientId: callRef, cursor: callRef } } } }, listPatientMessages);
  app.get('/api/crm/communications/messages/preview', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('COMMUNICATE_PATIENTS')], schema: { querystring: { type: 'object', additionalProperties: false, required: ['patientId', 'locationId', 'channel', 'purpose'], properties: { patientId: callRef, locationId: callRef, taskId: callRef, channel: { type: 'string', enum: ['whatsapp', 'email'] }, purpose: { type: 'string', enum: ['care_operations', 'care_followup', 'feedback'] } } } } }, previewPatientMessage);
  app.post('/api/crm/communications/messages', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('COMMUNICATE_PATIENTS')], schema: { body: { type: 'object', additionalProperties: false, required: ['clientRequestId', 'patientId', 'locationId', 'channel', 'purpose', 'subjectVerified', 'recipientHash'], properties: {
    clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, patientId: callRef, locationId: callRef, taskId: callRef, channel: { type: 'string', enum: ['whatsapp', 'email'] }, purpose: { type: 'string', enum: ['care_operations', 'care_followup', 'feedback'] }, subjectVerified: { type: 'boolean' }, recipientHash: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]+$' },
  } } } }, queuePatientMessage);
  app.get("/api/crm/inquiries", read, listInquiries);
  app.post("/api/crm/inquiries", { ...write, schema: inquiryCreateSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, createInquiry);
  app.get("/api/crm/inquiries/:id", read, getInquiry);
  app.patch("/api/crm/inquiries/:id", { ...write, schema: inquiryUpdateSchema }, updateInquiry);
  app.get("/api/crm/assignees", read, listCrmAssignees);
  app.get('/api/crm/communications/calls', { ...read, schema: { querystring: { type: 'object', additionalProperties: false, oneOf: [{ required: ['patientId'] }, { required: ['inquiryId'] }], properties: { ...callSubject, cursor: callRef } } } }, listCrmCalls);
  app.post('/api/crm/communications/calls', { preHandler: [authenticate, checkAnyPermission('VIEW_CRM'), checkAnyPermission('COMMUNICATE_PATIENTS')], schema: { body: { type: 'object', additionalProperties: false, oneOf: [{ required: ['patientId'] }, { required: ['inquiryId'] }], required: ['clientRequestId', 'direction', 'outcome', 'occurredAt', 'subjectVerified'], properties: {
    ...callSubject, clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, direction: { type: 'string', enum: ['inbound', 'outbound'] }, outcome: { type: 'string', enum: ['contacted', 'no_answer', 'unreachable', 'invalid_contact', 'declined', 'other'] }, occurredAt: { type: 'string', format: 'date-time' }, subjectVerified: { type: 'boolean' }, note: { type: 'string', maxLength: 1000 },
  } } } }, recordCrmCall);
  app.get("/api/crm/patients/:id/relationship", { ...read, schema: relationshipReadSchema }, getPatientRelationship);
  app.patch("/api/crm/patients/:id/relationship", { schema: relationshipUpdateSchema, preHandler: [authenticate, checkAnyPermission("VIEW_CRM"), checkAnyPermission("MANAGE_PATIENTS")] }, updatePatientRelationship);
  app.get("/api/crm/tasks", { ...read, schema: taskListSchema }, listCrmTasks);
  app.get("/api/crm/tasks/:id", { ...read, schema: { params: crmTaskParams } }, getCrmTask);
  app.post("/api/crm/tasks", { schema: taskCreateSchema, preHandler: [authenticate, checkAnyPermission("MANAGE_CRM_TASKS")] }, captureCrmTask);
  app.patch("/api/crm/tasks/:id", { schema: taskUpdateSchema, preHandler: [authenticate, checkAnyPermission("MANAGE_CRM_TASKS")] }, updateCrmTask);
  app.post("/api/crm/tasks/:id/convert", { schema: inquiryConversionSchema, preHandler: [authenticate, checkAnyPermission("MANAGE_CRM_TASKS"), checkAnyPermission("MANAGE_APPOINTMENTS"), requireModule("appointments")] }, convertPatientTask);
  app.post("/api/crm/tasks/:id/review-follow-up", { schema: { params: crmTaskParams, body: { type: 'object', additionalProperties: false, required: ['clientRequestId', 'expectedRevision', 'decision', 'identityVerified', 'reason'], properties: {
    clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, decision: { type: 'string', enum: ['confirm_existing', 'recommendation', 'declined'] }, identityVerified: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 1000 }, dueAt: { type: 'string', format: 'date-time' },
  } } }, preHandler: [authenticate, checkAnyPermission("MANAGE_CRM_TASKS"), checkAnyPermission("MANAGE_APPOINTMENTS"), requireModule("appointments")] }, reviewCareFollowUp);
  app.post("/api/crm/inquiries/:id/convert", { schema: inquiryConversionSchema, preHandler: [authenticate, checkAnyPermission("MANAGE_CRM_INQUIRIES"), checkAnyPermission("MANAGE_APPOINTMENTS"), requireModule("appointments")] }, convertInquiry);
}
