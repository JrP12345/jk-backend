import "../db.ts";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";

export interface DataQualityReport {
  totalAppointments: number;
  validDatesCount: number;
  corruptDatesCount: number;
  corruptRecords: Array<{
    id: string;
    organizationId?: string;
    invalidField: string;
    rawValue: any;
  }>;
}

/**
 * Scans appointment records to detect any historical corrupt or unparseable date values.
 */
export async function runDateQualityAudit(): Promise<DataQualityReport> {
  console.log("=== STARTING DATE QUALITY AUDIT FOR APPOINTMENTS ===");

  const appointments = await Appointment.find({}).select("_id organizationId appointmentTime trackerTokenExpiresAt checkInTokenExpiresAt createdAt").lean();

  const report: DataQualityReport = {
    totalAppointments: appointments.length,
    validDatesCount: 0,
    corruptDatesCount: 0,
    corruptRecords: [],
  };

  for (const appt of appointments) {
    let hasCorruptField = false;

    // 1. Check appointmentTime
    const timeVal = appt.appointmentTime;
    if (!timeVal || isNaN(new Date(timeVal).getTime())) {
      hasCorruptField = true;
      report.corruptRecords.push({
        id: appt._id.toString(),
        organizationId: appt.organizationId?.toString(),
        invalidField: "appointmentTime",
        rawValue: timeVal,
      });
    }

    // 2. Check trackerTokenExpiresAt if present
    if (appt.trackerTokenExpiresAt && isNaN(new Date(appt.trackerTokenExpiresAt).getTime())) {
      hasCorruptField = true;
      report.corruptRecords.push({
        id: appt._id.toString(),
        organizationId: appt.organizationId?.toString(),
        invalidField: "trackerTokenExpiresAt",
        rawValue: appt.trackerTokenExpiresAt,
      });
    }

    if (hasCorruptField) {
      report.corruptDatesCount++;
    } else {
      report.validDatesCount++;
    }
  }

  console.log(`[DataQualityAudit] Total Appointments Scanned: ${report.totalAppointments}`);
  console.log(`[DataQualityAudit] Valid Date Records: ${report.validDatesCount}`);
  console.log(`[DataQualityAudit] Corrupt Date Records: ${report.corruptDatesCount}`);

  return report;
}

// Direct CLI invocation
if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/") || "")) {
  runDateQualityAudit()
    .then((rep) => {
      console.log("Audit completed successfully:", JSON.stringify({
        total: rep.totalAppointments,
        valid: rep.validDatesCount,
        corrupt: rep.corruptDatesCount,
        issuesFound: rep.corruptRecords.length
      }, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Audit failed:", err);
      process.exit(1);
    });
}
