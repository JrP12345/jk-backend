const ref = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
const command = { expectedRevision: { type: 'integer', minimum: 0 }, clientRequestId: { type: 'string', minLength: 8, maxLength: 100 } };
const due = { type: 'string', format: 'date-time' }, note = { type: 'string', maxLength: 1000 };
export const crmTaskParams = { type: 'object', required: ['id'], properties: { id: ref } };
export const taskListSchema = { querystring: { type: 'object', additionalProperties: false, properties: {
  owner: { type: 'string', enum: ['mine', 'team', 'unassigned'] }, status: { type: 'string', enum: ['active', 'completed', 'all'] }, due: { type: 'string', enum: ['all', 'due', 'snoozed'] },
  locationId: { anyOf: [ref, { type: 'string', maxLength: 0 }] }, cursor: ref, kind: { type: 'string', enum: ['crm_callback', 'crm_review', 'crm_inquiry', 'crm_followup', 'crm_recovery', 'crm_feedback', 'crm_diagnostic'] },
} } };
export const taskCreateSchema = { body: { type: 'object', additionalProperties: false, required: ['clientRequestId', 'locationId', 'kind', 'dueDate'], properties: {
  clientRequestId: command.clientRequestId, locationId: ref, patientId: ref, assignedTo: { anyOf: [ref, { type: 'null' }] }, kind: { type: 'string', enum: ['crm_callback', 'crm_review'] }, dueDate: due, note,
} } };
export const taskUpdateSchema = { params: crmTaskParams, body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'clientRequestId', 'action'], properties: { ...command,
  action: { type: 'string', enum: ['assign', 'start', 'complete', 'snooze', 'reopen'] }, assignedTo: { anyOf: [ref, { type: 'null' }] }, dueDate: due, snoozedUntil: due, reason: note,
  outcome: { type: 'string', enum: ['contacted', 'unreachable', 'invalid_contact', 'no_response', 'declined', 'resolved', 'other'] }, closeInquiry: { type: 'boolean' }, closeReason: { type: 'string', enum: ['resolved', 'not_proceeding', 'unreachable', 'other'] },
  nextAction: { type: 'object', additionalProperties: false, required: ['kind', 'dueAt'], properties: { kind: { type: 'string', enum: ['contact', 'review', 'book'] }, dueAt: due } },
} } };
