import { INQUIRY_SOURCES, INQUIRY_CLOSE_REASONS } from "../models/Inquiry.ts";
const id = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const action = { type: "object", additionalProperties: false, required: ["kind", "dueAt"], properties: {
  kind: { type: "string", enum: ["contact", "review", "book"] }, dueAt: { type: "string", format: "date-time" },
} };
const fields = { locationId: id, patientId: id, callerName: { type: "string", maxLength: 120 }, phone: { type: "string", maxLength: 30 }, email: { type: "string", maxLength: 200 },
  source: { type: "string", enum: [...INQUIRY_SOURCES] }, reasonForContact: { type: "string", enum: ["booking", "reschedule", "cancellation", "service_question", "other", "unknown"] },
  requestedService: { type: "string", maxLength: 100 }, ownerId: { anyOf: [id, { type: "null" }] }, nextAction: action,
  note: { type: "string", maxLength: 1000 }, clientRequestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$" } };
export const inquiryCreateSchema = { body: { type: "object", additionalProperties: false, required: ["locationId", "nextAction", "clientRequestId"], properties: fields } };
export const inquiryUpdateSchema = { params: { type: "object", required: ["id"], properties: { id } }, body: { type: "object", additionalProperties: false,
  required: ["expectedRevision", "clientRequestId"], properties: { ...fields, expectedRevision: { type: "integer", minimum: 0 }, status: { type: "string", enum: ["open", "in_progress", "closed"] },
    closeReason: { type: "string", enum: [...INQUIRY_CLOSE_REASONS] }, duplicateInquiryId: id } } };
export const inquiryConversionSchema = { params: { type: "object", required: ["id"], properties: { id } }, body: { type: "object", additionalProperties: false,
  required: ["clientRequestId", "expectedRevision", "doctorId", "appointmentTime", "identityVerified"], properties: {
    clientRequestId: fields.clientRequestId, expectedRevision: { type: "integer", minimum: 0 }, doctorId: id, appointmentTime: { type: "string", format: "date-time" },
    identityVerified: { type: "boolean" }, identityReviewReason: { type: "string", maxLength: 500 }, patientId: id, payAtLocation: { type: "boolean" }, lockId: { type: "string", maxLength: 200 },
    patientDetails: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 120 },
      phone: fields.phone, email: fields.email, dob: { type: "string", maxLength: 30 }, gender: { type: "string", enum: ["male", "female", "other"] }, distinctPersonReason: { type: "string", maxLength: 500 } } },
  } } };
