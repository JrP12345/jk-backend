import { expect } from "vitest";

/**
 * Immutable API Contract Fixtures for /api/v1 supported clients.
 * These fixtures verify that core endpoints maintain stable response shapes.
 */

export const AuthLoginResponseContractFixture = {
  success: true,
  data: {
    token: expect.any(String),
    user: {
      id: expect.any(String),
      email: expect.any(String),
      name: expect.any(String),
      role: expect.any(String),
    }
  },
  message: expect.any(String)
};

export const AppointmentResponseContractFixture = {
  success: true,
  data: {
    id: expect.any(String),
    clinicId: expect.anything(),
    doctorId: expect.anything(),
    patientId: expect.anything(),
    appointmentTime: expect.any(String),
    appointmentType: expect.any(String),
    status: expect.any(String),
    paymentStatus: expect.any(String)
  }
};

export const EncounterResponseContractFixture = {
  success: true,
  data: {
    id: expect.any(String),
    organizationId: expect.any(String),
    clinicId: expect.any(String),
    patientId: expect.anything(),
    doctorId: expect.anything(),
    encounterType: expect.any(String),
    status: expect.any(String),
    startedAt: expect.any(String)
  }
};

export const InvoiceResponseContractFixture = {
  success: true,
  data: {
    id: expect.any(String),
    invoiceNumber: expect.any(String),
    organizationId: expect.any(String),
    clinicId: expect.any(String),
    patientId: expect.anything(),
    totalAmount: expect.any(Number),
    amountPaid: expect.any(Number),
    balanceDue: expect.any(Number),
    status: expect.any(String)
  }
};
