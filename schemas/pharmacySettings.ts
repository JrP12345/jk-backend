export const pharmacySettingsSchema = { body: {
  type: "object", additionalProperties: false, required: ["enabled", "expectedRevision", "reviewReference"],
  properties: { enabled: { type: "boolean" }, expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }, reviewReference: { type: "string", minLength: 3, maxLength: 500 } },
} };
