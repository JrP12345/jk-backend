import mongoose from "mongoose";
import { expect, it } from "vitest";
import { generateCsvReport } from "../services/ReportExportService.ts";

it("exports one current clinical representation with encounter type and start time", async () => {
  const csv = await generateCsvReport("clinical", new mongoose.Types.ObjectId().toString());
  expect(csv).toBe("EncounterID,PatientName,DoctorName,EncounterType,Status,ChiefComplaint,StartedAt,CreatedAt\n");
});

it("exports one current pharmacy representation with medicine code, selling price and MRP", async () => {
  const csv = await generateCsvReport("pharmacy", new mongoose.Types.ObjectId().toString());
  expect(csv).toBe("BatchNumber,MedicineName,MedicineCode,QuantityRemaining,SellingPrice,MRP,ExpiryDate,Status\n");
});
