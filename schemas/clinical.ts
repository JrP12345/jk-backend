const objectIdPattern = "^[0-9a-fA-F]{24}$";

export const createBedSchema = {
  body: {
    type: "object",
    required: ["clinicId", "wardName", "bedNumber", "pricePerDay"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      wardName: { type: "string", minLength: 1 },
      bedNumber: { type: "string", minLength: 1 },
      pricePerDay: { type: "number", minimum: 0 }
    },
    additionalProperties: false
  }
};

export const admitPatientSchema = {
  body: {
    type: "object",
    required: ["clinicId", "patientId", "bedId", "doctorInCharge", "reasonForAdmission"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      patientId: { type: "string", pattern: objectIdPattern },
      bedId: { type: "string", pattern: objectIdPattern },
      doctorInCharge: { type: "string", pattern: objectIdPattern },
      reasonForAdmission: { type: "string", minLength: 1 },
      notes: { type: "string" }
    },
    additionalProperties: false
  }
};

export const createMedicineSchema = {
  body: {
    type: "object",
    required: ["clinicId", "name", "genericName", "stockQuantity", "price", "costPrice", "expiryDate", "batchNumber"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      name: { type: "string", minLength: 1 },
      genericName: { type: "string", minLength: 1 },
      stockQuantity: { type: "number", minimum: 0 },
      price: { type: "number", minimum: 0 },
      costPrice: { type: "number", minimum: 0 },
      expiryDate: { type: "string", minLength: 1 },
      batchNumber: { type: "string", minLength: 1 }
    },
    additionalProperties: false
  }
};

export const dispensePrescriptionSchema = {
  body: {
    type: "object",
    required: ["patientId", "clinicId", "items"],
    properties: {
      patientId: { type: "string", pattern: objectIdPattern },
      clinicId: { type: "string", pattern: objectIdPattern },
      doctorId: { type: "string", pattern: objectIdPattern },
      prescriptionIds: {
        type: "array",
        items: { type: "string", pattern: objectIdPattern },
      },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["medicineId", "quantity"],
          properties: {
            medicineId: { type: "string", pattern: objectIdPattern },
            quantity: { type: "number", minimum: 1 }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }
};

export const createLabTestSchema = {
  body: {
    type: "object",
    required: ["clinicId", "name", "code", "department", "sampleType", "price", "normalRange"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      name: { type: "string", minLength: 1 },
      code: { type: "string", minLength: 1 },
      department: { type: "string", minLength: 1 },
      sampleType: { type: "string", minLength: 1 },
      price: { type: "number", minimum: 0 },
      normalRange: { type: "string", minLength: 1 }
    },
    additionalProperties: false
  }
};

export const createLabOrderSchema = {
  body: {
    type: "object",
    required: ["clinicId", "patientId", "doctorId", "testId"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      patientId: { type: "string", pattern: objectIdPattern },
      doctorId: { type: "string", pattern: objectIdPattern },
      testId: { type: "string", pattern: objectIdPattern }
    },
    additionalProperties: false
  }
};

export const uploadLabResultSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern }
    }
  },
  body: {
    type: "object",
    required: ["resultValue"],
    properties: {
      resultValue: { type: "string", minLength: 1 },
      notes: { type: "string" },
      attachmentUrl: { type: "string" }
    },
    additionalProperties: false
  }
};
