import type { FastifyRequest, FastifyReply } from "fastify";
import { Clinic } from "../models/Clinic.ts";
import { Invoice } from "../models/Invoice.ts";
import { Bed } from "../models/Bed.ts";
import { Medicine } from "../models/Medicine.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { Encounter } from "../models/Encounter.ts";
import { Admission } from "../models/Admission.ts";
import { Claim } from "../models/Claim.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function getExecutiveAnalytics(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId = req.user!.organization_id;

    // 1. Fetch clinics under organization (or all clinics for Root Admin)
    let clinics = orgId ? await Clinic.find({ organizationId: orgId, isActive: true }) : [];
    if (clinics.length === 0 && req.user?.role === "root") {
      clinics = await Clinic.find({ isActive: true });
    }
    const clinicIds = clinics.map((c) => c._id);

    if (clinicIds.length === 0) {
      return reply.code(200).send(
        successResponse({
          overall: { totalRevenue: 0, outstandingBilling: 0, bedOccupancyRate: 0, lowStockWarnings: 0 },
          clinicsPerformance: [],
          doctorSpecializations: [],
          referralStats: { totalReferrals: 0, completedReferrals: 0, completionRate: 0 },
        })
      );
    }

    // 2. Fetch invoices for revenue calculations
    const invoices = await Invoice.find({ clinicId: { $in: clinicIds } });

    let totalRevenue = 0;
    let outstandingBilling = 0;

    invoices.forEach((inv) => {
      if (inv.status === "paid") {
        totalRevenue += inv.totalAmount;
      } else if (inv.status === "unpaid") {
        outstandingBilling += inv.totalAmount;
      }
    });

    // 3. Fetch beds for occupancy calculations
    const beds = await Bed.find({ clinicId: { $in: clinicIds } });
    const totalBeds = beds.length;
    const occupiedBeds = beds.filter((b) => b.status === "occupied").length;
    const bedOccupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

    // 4. Fetch medicines for low stock warnings
    const lowStockMedicines = await Medicine.countDocuments({
      clinicId: { $in: clinicIds },
      stockQuantity: { $lt: 10 },
    });

    // 5. Calculate per-clinic performance
    const appointments = await Appointment.find({ clinicId: { $in: clinicIds } });

    const clinicsPerformance = clinics.map((clinic) => {
      const clinicInvoices = invoices.filter((inv) => inv.clinicId.toString() === clinic.id);
      const clinicAppts = appointments.filter((app) => app.clinicId.toString() === clinic.id);

      const clinicRevenue = clinicInvoices
        .filter((inv) => inv.status === "paid")
        .reduce((sum, inv) => sum + inv.totalAmount, 0);

      const clinicOutstanding = clinicInvoices
        .filter((inv) => inv.status === "unpaid")
        .reduce((sum, inv) => sum + inv.totalAmount, 0);

      return {
        id: clinic.id,
        name: clinic.name,
        city: clinic.city,
        appointmentCount: clinicAppts.length,
        revenue: clinicRevenue,
        outstanding: clinicOutstanding,
      };
    });

    // 6. Referral performance stats
    const referrals = appointments.filter((app) => app.followUpForAppointmentId !== null && app.followUpForAppointmentId !== undefined);
    const totalReferrals = referrals.length;
    const completedReferrals = referrals.filter((app) => app.status === "completed").length;
    const referralCompletionRate = totalReferrals > 0 ? Math.round((completedReferrals / totalReferrals) * 100) : 0;

    // 7. Doctor specializations count
    const doctorsList = await Doctor.find(orgId ? { organizationId: orgId } : {});
    const specCounts: Record<string, number> = {};
    doctorsList.forEach((doc: any) => {
      const spec = doc.specialization || "General Medicine";
      specCounts[spec] = (specCounts[spec] || 0) + 1;
    });

    const doctorSpecializations = Object.entries(specCounts).map(([name, count]) => ({
      name,
      count,
    }));

    return reply.code(200).send(
      successResponse({
        overall: {
          totalRevenue,
          outstandingBilling,
          bedOccupancyRate,
          lowStockWarnings: lowStockMedicines,
        },
        clinicsPerformance,
        doctorSpecializations,
        referralStats: {
          totalReferrals,
          completedReferrals,
          completionRate: referralCompletionRate,
        },
      })
    );
  } catch (err) {
    console.error("getExecutiveAnalytics error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/analytics/clinical-summary ──────────────────────────────
export async function getClinicalSummaryAnalyticsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const filter: any = {};
    if (orgId && req.user?.role !== "root") filter.organizationId = orgId;

    const totalEncounters = await Encounter.countDocuments(filter);
    const activeAdmissions = await Admission.countDocuments({ ...filter, status: "admitted" });
    const totalClaims = await Claim.countDocuments(filter);
    const approvedClaims = await Claim.countDocuments({ ...filter, status: "approved" });
    const claimApprovalRate = totalClaims > 0 ? Math.round((approvedClaims / totalClaims) * 100) : 100;

    return reply.code(200).send(
      successResponse({
        totalEncounters,
        activeAdmissions,
        totalClaims,
        approvedClaims,
        claimApprovalRate,
      })
    );
  } catch (err) {
    console.error("getClinicalSummaryAnalyticsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/analytics/export ─────────────────────────────────────────
export async function exportAnalyticsReportController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { format, reportType } = req.query as { format?: "json" | "csv"; reportType?: "executive" | "clinical" | "financial" };
    const orgId = req.user?.organization_id;
    const type = reportType || "executive";
    const exportFormat = format || "json";

    const filter: any = {};
    if (orgId && req.user?.role !== "root") filter.organizationId = orgId;

    let exportData: any = {};

    if (type === "executive") {
      const clinicsCount = await Clinic.countDocuments(orgId ? { organizationId: orgId } : {});
      const invoices = await Invoice.find(orgId ? { clinicId: { $in: (await Clinic.find({ organizationId: orgId })).map((c) => c._id) } } : {});
      const paidRev = invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.totalAmount, 0);

      exportData = {
        reportType: "executive",
        generatedAt: new Date().toISOString(),
        totalClinics: clinicsCount,
        paidRevenue: paidRev,
        totalInvoices: invoices.length,
      };
    } else {
      const encountersCount = await Encounter.countDocuments(filter);
      const claimsCount = await Claim.countDocuments(filter);

      exportData = {
        reportType: type,
        generatedAt: new Date().toISOString(),
        totalEncounters: encountersCount,
        totalClaims: claimsCount,
      };
    }

    if (exportFormat === "csv") {
      const csvLines = [
        "Metric,Value",
        ...Object.entries(exportData).map(([k, v]) => `"${k}","${v}"`),
      ];
      reply.header("Content-Type", "text/csv");
      reply.header("Content-Disposition", `attachment; filename="ananta_${type}_report.csv"`);
      return reply.code(200).send(csvLines.join("\n"));
    }

    return reply.code(200).send(successResponse(exportData, "Analytics report exported successfully"));
  } catch (err) {
    console.error("exportAnalyticsReportController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
