const objectIdPattern = "^[0-9a-fA-F]{24}$";

export const objectIdParamSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern }
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
      encounterId: { type: "string", pattern: objectIdPattern },
      appointmentId: { type: "string", pattern: objectIdPattern },
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
    },
    additionalProperties: false
  },
  body: {
    type: "object",
    required: ["resultValue"],
    properties: {
      resultValue: { type: "string", minLength: 1 },
      resultNotes: { type: "string" },
      attachmentUrl: { type: "string" }
    },
    additionalProperties: false
  }
};

export const updateLabOrderStatusSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["ordered", "sample-collected", "processing", "result-uploaded", "cancelled"]
      },
      cancellationReason: { type: "string", minLength: 1 }
    },
    additionalProperties: false,
    allOf: [
      {
        if: {
          properties: { status: { const: "cancelled" } },
          required: ["status"]
        },
        then: { required: ["cancellationReason"] }
      }
    ]
  }
};

export const collectLabSampleSchema = objectIdParamSchema;

export const labOrdersQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      patientId: { type: "string", pattern: objectIdPattern },
      status: {
        type: "string",
        enum: ["ordered", "sample-collected", "processing", "result-uploaded", "cancelled"]
      },
      page: { type: "string", pattern: "^[0-9]{1,6}$" },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" }
    },
    additionalProperties: false
  }
};

export const labTestsQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      page: { type: "string", pattern: "^[0-9]{1,6}$" },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" }
    },
    additionalProperties: false
  }
};

export const patientLabComparisonSchema = {
  params: {
    type: "object",
    required: ["patientId"],
    properties: {
      patientId: { type: "string", pattern: objectIdPattern }
    },
    additionalProperties: false
  }
};

export const labTatMetricsSchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern }
    },
    additionalProperties: false
  }
};

export const createImagingStudySchema = {
  body: {
    type: "object",
    required: ["patientId", "clinicId", "modality", "studyDescription"],
    properties: {
      patientId: { type: "string", pattern: objectIdPattern },
      clinicId: { type: "string", pattern: objectIdPattern },
      modality: { type: "string", enum: ["CR", "DX", "CT", "MR", "US", "MG"] },
      studyDescription: { type: "string", minLength: 1 },
      dicomWebUrl: { type: "string" }
    },
    additionalProperties: false
  }
};

export const imagingStudiesQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      patientId: { type: "string", pattern: objectIdPattern },
      modality: { type: "string", enum: ["CR", "DX", "CT", "MR", "US", "MG"] },
      page: { type: "string", pattern: "^[0-9]{1,6}$" },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" }
    },
    additionalProperties: false
  }
};

export const updateImagingStudyStatusSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["requested", "in_progress", "completed", "reported", "cancelled"] }
    },
    additionalProperties: false
  }
};

export const signRadiologyReportSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    required: ["radiologyReport"],
    properties: {
      radiologyReport: { type: "string", minLength: 1 }
    },
    additionalProperties: false
  }
};

export const createTeleSessionSchema = {
  body: {
    type: "object",
    required: ["appointmentId"],
    properties: {
      appointmentId: { type: "string", pattern: objectIdPattern }
    },
    additionalProperties: false
  }
};

export const teleSessionAppointmentParamSchema = {
  params: {
    type: "object",
    required: ["appointmentId"],
    properties: {
      appointmentId: { type: "string", pattern: objectIdPattern }
    },
    additionalProperties: false
  }
};

export const teleSessionIdParamSchema = objectIdParamSchema;

export const teleSessionsQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      status: { type: "string", enum: ["scheduled", "active", "ended", "missed"] },
      page: { type: "string", pattern: "^[0-9]{1,6}$" },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" }
    },
    additionalProperties: false
  }
};

export const updateTeleSessionNotesSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    minProperties: 1,
    properties: {
      clinicalNotes: { type: "string" },
      vitalsRecorded: {
        type: "object",
        properties: {
          bp: { type: "string" },
          pulse: { type: "string" },
          temp: { type: "string" },
          spo2: { type: "string" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
};

export const teleSessionSignalSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    required: ["signalType", "payload"],
    properties: {
      signalType: { type: "string", minLength: 1, maxLength: 100 },
      payload: { type: "object" }
    },
    additionalProperties: false
  }
};

export const shiftsQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      date: { type: "string", minLength: 1 },
      ward: { type: "string" },
      staffRole: { type: "string", enum: ["ALL", "Nurse", "Doctor", "Technician", "Admin", "Pharmacist"] },
      status: { type: "string", enum: ["ALL", "scheduled", "checked_in", "checked_out", "absent", "swapped"] }
    },
    additionalProperties: false
  }
};

export const createShiftSchema = {
  body: {
    type: "object",
    required: ["clinicId", "staffName", "shiftDate", "shiftType"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      departmentId: { type: "string", pattern: objectIdPattern },
      staffId: { type: "string", pattern: objectIdPattern },
      staffName: { type: "string", minLength: 1 },
      staffRole: { type: "string", enum: ["Nurse", "Doctor", "Technician", "Admin", "Pharmacist"] },
      shiftDate: { type: "string", minLength: 1 },
      shiftType: { type: "string", enum: ["morning", "evening", "night", "general", "on_call"] },
      startTime: { type: "string", minLength: 1 },
      endTime: { type: "string", minLength: 1 },
      ward: { type: "string" },
      assignedPatientsCount: { type: "number", minimum: 0 }
    },
    additionalProperties: false
  }
};

export const updateShiftStatusSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["scheduled", "checked_in", "checked_out", "absent", "swapped"] },
      overtimeHours: { type: "number", minimum: 0 }
    },
    additionalProperties: false
  }
};

export const updateShiftHandoverSchema = {
  params: objectIdParamSchema.params,
  body: {
    type: "object",
    required: ["handoverNotes"],
    properties: {
      handoverNotes: { type: "string" }
    },
    additionalProperties: false
  }
};

export const deleteShiftSchema = objectIdParamSchema;
