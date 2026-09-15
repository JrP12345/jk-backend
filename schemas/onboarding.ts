const objectIdPattern = "^[0-9a-fA-F]{24}$";
const emailPattern = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";
const optionalEmailPattern = "^(|[^@\\s]+@[^@\\s]+\\.[^@\\s]+)$";

export const createOrganizationSchema = {
  body: {
    type: "object",
    required: ["org_name", "city", "admin_name", "admin_email", "admin_password"],
    properties: {
      org_name: { type: "string", minLength: 1 },
      city: { type: "string", minLength: 1 },
      address: { type: "string" },
      org_phone: { type: "string" },
      org_email: { type: "string" },
      description: { type: "string" },
      image_url: { type: "string" },
      timings: { type: "string" },
      working_days: { type: "string" },
      admin_name: { type: "string", minLength: 1 },
      admin_email: { type: "string", pattern: emailPattern },
      admin_password: { type: "string", minLength: 8 },
      admin_phone: { type: "string" },
      clinic_name: { type: "string" },
      clinic_city: { type: "string" },
      clinic_address: { type: "string" },
      clinic_phone: { type: "string" },
      clinic_email: { type: "string" },
      plan: { type: "string", enum: ["starter", "pro", "enterprise"] },
      maxClinics: { type: "number" },
      maxDoctors: { type: "number" },
      maxStaff: { type: "number" },
      taxId: { type: "string" },
      licenseNumber: { type: "string" },
      currency: { type: "string", enum: ["INR", "USD", "EUR", "GBP", "AED"] },
      timezone: { type: "string" },
      sendWelcomeEmail: { type: "boolean" },
    },
    additionalProperties: false
  }
};

export const organizationIdParamSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern },
    },
    additionalProperties: false,
  },
};

export const updateOrganizationSchema = {
  ...organizationIdParamSchema,
  body: {
    type: "object",
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      city: { type: "string", minLength: 1 },
      address: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
      email: { type: ["string", "null"], pattern: optionalEmailPattern },
      plan: { type: "string", enum: ["starter", "pro", "enterprise"] },
      maxClinics: { type: "number", minimum: 1 },
      maxDoctors: { type: "number", minimum: 1 },
      maxStaff: { type: "number", minimum: 1 },
      status: { type: "string", enum: ["active", "inactive"] },
      taxId: { type: ["string", "null"] },
      licenseNumber: { type: ["string", "null"] },
      currency: { type: "string", enum: ["INR", "USD", "EUR", "GBP", "AED"] },
      timezone: { type: "string" },
      image_url: { type: ["string", "null"] },
      logo_url: { type: ["string", "null"] },
      images: { type: "array", items: { type: "string" } },
      description: { type: ["string", "null"] },
      timings: { type: ["string", "null"] },
      working_days: { type: ["string", "null"] },
    },
    additionalProperties: false,
  },
};

export const globalUsersQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      q: { type: "string", maxLength: 100 },
      role: { type: "string", maxLength: 50 },
      organizationId: {
        anyOf: [
          { type: "string", enum: ["all"] },
          { type: "string", pattern: objectIdPattern },
        ],
      },
      clinicId: {
        anyOf: [
          { type: "string", enum: ["all"] },
          { type: "string", pattern: objectIdPattern },
        ],
      },
      page: { type: "string", pattern: "^[0-9]{1,6}$" },
      limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    },
    additionalProperties: false,
  },
};

export const addDoctorSchema = {
  body: {
    type: "object",
    required: ["name", "email", "password", "specialization"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", pattern: emailPattern },
      password: { type: "string", minLength: 8 },
      phone: { type: "string" },
      specialization: { type: "string", minLength: 1 },
      qualification: { type: "string" },
      experience_years: { type: "number", minimum: 0 },
      fees: { type: "number", minimum: 0 },
      timings: { type: "string" },
      working_days: { type: "string" },
      department: { type: "string" },
      registrationNumber: { type: "string" },
      digitalSignatureUrl: { type: "string" },
      letterheadDefaultMode: { type: "string", enum: ["plain_a4", "preprinted_stationery"] },
      clinicIds: { type: "array", items: { type: "string" } },
      clinicId: { type: "string" },
      consultationFee: { type: "number" },
      clinicAssignments: {
        type: "array",
        items: {
          type: "object",
          required: ["clinicId", "workingHours", "fees"],
          properties: {
            clinicId: { type: "string", pattern: objectIdPattern },
            workingHours: { type: "string", minLength: 1 },
            fees: { type: "number", minimum: 0 },
            sessionDuration: { type: "number", minimum: 1 }
          },
          additionalProperties: true
        }
      }
    },
    additionalProperties: true
  }
};

export const addReceptionistSchema = {
  body: {
    type: "object",
    required: ["name", "email", "password"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", pattern: emailPattern },
      password: { type: "string", minLength: 8 },
      phone: { type: "string" },
      shift: { type: "string" },
      clinicId: { type: "string" }
    },
    additionalProperties: false
  }
};

export const createClinicSchema = {
  body: {
    type: "object",
    required: ["name", "city"],
    properties: {
      organizationId: { type: "string" },
      name: { type: "string", minLength: 1 },
      city: { type: "string", minLength: 1 },
      address: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      timings: { type: "string" },
      workingDays: { type: "string" },
      facilities: { type: "array", items: { type: "string" } },
      image_url: { type: "string" },
      logo: { type: "string" },
      description: { type: "string" },
      latitude: { type: "number" },
      longitude: { type: "number" },
      upiVpa: { type: "string" },
      merchantName: { type: "string" }
    },
    additionalProperties: true
  }
};

export const updateClinicSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern }
    }
  },
  body: {
    type: "object",
    required: ["name", "city"],
    properties: {
      name: { type: "string", minLength: 1 },
      city: { type: "string", minLength: 1 },
      address: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      timings: { type: "string" },
      workingDays: { type: "string" },
      facilities: { type: "array", items: { type: "string" } },
      image_url: { type: "string" },
      logo: { type: "string" },
      description: { type: "string" },
      latitude: { type: "number" },
      longitude: { type: "number" },
      upiVpa: { type: "string" },
      merchantName: { type: "string" }
    },
    additionalProperties: true
  }
};

export const assignDoctorSchema = {
  body: {
    type: "object",
    required: ["doctorId", "clinicId", "workingHours", "fees"],
    properties: {
      doctorId: { type: "string", pattern: objectIdPattern },
      clinicId: { type: "string", pattern: objectIdPattern },
      workingHours: { type: "string", minLength: 1 },
      fees: { type: "number", minimum: 0 },
      sessionDuration: { type: "number", minimum: 1 },
      appointmentDuration: { type: "number", minimum: 1 },
      bookingMode: { type: "string", enum: ["time_slot", "sequential_queue"] },
      maxDailyTokens: { type: ["number", "null"], minimum: 1 },
      paymentRequired: { type: "boolean" },
      allowPayAtClinic: { type: "boolean" }
    },
    additionalProperties: false
  }
};

export const createDepartmentSchema = {
  body: {
    type: "object",
    required: ["name", "code"],
    properties: {
      name: { type: "string", minLength: 1 },
      code: { type: "string", minLength: 1 },
      description: { type: "string" },
      headDoctorId: { type: "string", pattern: objectIdPattern },
      clinicId: { type: "string", pattern: objectIdPattern },
    },
    additionalProperties: false,
  },
};
