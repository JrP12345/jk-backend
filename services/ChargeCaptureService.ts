import mongoose from "mongoose";
import { Encounter } from "../models/Encounter.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { Prescription } from "../models/Prescription.ts";
import { Medicine } from "../models/Medicine.ts";
import { ServiceCatalog } from "../models/ServiceCatalog.ts";
import { Invoice } from "../models/Invoice.ts";
import { User } from "../models/User.ts";
import { Appointment } from "../models/Appointment.ts";
import { generateClinicInvoiceNumber } from "../utilities/invoiceNumber.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";

export interface CapturedChargeItem {
  serviceCatalogId?: string;
  description: string;
  amount: number;
  quantity: number;
  hsnSacCode: string;
  gstRate: number;
  category: string;
}

export async function compileEncounterCharges(
  encounterId: string,
  customConsultFee?: number
): Promise<{
  encounter: any;
  items: CapturedChargeItem[];
  subtotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  totalAmount: number;
  feeType: string;
  consultationFee: number;
  isFeeEditable: boolean;
}> {
  const encounter = await Encounter.findById(encounterId);
  if (!encounter) {
    throw new Error("Encounter not found");
  }

  const { patientId, doctorId, clinicId, organizationId, appointmentId } = encounter;
  const items: CapturedChargeItem[] = [];

  const appointment = appointmentId ? await Appointment.findById(appointmentId) : null;

  // 1. Doctor Consultation Fee (skip if already invoiced at booking)
  let skipConsultFee = false;
  if (appointmentId) {
    const existingApptInvoice = await Invoice.findOne({ appointmentId });
    if (existingApptInvoice && existingApptInvoice.status === "paid") {
      skipConsultFee = true;
    }
  }

  const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
  const feeType = (appointment as any)?.feeType || (assignment as any)?.feeType || "fixed";

  let consultFee = 0;
  if (customConsultFee !== undefined && customConsultFee !== null) {
    consultFee = Number(customConsultFee);
  } else if ((appointment as any)?.customConsultationFee !== undefined && (appointment as any)?.customConsultationFee !== null) {
    consultFee = Number((appointment as any).customConsultationFee);
  } else if (feeType === "post_consultation") {
    consultFee = (assignment as any)?.fees || 0;
  } else if (feeType === "free") {
    consultFee = 0;
  } else {
    consultFee = (assignment as any)?.fees ?? (appointment as any)?.paymentAmount ?? 500;
  }

  const doctorUser = await User.findById(doctorId).select("name").lean();
  const docName = doctorUser?.name ? doctorUser.name.replace(/^dr\.?\s+/i, "") : String(encounter.doctorId);

  if (!skipConsultFee) {
    const catalogBase = {
      organizationId: encounter.organizationId,
      category: "consultation" as const,
      isActive: true,
    };
    let opdCatalogItem = await ServiceCatalog.findOne({ ...catalogBase, clinicId: encounter.clinicId });
    if (!opdCatalogItem) {
      opdCatalogItem = await ServiceCatalog.findOne({
        ...catalogBase,
        $or: [{ clinicId: { $exists: false } }, { clinicId: null }],
      });
    }

    items.push({
      serviceCatalogId: opdCatalogItem ? opdCatalogItem._id.toString() : undefined,
      description: feeType === "free"
        ? `Physician Consultation (Pro Bono) - Dr. ${docName}`
        : `Physician Consultation - Dr. ${docName}`,
      amount: consultFee,
      quantity: 1,
      hsnSacCode: opdCatalogItem?.hsnSacCode || "999312",
      gstRate: opdCatalogItem?.gstRate || 0,
      category: "consultation",
    });
  }

  const orgId = organizationId?.toString();
  const labEnabled = orgId ? await isModuleEnabledForOrganization(orgId, "laboratory") : false;

  // 2. Lab Orders linked to Encounter (only when laboratory module is enabled)
  if (labEnabled) {
    const labOrders = await LabOrder.find({ encounterId }).populate("testId");
    for (const order of labOrders) {
      const test = order.testId as any;
      if (test) {
        items.push({
          description: `Lab Test: ${test.name || "Diagnostic Order"}`,
          amount: test.price || 0,
          quantity: 1,
          hsnSacCode: "999316",
          gstRate: 0,
          category: "lab_test",
        });
      }
    }
  }

  // 3. Prescriptions linked to Encounter (P1 pharmacy — always compiled when present)
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
    feeType,
    consultationFee: consultFee,
    isFeeEditable: feeType === "post_consultation" || !skipConsultFee,
  };
}

