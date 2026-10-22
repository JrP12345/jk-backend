import mongoose from "mongoose";
import { expect, it } from "vitest";
import { generateCsvReport, escapeCsv } from "../services/ReportExportService.ts";

it("quotes standalone carriage returns and neutralizes leading spreadsheet formulas", () => {
  expect(escapeCsv("source\rline")).toBe('"source\rline"'); expect(escapeCsv(" \t=1+1")).toBe("' \t=1+1");
  expect(escapeCsv("\u0000=1+1")).toBe("'\u0000=1+1"); expect(escapeCsv("\u200B@SUM(1)")).toBe("'\u200B@SUM(1)");
});

it("exports one current clinical representation with encounter type and start time", async () => {
  const csv = await generateCsvReport("clinical", new mongoose.Types.ObjectId().toString());
  expect(csv).toBe("EncounterID,PatientName,DoctorName,EncounterType,Status,ChiefComplaint,StartedAt,CreatedAt\n");
});

it("exports one current pharmacy representation with medicine code, selling price and MRP", async () => {
  const csv = await generateCsvReport("pharmacy", new mongoose.Types.ObjectId().toString());
  expect(csv).toBe("BatchNumber,MedicineName,MedicineCode,QuantityRemaining,SellingPrice,MRP,ExpiryDate,Status\n");
});
