/**
 * Schema fixtures for report exports matching actual MongoDB model fields.
 */
export const mockInvoiceReportFixture = {
  invoiceNumber: "INV-2026-001",
  patientId: {
    _id: "60d5ecb8b5c9c61234567890",
    name: "Aarav Sharma"
  },
  totalAmount: 1500,
  amountPaid: 1500,
  balanceDue: 0,
  status: "paid",
  createdAt: new Date("2026-09-20T10:00:00.000Z")
};

export const mockEncounterReportFixture = {
  _id: "60d5ecb8b5c9c61234567891",
  encounterType: "opd",
  status: "completed",
  patientId: {
    _id: "60d5ecb8b5c9c61234567890",
    name: "Aarav Sharma"
  },
  doctorId: {
    _id: "60d5ecb8b5c9c61234567892",
    name: "Dr. Priya Patel"
  },
  startedAt: new Date("2026-09-20T10:15:00.000Z"),
  createdAt: new Date("2026-09-20T10:15:00.000Z")
};

export const mockClinicalNoteReportFixture = {
  encounterId: "60d5ecb8b5c9c61234567891",
  isLatest: true,
  subjective: {
    chiefComplaint: "Acute dry cough and high fever for 3 days"
  }
};

export const mockMedicineBatchReportFixture = {
  batchNumber: "PAR-2026-B1",
  medicineId: {
    _id: "60d5ecb8b5c9c61234567893",
    name: "Paracetamol 650mg",
    code: "MED-PCM-650"
  },
  quantity: 450, // real model field (not quantityRemaining)
  sellingPrice: 35.5, // real model field (not pricePerUnit)
  mrp: 40.0,
  purchaseCost: 20.0,
  expiryDate: new Date("2027-12-31T00:00:00.000Z"),
  status: "active"
};