export async function autoGenerateEncounterInvoice(
  encounterId: string,
  createdByUserId?: string,
  customConsultFee?: number
): Promise<any> {
  // Check if invoice already exists for this encounter
  const existing = await Invoice.findOne({ encounterId });
  if (existing) {
    return existing;
  }

  const encounter = await Encounter.findById(encounterId);
  if (!encounter) throw new Error("Encounter not found");

  if (customConsultFee !== undefined && customConsultFee !== null && encounter.appointmentId) {
    await Appointment.findByIdAndUpdate(encounter.appointmentId, {
      customConsultationFee: Number(customConsultFee),
      paymentAmount: Number(customConsultFee),
    });
  }

  const compiled = await compileEncounterCharges(encounterId, customConsultFee);
  const { items, subtotal, cgstTotal, sgstTotal, igstTotal, totalAmount } = compiled;

  if (items.length === 0) {
    if (encounter.appointmentId) {
      const apptInvoice = await Invoice.findOne({ appointmentId: encounter.appointmentId });
      if (apptInvoice) return apptInvoice;
    }
    return null;
  }

  const invoiceNumber = await generateClinicInvoiceNumber(encounter.clinicId.toString());

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

export async function compileAppointmentCharges(
  appointmentId: string,
  customConsultFee?: number
): Promise<{
  appointment: any;
  items: CapturedChargeItem[];
  subtotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  totalAmount: number;
  existingInvoice: any;
  feeType: string;
  consultationFee: number;
  isFeeEditable: boolean;
}> {
  const { Appointment } = await import("../models/Appointment.ts");

  const appointment = await Appointment.findById(appointmentId)
    .populate({ path: "patientId", populate: { path: "userId", select: "name phone email" } })
    .populate("doctorId", "name specialization")
    .populate("clinicId", "name address phone gstin")
    .populate("invoiceId");

  if (!appointment) {
    throw new Error("Appointment not found");
  }

  const items: CapturedChargeItem[] = [];
  const existingInvoice = appointment.invoiceId as any;

  // 1. Doctor Consultation Fee
  const assignment = await DoctorAssignment.findOne({
    doctorId: appointment.doctorId,
    clinicId: appointment.clinicId,
    isActive: true,
  });
  const feeType = (appointment as any)?.feeType || (assignment as any)?.feeType || "fixed";
  let consultFee = 0;
  if (customConsultFee !== undefined && customConsultFee !== null) {
    consultFee = Number(customConsultFee);
  } else if ((appointment as any)?.customConsultationFee !== undefined && (appointment as any)?.customConsultationFee !== null) {
    consultFee = Number((appointment as any).customConsultationFee);
  } else if (feeType === "post_consultation") {
    consultFee = (assignment as any)?.fees || 0;
  } else if (feeType === "free") {
    consultFee = 0;
  } else {
    consultFee = (assignment as any)?.fees ?? (appointment as any)?.paymentAmount ?? 500;
  }

  const rawDocName = (appointment.doctorId as any)?.name || "Consultant";
  const docName = String(rawDocName).replace(/^dr\.?\s+/i, "");

  items.push({
    description: feeType === "free"
      ? `Physician Consultation (Pro Bono) - Dr. ${docName}`
      : `Physician Consultation - Dr. ${docName}`,
    amount: consultFee,
    quantity: 1,
    hsnSacCode: "999312",
    gstRate: 0,
    category: "consultation",
  });

  // 2. Lab Orders
  const encounter = await Encounter.findOne({ appointmentId: appointment._id });
  const labQuery: any = {
    $or: [
      { appointmentId: appointment._id },
      ...(encounter ? [{ encounterId: encounter._id }] : []),
    ],
  };

  const labOrders = await LabOrder.find(labQuery).populate("testId");
  for (const order of labOrders) {
    const test = order.testId as any;
    if (test) {
      items.push({
        description: `Lab Test: ${test.name || "Diagnostic Test"}`,
        amount: test.price || 0,
        quantity: 1,
        hsnSacCode: "999316",
        gstRate: 0,
        category: "lab_test",
      });
    }
  }

  // 3. Pharmacy Prescriptions
  const addedRxNames = new Set<string>();

  if (encounter) {
    const prescriptions = await Prescription.find({ encounterId: encounter._id }).populate("medicineId");
    for (const rx of prescriptions) {
      const med = rx.medicineId as any;
      const name = med?.name || rx.medicineName;
      addedRxNames.add(name.toLowerCase());
      items.push({
        description: `Pharmacy: ${name} (${rx.dosage})`,
        amount: med?.price || 60,
        quantity: 1,
        hsnSacCode: med?.hsnCode || "3004",
        gstRate: med?.gstRate || 5,
        category: "pharmacy",
      });
    }
  }

  // Also include prescriptions stored directly on Appointment document
  if (Array.isArray(appointment.prescriptions)) {
    for (const p of appointment.prescriptions) {
      if (p.name && !addedRxNames.has(p.name.toLowerCase())) {
        addedRxNames.add(p.name.toLowerCase());
        items.push({
          description: `Pharmacy: ${p.name} (${p.dosage})`,
          amount: 60,
          quantity: 1,
          hsnSacCode: "3004",
          gstRate: 5,
          category: "pharmacy",
        });
      }
    }
  }

  // Calculate GST & Totals
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
    appointment,
    items,
    subtotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    totalAmount,
    existingInvoice,
    feeType,
    consultationFee: consultFee,
    isFeeEditable: feeType === "post_consultation" || (appointment as any)?.paymentStatus !== "paid",
  };
}
