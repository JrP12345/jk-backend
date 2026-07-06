const objectIdPattern = "^[0-9a-fA-F]{24}$";
const emailPattern = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

export const createOrganizationSchema = {
  body: {
    type: "object",
    required: ["org_name", "city", "admin_name", "admin_email", "admin_password"],
    properties: {
      org_name: { type: "string", minLength: 1 },
      city: { type: "string", minLength: 1 },
      address: { type: "string" },
      org_phone: { type: "string" },
      org_email: { type: "string", pattern: emailPattern },
      description: { type: "string" },
      image_url: { type: "string" },
      timings: { type: "string" },
      working_days: { type: "string" },
      admin_name: { type: "string", minLength: 1 },
      admin_email: { type: "string", pattern: emailPattern },
      admin_password: { type: "string", minLength: 6 },
      admin_phone: { type: "string" }
    },
    additionalProperties: false
  }
};

export const addDoctorSchema = {
  body: {
    type: "object",
    required: ["name", "email", "password", "specialization"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", pattern: emailPattern },
      password: { type: "string", minLength: 6 },
      phone: { type: "string" },
      specialization: { type: "string", minLength: 1 },
      qualification: { type: "string" },
      experience_years: { type: "number", minimum: 0 },
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
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }
};

export const addReceptionistSchema = {
  body: {
    type: "object",
    required: ["name", "email", "password", "clinicId"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", pattern: emailPattern },
      password: { type: "string", minLength: 6 },
      phone: { type: "string" },
      clinicId: { type: "string", pattern: objectIdPattern }
    },
    additionalProperties: false
  }
};

export const createClinicSchema = {
  body: {
    type: "object",
    required: ["name", "city"],
    properties: {
      name: { type: "string", minLength: 1 },
      city: { type: "string", minLength: 1 },
      address: { type: "string" },
      phone: { type: "string" },
      email: { type: "string", pattern: emailPattern },
      timings: { type: "string" },
      workingDays: { type: "string" }
    },
    additionalProperties: false
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
      sessionDuration: { type: "number", minimum: 1 }
    },
    additionalProperties: false
  }
};
