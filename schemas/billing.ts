const objectIdPattern = "^[0-9a-fA-F]{24}$";

export const createInvoiceSchema = {
  body: {
    type: "object",
    required: ["patientId", "clinicId", "doctorId", "items"],
    properties: {
      patientId: { type: "string", pattern: objectIdPattern },
      clinicId: { type: "string", pattern: objectIdPattern },
      doctorId: { type: "string", pattern: objectIdPattern },
      appointmentId: { type: "string", pattern: objectIdPattern },
      encounterId: { type: "string", pattern: objectIdPattern },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["description", "amount"],
          properties: {
            serviceCatalogId: { type: "string", pattern: objectIdPattern },
            description: { type: "string", minLength: 1 },
            amount: { type: "number", minimum: 0 },
            quantity: { type: "number", minimum: 1 },
            hsnSacCode: { type: "string" },
            gstRate: { type: "number", minimum: 0 }
          },
          additionalProperties: false
        }
      },
      tax: { type: "number", minimum: 0 },
      discount: { type: "number", minimum: 0 },
      supplierGstin: { type: "string" },
      customerGstin: { type: "string" },
      invoiceType: { type: "string", enum: ["B2C", "B2B", "SEZ", "EXPORT"] },
      placeOfSupply: { type: "string" },
      isInterstate: { type: "boolean" },
      dueDate: { type: "string" },
      managerApprovalCode: { type: "string" }
    },
    additionalProperties: false
  }
};

export const collectPaymentSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern }
    }
  },
  body: {
    type: "object",
    required: ["paymentMethod"],
    properties: {
      paymentMethod: {
        type: "string",
        enum: ["cash", "card", "upi", "net-banking", "insurance", "online"]
      }
    },
    additionalProperties: false
  }
};
