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
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["description", "amount"],
          properties: {
            description: { type: "string", minLength: 1 },
            amount: { type: "number", minimum: 0 },
            quantity: { type: "number", minimum: 1 }
          },
          additionalProperties: false
        }
      },
      tax: { type: "number", minimum: 0 },
      discount: { type: "number", minimum: 0 }
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
