import { DPDP_PURPOSES } from "../models/DPDPConsent.ts";

const subject = { patientId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, organizationId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
  clientRequestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$" } };
export const consentCommandSchema = { body: { type: "object", additionalProperties: false,
  required: ["clientRequestId", "expectedRevision", "method", "updates"], properties: { ...subject,
    expectedRevision: { type: "integer", minimum: 0 }, method: { type: "string", enum: ["portal_confirmation", "in_person_confirmation", "written_consent", "verified_patient_request"] },
    acknowledged: { type: "boolean" }, noticeVersion: { type: "string", maxLength: 100 }, note: { type: "string", maxLength: 500 },
    updates: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["purpose", "status"],
      properties: { purpose: { type: "string", enum: [...DPDP_PURPOSES] }, status: { type: "string", enum: ["GRANTED", "WITHDRAWN"] } } } },
  } } };
export const privacyRequestSchema = { body: { type: "object", additionalProperties: false, required: ["clientRequestId", "reason"], properties: { ...subject,
  reason: { type: "string", minLength: 1, maxLength: 500 } } } };
export const privacyReviewSchema = { body: { type: "object", additionalProperties: false, required: ["clientRequestId", "expectedRevision", "decision", "reason", "retentionBasis"], properties: { ...subject,
  expectedRevision: { type: "integer", minimum: 0 }, decision: { type: "string", enum: ["under_review", "retained", "rejected", "fulfilled"] },
  reason: { type: "string", minLength: 1, maxLength: 500 }, retentionBasis: { type: "string", minLength: 1, maxLength: 200 }, scopeConfirmed: { type: "boolean" } } } };
