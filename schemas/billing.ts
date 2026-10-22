const objectIdPattern = "^[0-9a-fA-F]{24}$";
const paymentMethod = { type: "string", enum: ["cash", "card", "upi", "net-banking", "insurance", "online"] };
const money = { type: "number", minimum: 0, maximum: 1e9 };
export const productQuoteSchema = { body: {
  type: "object", additionalProperties: false, required: ["planId", "priceRevision", "billingCycle", "doctorSeats", "locations"],
  properties: { planId: { type: "string", pattern: objectIdPattern }, priceRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    organizationId: { type: "string", pattern: objectIdPattern }, organization_id: { type: "string", pattern: objectIdPattern },
    billingCycle: { type: "string", enum: ["monthly", "annual"] }, doctorSeats: { type: "integer", minimum: 0, maximum: 1000 },
    locations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["locationId", "clinic", "pharmacy"],
      properties: { locationId: { type: "string", pattern: objectIdPattern }, clinic: { type: "boolean" }, pharmacy: { type: "boolean" } } } } },
} };
export const installmentSchema = {
  body: { type: "object", required: ["amount", "paymentMethod"], properties: {
    amount: { ...money, exclusiveMinimum: 0 }, paymentMethod,
    referenceNumber: { type: "string", maxLength: 200 }, notes: { type: "string", maxLength: 2000 },
    idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
  }, additionalProperties: false },
};
export const consolidatedCheckoutSchema = {
  body: { type: "object", required: ["appointmentId", "paymentMethod"], properties: {
    appointmentId: { type: "string", pattern: objectIdPattern }, paymentMethod,
    amountPaid: money, discount: money, customConsultFee: money, customConsultationFee: money,
    referenceNumber: { type: "string", maxLength: 200 }, notes: { type: "string", maxLength: 2000 },
    idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
  }, additionalProperties: false },
};

export const createInvoiceSchema = {
  body: {
    type: "object",
    required: ["patientId", "locationId", "doctorId", "items"],
    properties: {
      patientId: { type: "string", pattern: objectIdPattern },
      locationId: { type: "string", pattern: objectIdPattern },
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
