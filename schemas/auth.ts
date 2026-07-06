export const registerPatientSchema = {
  body: {
    type: "object",
    required: ["name", "email", "password"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
      password: { type: "string", minLength: 6 },
      phone: { type: "string" }
    },
    additionalProperties: false
  }
};

export const loginSchema = {
  body: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
      password: { type: "string", minLength: 6 }
    },
    additionalProperties: false
  }
};
