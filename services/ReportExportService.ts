import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Clinic } from "../models/Clinic.ts";
import mongoose from "mongoose";
import { MAX_REPORT_ROWS } from "../utilities/scalability.ts";

// ─── TYPED REPORT-ROW DTOS (Finding: Step 3.2) ────────────────────────

export interface BillingReportRowDTO {
  invoiceNumber: string;
  patientName: string;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: string;
  createdAt: string;
}

export interface ClinicalReportRowDTO {
  encounterId: string;
  patientName: string;
  doctorName: string;
  encounterType: string;
  status: string;
  chiefComplaint: string;
  startedAt: string;
  createdAt: string;
}

export interface PharmacyReportRowDTO {
  batchNumber: string;
  medicineName: string;
  medicineCode: string;
  quantityRemaining: number;
  sellingPrice: number;
  mrp: number;
  expiryDate: string;
  status: string;
}

export function escapeCsv(val: any): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates CSV report with strictly typed model-field mappings and versioned column headers.
 */
export async function generateCsvReport(
  reportType: "billing" | "clinical" | "pharmacy",
  organizationId?: string,
  clinicId?: string,
  version: "v1" | "v2" = "v1",
  startDate?: string,
  endDate?: string,
  maxRows: number = MAX_REPORT_ROWS,
): Promise<string> {
  const filter: any = {};

  if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
    filter.organizationId = new mongoose.Types.ObjectId(organizationId);
  }

  if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
    filter.clinicId = new mongoose.Types.ObjectId(clinicId);
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const boundedLimit = Math.min(Math.max(1, maxRows), MAX_REPORT_ROWS);

  // 1. BILLING REPORT
  if (reportType === "billing") {
    const invoices = await Invoice.find(filter)
      .populate("patientId", "name")
      .sort({ createdAt: -1 })
      .limit(boundedLimit)
      .lean();

    const dtos: BillingReportRowDTO[] = invoices.map((inv: any) => ({
      invoiceNumber: inv.invoiceNumber || inv._id.toString(),
      patientName: (inv.patientId as any)?.name || "Patient",
      totalAmount: inv.totalAmount || 0,
      amountPaid: inv.amountPaid || 0,
      balanceDue: inv.balanceDue || 0,
      status: inv.status || "unpaid",
      createdAt: inv.createdAt ? new Date(inv.createdAt).toISOString() : new Date().toISOString()
    }));

    const headers = "InvoiceNumber,PatientName,TotalAmount,AmountPaid,BalanceDue,Status,CreatedAt\n";
    const rows = dtos.map(d =>
      [
        escapeCsv(d.invoiceNumber),
        escapeCsv(d.patientName),
        d.totalAmount,
        d.amountPaid,
        d.balanceDue,
        escapeCsv(d.status),
        escapeCsv(d.createdAt)
      ].join(",")
    ).join("\n");

    return headers + rows;
  }

  // 2. CLINICAL REPORT
  if (reportType === "clinical") {
    const encounters = await Encounter.find(filter)
      .populate("patientId", "name")
      .populate("doctorId", "name")
      .sort({ createdAt: -1 })
      .limit(boundedLimit)
      .lean();

    const encounterIds = encounters.map(e => e._id);
    const clinicalNotes = await ClinicalNote.find({
      encounterId: { $in: encounterIds },
      isLatest: true
    }).select("encounterId subjective.chiefComplaint").lean();

    const complaintByEncounter = new Map<string, string>();
    clinicalNotes.forEach((n: any) => {
      if (n.encounterId && n.subjective?.chiefComplaint) {
        complaintByEncounter.set(n.encounterId.toString(), n.subjective.chiefComplaint);
      }
    });

    const dtos: ClinicalReportRowDTO[] = encounters.map((enc: any) => {
      const pName = (enc.patientId as any)?.name || "Patient";
      const dName = (enc.doctorId as any)?.name || "Doctor";
      const chiefComplaint = complaintByEncounter.get(enc._id.toString()) || "Routine Follow-up";
      return {
        encounterId: enc._id.toString(),
        patientName: pName,
        doctorName: dName,
        encounterType: enc.encounterType || "opd",
        status: enc.status || "completed",
        chiefComplaint,
        startedAt: enc.startedAt ? new Date(enc.startedAt).toISOString() : "",
        createdAt: enc.createdAt ? new Date(enc.createdAt).toISOString() : new Date().toISOString()
      };
    });

    if (version === "v2") {
      const headers = "EncounterID,PatientName,DoctorName,EncounterType,Status,ChiefComplaint,StartedAt,CreatedAt\n";
      const rows = dtos.map(d =>
        [
          escapeCsv(d.encounterId),
          escapeCsv(d.patientName),
          escapeCsv(d.doctorName),
          escapeCsv(d.encounterType),
          escapeCsv(d.status),
          escapeCsv(d.chiefComplaint),
          escapeCsv(d.startedAt),
          escapeCsv(d.createdAt)
        ].join(",")
      ).join("\n");
      return headers + rows;
    }

    // Version 1 compatibility
    const headers = "EncounterID,PatientName,DoctorName,Status,ChiefComplaint,CreatedAt\n";
    const rows = dtos.map(d =>
      [
        escapeCsv(d.encounterId),
        escapeCsv(d.patientName),
        escapeCsv(d.doctorName),
        escapeCsv(d.status),
        escapeCsv(d.chiefComplaint),
        escapeCsv(d.createdAt)
      ].join(",")
    ).join("\n");
    return headers + rows;
  }

  // 3. PHARMACY STOCK REPORT
  const pharmacyFilter: any = {};
  if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
    pharmacyFilter.clinicId = new mongoose.Types.ObjectId(clinicId);
  } else if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
    const orgClinics = await Clinic.find({ organizationId, isActive: { $ne: false } }).select("_id").lean();
    const clinicIds = orgClinics.map((c) => c._id);
    pharmacyFilter.clinicId = { $in: clinicIds };
  }

  const batches = await MedicineBatch.find(pharmacyFilter)
    .populate("medicineId", "name code")
    .sort({ expiryDate: 1 })
    .limit(boundedLimit)
    .lean();

  const dtos: PharmacyReportRowDTO[] = batches.map((b: any) => ({
    batchNumber: b.batchNumber,
    medicineName: (b.medicineId as any)?.name || "Medicine",
    medicineCode: (b.medicineId as any)?.code || "",
    quantityRemaining: Number(b.quantity ?? 0),
    sellingPrice: Number(b.sellingPrice ?? 0),
    mrp: Number(b.mrp ?? b.sellingPrice ?? 0),
    expiryDate: b.expiryDate ? new Date(b.expiryDate).toISOString().split("T")[0] : "N/A",
    status: b.status || "active"
  }));

  if (version === "v2") {
    const headers = "BatchNumber,MedicineName,MedicineCode,QuantityRemaining,SellingPrice,MRP,ExpiryDate,Status\n";
    const rows = dtos.map(d =>
      [
        escapeCsv(d.batchNumber),
        escapeCsv(d.medicineName),
        escapeCsv(d.medicineCode),
        d.quantityRemaining,
        d.sellingPrice,
        d.mrp,
        escapeCsv(d.expiryDate),
        escapeCsv(d.status)
      ].join(",")
    ).join("\n");
    return headers + rows;
  }

  // Version 1 compatibility (PricePerUnit mapped to real sellingPrice, QuantityRemaining mapped to real quantity)
  const headers = "BatchNumber,MedicineName,QuantityRemaining,PricePerUnit,ExpiryDate,Status\n";
  const rows = dtos.map(d =>
    [
      escapeCsv(d.batchNumber),
      escapeCsv(d.medicineName),
      d.quantityRemaining,
      d.sellingPrice,
      escapeCsv(d.expiryDate),
      escapeCsv(d.status)
    ].join(",")
  ).join("\n");

  return headers + rows;
}
