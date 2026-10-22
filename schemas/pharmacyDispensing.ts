const text = { type: "string", minLength: 3, maxLength: 500 };
const expectedRevision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
export const pharmacyProfessionalReviewSchema = { body: {
  type: "object", additionalProperties: false,
  required: ["expectedRevision", "registrationNumber", "council", "address", "reviewReference", "validUntil", "active"],
  properties: { expectedRevision, registrationNumber: text, council: text, address: text, reviewReference: text,
    validUntil: { type: "string", format: "date-time" }, active: { type: "boolean" } },
} };
export const pharmacyDispensingReviewSchema = { body: {
  type: "object", additionalProperties: false, required: ["expectedRevision", "scheduleType", "reviewReference"],
  properties: { expectedRevision, scheduleType: { type: "string", enum: ["general", "schedule_h", "schedule_h1", "schedule_x", "narcotic"] }, reviewReference: text },
} };
