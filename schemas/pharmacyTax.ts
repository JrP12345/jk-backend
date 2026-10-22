const text = { type: "string", minLength: 3, maxLength: 500 };
export const pharmacyTaxProfileSchema = { body: {
  type: "object", additionalProperties: false,
  required: ["expectedRevision", "registration", "legalName", "address", "stateCode", "drugLicenceNumbers", "authorisedSignatory", "reviewReference", "pricesIncludeTax", "electronicReportingRequired", "minimumHsnDigits"],
  properties: { expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    registration: { type: "string", enum: ["regular", "composition", "unregistered"] }, legalName: text, address: text,
    stateCode: { type: "string", pattern: "^[0-9]{2}$" }, gstin: { type: "string", maxLength: 15 },
    drugLicenceNumbers: { type: "array", minItems: 1, maxItems: 10, items: text }, authorisedSignatory: text, reviewReference: text,
    pricesIncludeTax: { type: "boolean" }, electronicReportingRequired: { type: "boolean" }, minimumHsnDigits: { type: "integer", enum: [4, 6, 8] } },
} };
export const medicineTaxReviewSchema = { body: {
  type: "object", additionalProperties: false, required: ["expectedRevision", "hsnCode", "unitCode", "gstRate", "treatment", "reviewReference"],
  properties: { expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    hsnCode: { type: "string", pattern: "^[0-9]{4}([0-9]{2})?([0-9]{2})?$" }, gstRate: { type: "number", minimum: 0, maximum: 100 },
    unitCode: { type: "string", pattern: "^[A-Z]{3}$" },
    treatment: { type: "string", enum: ["taxable", "exempt", "nil_rated"] }, reviewReference: text },
} };
