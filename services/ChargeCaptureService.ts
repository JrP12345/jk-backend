import mongoose from "mongoose";
import { Encounter } from "../models/Encounter.ts";
import { Patient } from "../models/Patient.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { Prescription } from "../models/Prescription.ts";
import { Medicine } from "../models/Medicine.ts";
import { Admission } from "../models/Admission.ts";
import { Bed } from "../models/Bed.ts";
import { ServiceCatalog } from "../models/ServiceCatalog.ts";
import { Invoice } from "../models/Invoice.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";

export interface CapturedChargeItem {
  serviceCatalogId?: string;
  description: string;
  amount: number;
  quantity: number;
  hsnSacCode: string;
  gstRate: number;
  category: string;
}

export async function compileEncounterCharges(encounterId: string): Promise<{
  encounter: any;
  items: CapturedChargeItem[];
  subtotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  totalAmount: number;
}> {
  const encounter = await Encounter.findById(encounterId);
  if (!encounter) {
    throw new Error("Encounter not found");
  }

  const { patientId, doctorId, clinicId } = encounter;
  const items: CapturedChargeItem[] = [];

  // 1. Doctor Consultation Fee
  const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
  const consultFee = assignment?.fees || 500;

  // Try to match with ServiceCatalog for SAC code & GST
  const opdCatalogItem = await ServiceCatalog.findOne({
    category: "consultation",
    isActive: true,
  });

  items.push({
    serviceCatalogId: opdCatalogItem ? opdCatalogItem._id.toString() : undefined,
    description: `Physician Consultation - Dr. ${encounter.doctorId}`,
    amount: consultFee,
    quantity: 1,
    hsnSacCode: opdCatalogItem?.hsnSacCode || "999312",
    gstRate: opdCatalogItem?.gstRate || 0,
    category: "consultation",
  });

  // 2. Lab Orders linked to Encounter
  const labOrders = await LabOrder.find({ encounterId }).populate("testId");
  for (const order of labOrders) {
    const test = order.testId as any;
    if (test) {
      items.push({
        description: `Lab Test: ${test.name || "Diagnostic Order"}`,
        amount: test.price || 0,
        quantity: 1,
        hsnSacCode: "999316",
        gstRate: 0, // Healthcare diagnostic tests usually GST exempt
        category: "lab_test",
      });
    }
  }

  // 3. Prescriptions linked to Encounter
  const prescriptions = await Prescription.find({ encounterId }).populate("medicineId");
  for (const rx of prescriptions) {
    const med = rx.medicineId as any;
    if (med) {
      items.push({
        description: `Pharmacy: ${med.name} (${rx.dosage})`,
        amount: med.price || 0,
        quantity: 1,
        hsnSacCode: med.hsnCode || "3004",
        gstRate: med.gstRate || 5, // Medicines typically 5% or 12% GST
        category: "pharmacy",
      });
    }
  }

  // 4. Inpatient Bed Stay Charges (if IPD admission exists)
  const admission = await Admission.findOne({ patientId, status: { $in: ["admitted", "discharged"] } }).populate("bedId");
  if (admission && admission.bedId) {
    const bed = admission.bedId as any;
    const admitDate = new Date(admission.admittedAt);
    const dischargeDate = admission.dischargedAt ? new Date(admission.dischargedAt) : new Date();
    const days = Math.max(1, Math.ceil((dischargeDate.getTime() - admitDate.getTime()) / (1000 * 3600 * 24)));

    items.push({
      description: `IPD Bed Stay (${bed.wardName || "Ward"} - Bed #${bed.bedNumber}) - ${days} Days`,
      amount: bed.pricePerDay || 1000,
      quantity: days,
      hsnSacCode: "999311",
      gstRate: 0,
      category: "bed_charge",
    });
  }

  // Compute GST & Totals
  let subtotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  for (const item of items) {
    const lineBase = item.amount * item.quantity;
    subtotal += lineBase;
    if (item.gstRate > 0) {
      const cgst = Number((lineBase * (item.gstRate / 200)).toFixed(2));
      const sgst = Number((lineBase * (item.gstRate / 200)).toFixed(2));
      cgstTotal += cgst;
      sgstTotal += sgst;
    }
  }

  const taxTotal = cgstTotal + sgstTotal + igstTotal;
  const totalAmount = Number((subtotal + taxTotal).toFixed(2));

  return {
    encounter,
    items,
    subtotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    totalAmount,
  };
}

export async function autoGenerateEncounterInvoice(encounterId: string, createdByUserId: string): Promise<any> {
  // Check if invoice already exists for this encounter
  const existing = await Invoice.findOne({ encounterId });
  if (existing) {
    return existing;
  }

  const compiled = await compileEncounterCharges(encounterId);
  const { encounter, items, subtotal, cgstTotal, sgstTotal, igstTotal, totalAmount } = compiled;

  const currentYear = new Date().getFullYear();
  const counterId = `invoice_${encounter.clinicId}_${currentYear}`;
  const seq = await getNextAtomicSequence(counterId);
  const invoiceNumber = `INV-${currentYear}-${seq.toString().padStart(6, "0")}`;

  const formattedItems = items.map((i) => {
    const lineBase = i.amount * i.quantity;
    const cgstAmount = i.gstRate > 0 ? Number((lineBase * (i.gstRate / 200)).toFixed(2)) : 0;
    const sgstAmount = i.gstRate > 0 ? Number((lineBase * (i.gstRate / 200)).toFixed(2)) : 0;
    return {
      serviceCatalogId: i.serviceCatalogId,
      description: i.description,
      amount: i.amount,
      quantity: i.quantity,
      hsnSacCode: i.hsnSacCode,
      gstRate: i.gstRate,
      cgstAmount,
      sgstAmount,
      igstAmount: 0,
      totalItemAmount: Number((lineBase + cgstAmount + sgstAmount).toFixed(2)),
    };
  });

  const invoice = await Invoice.create({
    invoiceNumber,
    organizationId: encounter.organizationId || null,
    patientId: encounter.patientId,
    clinicId: encounter.clinicId,
    doctorId: encounter.doctorId,
    encounterId: encounter._id,
    items: formattedItems,
    subtotal,
    taxableAmount: subtotal,
    tax: cgstTotal + sgstTotal + igstTotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    totalAmount,
    invoiceType: "B2C",
    status: "unpaid",
  });

  return invoice;
}
