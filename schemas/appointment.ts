const objectIdPattern = "^[0-9a-fA-F]{24}$";
const emailPattern = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

export const bookAppointmentSchema = {
  body: {
    type: "object",
    required: ["clinicId", "doctorId", "appointmentTime", "appointmentType"],
    properties: {
      clinicId: { type: "string", pattern: objectIdPattern },
      doctorId: { type: "string", pattern: objectIdPattern },
      appointmentTime: { type: "string", minLength: 1 },
      appointmentType: { type: "string", enum: ["walk-in", "online", "reception", "qr"] },
      notes: { type: "string" },
      patientId: { type: "string", pattern: objectIdPattern },
      patientDetails: {
        type: "object",
        required: ["name", "dob", "gender"],
        properties: {
          name: { type: "string", minLength: 1 },
          dob: { type: "string", minLength: 1 },
          gender: { type: "string", enum: ["male", "female", "other"] },
          phone: { type: "string" },
          email: { type: "string", pattern: emailPattern },
          password: { type: "string", minLength: 8 },
          address: { type: "string" },
          allergies: { type: "array", items: { type: "string" } },
          conditions: { type: "array", items: { type: "string" } },
          medicalNotes: { type: "string" }
        },
        additionalProperties: false
      },
      followUpForAppointmentId: { type: "string", pattern: objectIdPattern },
      lockId: { type: "string" },
      forPatientId: { type: "string", pattern: objectIdPattern },
      duration: { type: "number", minimum: 1 },
      reasonForVisit: {
        type: "string",
        enum: ["new_consultation", "follow_up", "routine_checkup", "second_opinion", "report_review"]
      },
      payAtClinic: { type: "boolean" }
    },
    additionalProperties: false
  }
};

export const updateAppointmentStatusSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", pattern: objectIdPattern }
    }
  },
  body: {
    type: "object",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show"]
      },
      followUpRecommended: { type: "boolean" },
      followUpTimeline: { type: "string" },
      followUpNotes: { type: "string" },
      symptoms: { type: "string" },
      diagnosis: { type: "string" },
      prescriptions: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "dosage", "duration"],
          properties: {
            name: { type: "string", minLength: 1 },
            dosage: { type: "string", minLength: 1 },
            duration: { type: "string", minLength: 1 }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }
};
