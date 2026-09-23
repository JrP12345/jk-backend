import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Clinic } from "../models/Clinic.ts";
import mongoose from "mongoose";

export async function generateCsvReport(
  reportType: "billing" | "clinical" | "pharmacy",
  organizationId?: string,
  clinicId?: string
): Promise<string> {
  const filter: any = {};

  if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
    filter.organizationId = new mongoose.Types.ObjectId(organizationId);
  }

  if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
    filter.clinicId = new mongoose.Types.ObjectId(clinicId);
  }

  if (reportType === "billing") {
    const invoices = await Invoice.find(filter)
      .populate("patientId", "name")
      .sort({ createdAt: -1 })
      .limit(500);

    const headers = "InvoiceNumber,PatientName,TotalAmount,AmountPaid,BalanceDue,Status,CreatedAt\n";
    const rows = invoices.map((inv: any) => {
      const pName = (inv.patientId as any)?.name || "Patient";
      return `${inv.invoiceNumber || inv._id},"${pName}",${inv.totalAmount || 0},${inv.amountPaid || 0},${inv.balanceDue || 0},${inv.status},${inv.createdAt.toISOString()}`;
    }).join("\n");

    return headers + rows;
  }

  if (reportType === "clinical") {
    const encounters = await Encounter.find(filter)
      .populate("patientId", "name")
      .populate("doctorId", "name")
      .sort({ createdAt: -1 })
      .limit(500);

    const headers = "EncounterID,PatientName,DoctorName,Status,ChiefComplaint,CreatedAt\n";
    const rows = encounters.map((enc: any) => {
      const pName = (enc.patientId as any)?.name || "Patient";
      const dName = (enc.doctorId as any)?.name || "Doctor";
      const complaint = (enc.chiefComplaint || "").replace(/"/g, '""');
      return `${enc._id},"${pName}","${dName}",${enc.status},"${complaint}",${enc.createdAt.toISOString()}`;
    }).join("\n");

    return headers + rows;
  }

  // Pharmacy Stock Report
  const pharmacyFilter: any = {};
  if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
    pharmacyFilter.clinicId = new mongoose.Types.ObjectId(clinicId);
  } else if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
    // Resolve all clinics for this organization to maintain tenant isolation
    const orgClinics = await Clinic.find({ organizationId, isActive: { $ne: false } }).select("_id").lean();
    const clinicIds = orgClinics.map((c) => c._id);
    pharmacyFilter.clinicId = { $in: clinicIds };
  }

  const batches = await MedicineBatch.find(pharmacyFilter)
    .populate("medicineId", "name code")
    .sort({ expiryDate: 1 })
    .limit(500);

  const headers = "BatchNumber,MedicineName,QuantityRemaining,PricePerUnit,ExpiryDate,Status\n";
  const rows = batches.map((b: any) => {
    const medName = (b.medicineId as any)?.name || "Medicine";
    const expiry = b.expiryDate ? b.expiryDate.toISOString().split("T")[0] : "N/A";
    const qty = b.quantity ?? (b as any).quantityRemaining ?? 0;
    const price = b.sellingPrice ?? b.pricePerUnit ?? 0;
    return `${b.batchNumber},"${medName}",${qty},${price},${expiry},${b.status}`;
  }).join("\n");

  return headers + rows;
}
