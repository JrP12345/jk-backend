import { withTransaction } from "../utilities/transaction.ts";
import { visitInvoicePaymentStatus } from "./VisitInvoiceBalance.ts";
import { Encounter } from "../models/Encounter.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { compilePharmacySupplyCharges } from "./PharmacyChargeSource.ts";
import { ServiceCatalog } from "../models/ServiceCatalog.ts";
import { Invoice } from "../models/Invoice.ts";
import { User } from "../models/User.ts";
import { Appointment } from "../models/Appointment.ts";
import { generateLocationInvoiceNumber } from "../utilities/invoiceNumber.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";

export interface CapturedChargeItem {
  pharmacyDispenseId?: string;
  pharmacyDispenseLineId?: string;
  serviceCatalogId?: string;
  description: string;
  amount: number;
  quantity: number;
  hsnSacCode: string;
  gstRate: number;
  category: string;
}
interface PharmacyPreview {
  pharmacyInvoices: Array<{ invoiceId: string; dispenseId: string; totalAmount: number }>;
  unfilledPrescriptions: Array<{ prescriptionId: string; medicineName: string }>;
}

export async function compileEncounterCharges(
  encounterId: string,
  customConsultFee?: number
): Promise<PharmacyPreview & {
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

  const { patientId, doctorId, locationId, organizationId, appointmentId } = encounter;
  const items: CapturedChargeItem[] = [];

  const appointment = appointmentId ? await Appointment.findById(appointmentId) : null;

  // 1. Doctor Consultation Fee (skip if already invoiced at booking)
  let skipConsultFee = false;
  if (appointmentId) {
    const existingApptInvoice = await Invoice.findOne({
      appointmentId,
      status: { $in: ["unpaid", "partially_paid", "paid"] },
      "items.description": /^(?:Physician )?Consultation(?: Fee)?(?: \(| -|$)/i,
    });
    if (existingApptInvoice) {
      skipConsultFee = true;
    }
  }

  const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
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
    let opdCatalogItem = await ServiceCatalog.findOne({ ...catalogBase, locationId: encounter.locationId });
    if (!opdCatalogItem) {
      opdCatalogItem = await ServiceCatalog.findOne({
        ...catalogBase,
        $or: [{ locationId: { $exists: false } }, { locationId: null }],
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
    const labOrders = await LabOrder.find({ encounterId, organizationId, status: { $ne: "cancelled" }, deletedAt: null }).populate("testId");
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

  const targetInvoice = await Invoice.findOne({ organizationId, locationId, patientId, deletedAt: null, documentVersion: { $ne: 1 },
    $or: [{ encounterId }, ...(appointmentId ? [{ appointmentId }] : [])] }).sort({ createdAt: 1 });
  const pharmacy = await compilePharmacySupplyCharges(encounter, targetInvoice ? String(targetInvoice._id) : undefined);
  items.push(...pharmacy.items);

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
    pharmacyInvoices: pharmacy.pharmacyInvoices,
    unfilledPrescriptions: pharmacy.unfilledPrescriptions,
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
  return withTransaction(() => generateEncounterInvoice(encounterId, createdByUserId, customConsultFee));
}
async function generateEncounterInvoice(encounterId: string, createdByUserId?: string, customConsultFee?: number): Promise<any> {
  // Serialize generation with the encounter itself; database uniqueness remains the final boundary.
  await Encounter.findOneAndUpdate({ _id: encounterId }, { $inc: { __v: 1 } });
  // Check if invoice already exists for this encounter
  const existing = await Invoice.findOne({ encounterId, documentVersion: { $ne: 1 } });
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

  const invoiceNumber = await generateLocationInvoiceNumber(encounter.locationId.toString());

  const formattedItems = items.map((i) => {
    const lineBase = i.amount * i.quantity;
    const cgstAmount = i.gstRate > 0 ? Number((lineBase * (i.gstRate / 200)).toFixed(2)) : 0;
    const sgstAmount = i.gstRate > 0 ? Number((lineBase * (i.gstRate / 200)).toFixed(2)) : 0;
    return {
      serviceCatalogId: i.serviceCatalogId,
      pharmacyDispenseId: i.pharmacyDispenseId,
      pharmacyDispenseLineId: i.pharmacyDispenseLineId,
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
    generationKey: "encounter:" + encounterId,
    clinicalChargeVersion: 1,
    invoiceNumber,
    organizationId: encounter.organizationId || null,
    patientId: encounter.patientId,
    locationId: encounter.locationId,
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

  if (encounter.appointmentId) {
    const linked = await Appointment.findById(encounter.appointmentId);
    if (linked) {
      linked.paymentStatus = await visitInvoicePaymentStatus(linked);
      await linked.save();
    }
  }
  return invoice;
}

export async function compileAppointmentCharges(
  appointmentId: string,
  customConsultFee?: number,
  targetInvoiceId?: string,
): Promise<PharmacyPreview & {
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
    .populate("locationId", "name address phone gstin")
    .populate("invoiceId");

  if (!appointment) {
    throw new Error("Appointment not found");
  }

  const items: CapturedChargeItem[] = [];
  const existingInvoice = appointment.invoiceId as any;

  // 1. Doctor Consultation Fee
  const assignment = await DoctorAssignment.findOne({
    doctorId: appointment.doctorId,
    locationId: appointment.locationId,
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
    organizationId: appointment.organizationId, deletedAt: null, status: { $ne: "cancelled" },
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

  const targetInvoice = targetInvoiceId ? await Invoice.findById(targetInvoiceId) : (appointment.invoiceId ||
    (encounter ? await Invoice.findOne({ organizationId: appointment.organizationId, patientId: appointment.patientId,
      locationId: appointment.locationId, deletedAt: null, documentVersion: { $ne: 1 }, $or: [{ appointmentId }, { encounterId: encounter._id }] }).sort({ createdAt: 1 }) : null));
  const pharmacy = encounter ? await compilePharmacySupplyCharges(encounter, targetInvoice ? String(targetInvoice._id || targetInvoice) : undefined)
    : { items: [], pharmacyInvoices: [], unfilledPrescriptions: [] };
  items.push(...pharmacy.items);

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
    pharmacyInvoices: pharmacy.pharmacyInvoices,
    unfilledPrescriptions: pharmacy.unfilledPrescriptions,
    items,
    subtotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    totalAmount,
    existingInvoice: targetInvoice || existingInvoice,
    feeType,
    consultationFee: consultFee,
    isFeeEditable: feeType === "post_consultation" || (targetInvoice ? targetInvoice.status !== "paid"
      : (appointment as any)?.paymentStatus !== "paid" || pharmacy.pharmacyInvoices.length > 0),
  };
}
