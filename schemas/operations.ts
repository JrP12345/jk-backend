const objectIdPattern = "^[0-9a-fA-F]{24}$";
const numericStringPattern = "^[0-9]{1,6}$";

export const whatsappConfigQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      organizationId: { type: "string", pattern: objectIdPattern },
    },
    additionalProperties: false,
  },
};

export const updateWhatsappConfigSchema = {
  querystring: whatsappConfigQuerySchema.querystring,
  body: {
    type: "object",
    minProperties: 1,
    properties: {
      organizationId: { type: "string", pattern: objectIdPattern },
      mode: { type: "string", enum: ["disabled", "shared", "dedicated"] },
      lowBalanceThreshold: { type: "number", minimum: 10 },
      autoRechargeEnabled: { type: "boolean" },
      autoRechargePack: { type: "string", enum: ["bronze", "silver", "gold"] },
      wabaId: { type: "string", maxLength: 200 },
      phoneNumberId: { type: "string", maxLength: 200 },
      accessToken: { type: "string", maxLength: 4096 },
      notifications: {
        type: "object",
        properties: {
          sendBookingConfirmation: { type: "boolean" },
          sendConsultationComplete: { type: "boolean" },
          sendAppointmentCancellation: { type: "boolean" },
          sendTurnApproaching: { type: "boolean" },
          sendQueueDelayAlert: { type: "boolean" },
          sendDisruptionAlert: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

export const whatsappTopUpSchema = {
  querystring: whatsappConfigQuerySchema.querystring,
  body: {
    type: "object",
    required: ["pack"],
    properties: {
      organizationId: { type: "string", pattern: objectIdPattern },
      pack: { type: "string", enum: ["bronze", "silver", "gold"] },
    },
    additionalProperties: false,
  },
};

export const reportExportSchema = {
  querystring: {
    type: "object",
    properties: {
      reportType: { type: "string", enum: ["billing", "clinical", "pharmacy"] },
      clinicId: { type: "string", pattern: objectIdPattern },
    },
    additionalProperties: false,
  },
};

export const upsertInsuranceTariffSchema = {
  body: {
    type: "object",
    required: ["tpaName", "serviceCode", "serviceName", "agreedRate"],
    properties: {
      tpaName: { type: "string", minLength: 1, maxLength: 200 },
      serviceCode: { type: "string", minLength: 1, maxLength: 100 },
      serviceName: { type: "string", minLength: 1, maxLength: 300 },
      agreedRate: { type: "number", minimum: 0 },
      isDisallowed: { type: "boolean" },
      disallowedReason: { type: "string", maxLength: 1000 },
      coPayPercentage: { type: "number", minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  },
};

export const insuranceTariffsQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      tpaName: { type: "string", maxLength: 200 },
      search: { type: "string", maxLength: 200 },
      page: { type: "string", pattern: numericStringPattern },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    },
    additionalProperties: false,
  },
};

export const evaluateTariffSchema = {
  body: {
    type: "object",
    required: ["tpaName", "items"],
    properties: {
      tpaName: { type: "string", minLength: 1, maxLength: 200 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          required: ["serviceCode", "amount", "quantity"],
          properties: {
            serviceCode: { type: "string", minLength: 1, maxLength: 100 },
            amount: { type: "number", minimum: 0 },
            quantity: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

export const createPreAuthSchema = {
  body: {
    type: "object",
    required: ["patientId", "clinicId", "doctorId", "tpaName", "policyNumber", "diagnosisCode", "proposedTreatment", "requestedAmount"],
    properties: {
      patientId: { type: "string", pattern: objectIdPattern },
      clinicId: { type: "string", pattern: objectIdPattern },
      doctorId: { type: "string", pattern: objectIdPattern },
      tpaName: { type: "string", minLength: 1, maxLength: 200 },
      policyNumber: { type: "string", minLength: 1, maxLength: 200 },
      diagnosisCode: { type: "string", minLength: 1, maxLength: 100 },
      proposedTreatment: { type: "string", minLength: 1, maxLength: 2000 },
      requestedAmount: { type: "number", exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
};

export const preAuthListQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      status: { type: "string", enum: ["draft", "submitted", "under_query", "approved", "rejected", "cancelled"] },
      tpaName: { type: "string", maxLength: 200 },
      search: { type: "string", maxLength: 200 },
      page: { type: "string", pattern: numericStringPattern },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    },
    additionalProperties: false,
  },
};

export const updatePreAuthStatusSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern },
    },
    additionalProperties: false,
  },
  body: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["draft", "submitted", "under_query", "approved", "rejected", "cancelled"] },
      approvedAmount: { type: "number", minimum: 0 },
      approvalCode: { type: "string", maxLength: 200 },
      queryNotes: { type: "string", maxLength: 2000 },
      denialReason: { type: "string", maxLength: 2000 },
    },
    additionalProperties: false,
  },
};

export const evaluatePecSchema = {
  body: {
    type: "object",
    required: ["policyStartDate", "diagnosisCode"],
    properties: {
      policyStartDate: { type: "string", minLength: 1, maxLength: 100 },
      diagnosisCode: { type: "string", minLength: 1, maxLength: 100 },
      diagnosisDate: { type: "string", maxLength: 100 },
      customWaitingPeriodMonths: { type: "number", minimum: 0, maximum: 600 },
    },
    additionalProperties: false,
  },
};

export const feedbackSubmissionSchema = {
  body: {
    type: "object",
    required: ["appointmentId", "rating", "npsScore"],
    properties: {
      appointmentId: { type: "string", pattern: objectIdPattern },
      rating: { type: "number", minimum: 1, maximum: 5 },
      npsScore: { type: "number", minimum: 0, maximum: 10 },
      comments: { type: "string", maxLength: 2000 },
      aspectRatings: {
        type: "object",
        properties: {
          waitTime: { type: "number", minimum: 1, maximum: 5 },
          doctorAttitude: { type: "number", minimum: 1, maximum: 5 },
          cleanliness: { type: "number", minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

export const feedbackQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      doctorId: { type: "string", pattern: objectIdPattern },
      page: { type: "string", pattern: numericStringPattern },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    },
    additionalProperties: false,
  },
};

export const createTaskSchema = {
  body: {
    type: "object",
    required: ["title", "assignedTo"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 4000 },
      assignedTo: { type: "string", pattern: objectIdPattern },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      dueDate: { type: "string", maxLength: 100 },
    },
    additionalProperties: false,
  },
};

export const updateTaskStatusSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern },
    },
    additionalProperties: false,
  },
  body: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["todo", "in_progress", "review", "completed"] },
    },
    additionalProperties: false,
  },
};
