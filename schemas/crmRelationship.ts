const reference = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
export const patientRelationshipParams = { type: 'object', required: ['id'], properties: { id: reference } };
export const relationshipReadSchema = { params: patientRelationshipParams, querystring: { type: 'object', additionalProperties: false, properties: { activityCursor: reference, inquiryCursor: reference } } };
export const relationshipUpdateSchema = { params: patientRelationshipParams, body: { type: 'object', additionalProperties: false,
  required: ['expectedRevision', 'clientRequestId', 'preferences', 'availability'], properties: {
    expectedRevision: { type: 'integer', minimum: 0 }, clientRequestId: { type: 'string', minLength: 8, maxLength: 100 },
    locationId: reference, ownerId: { anyOf: [reference, { type: 'null' }] },
    recipientType: { type: 'string', enum: ['patient', 'family'] }, familyRelationshipId: reference,
    availability: { type: 'string', enum: ['unknown', 'reachable', 'unreachable', 'invalid'] },
    preferences: { type: 'object', additionalProperties: false, required: ['language', 'preferredChannel', 'doNotContact'], properties: {
      language: { type: 'string', maxLength: 40 }, preferredChannel: { type: 'string', enum: ['phone', 'whatsapp', 'email', 'none'] }, doNotContact: { type: 'boolean' }
    } }
  } } };
