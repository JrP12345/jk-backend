import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
import { Organization } from "../models/Organization.ts";
import { Invoice } from "../models/Invoice.ts";
import { Bed } from "../models/Bed.ts";
import { Medicine } from "../models/Medicine.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { Encounter } from "../models/Encounter.ts";
import { Claim } from "../models/Claim.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

/**
 * Executive Analytics Dashboard Endpoint
 * Powered by high-performance MongoDB Aggregation Pipelines ($match, $group, $facet).
 */
export async function getExecutiveAnalytics(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId = req.user!.organization_id;
    const { startDate, endDate, clinicId } = req.query as { startDate?: string; endDate?: string; clinicId?: string };

    // 1. Resolve Clinics under organization scope
    let clinics = orgId ? await Clinic.find({ organizationId: orgId, isActive: true }) : [];
    if (clinics.length === 0 && req.user?.role === "root") {
      const activeOrgs = await Organization.find().select("_id").lean();
      const activeOrgIds = activeOrgs.map((o: any) => o._id);
      clinics = await Clinic.find({ organizationId: { $in: activeOrgIds }, isActive: true });
    }
    const clinicIds = clinics.map((c) => c._id);

    if (clinicIds.length === 0) {
      return reply.code(200).send(
        successResponse({
          overall: { totalRevenue: 0, outstandingBilling: 0, bedOccupancyRate: 0, lowStockWarnings: 0 },
          clinicsPerformance: [],
          doctorSpecializations: [],
          appointmentStats: { total: 0, completed: 0, pending: 0, cancelled: 0, noShow: 0, completionRate: 0 },
          referralStats: { totalReferrals: 0, completedReferrals: 0, completionRate: 0 },
        })
      );
    }

    // Filter match object for date range
    const invoiceMatch: any = { clinicId: { $in: clinicIds } };
    const apptMatch: any = { clinicId: { $in: clinicIds } };

    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      const targetObjId = new mongoose.Types.ObjectId(clinicId);
      invoiceMatch.clinicId = targetObjId;
      apptMatch.clinicId = targetObjId;
    }

    if (startDate || endDate) {
      invoiceMatch.createdAt = {};
      apptMatch.appointmentTime = {};
      if (startDate) {
        const s = new Date(startDate);
        invoiceMatch.createdAt.$gte = s;
        apptMatch.appointmentTime.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        invoiceMatch.createdAt.$lte = e;
        apptMatch.appointmentTime.$lte = e;
      }
    }

    // 2. High-Performance MongoDB Aggregation for Invoices Revenue ($facet)
    const invoiceAgg = await Invoice.aggregate([
      { $match: invoiceMatch },
      {
        $facet: {
          overallRevenue: [
            {
              $group: {
                _id: "$status",
                total: { $sum: "$totalAmount" },
                count: { $sum: 1 },
              },
            },
          ],
          clinicBreakdown: [
            {
              $group: {
                _id: { clinicId: "$clinicId", status: "$status" },
                totalAmount: { $sum: "$totalAmount" },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const revenueStatusList = invoiceAgg[0]?.overallRevenue || [];
    const paidEntry = revenueStatusList.find((r: any) => r._id === "paid");
    const unpaidEntry = revenueStatusList.find((r: any) => r._id === "unpaid");

    const totalRevenue = paidEntry ? paidEntry.total : 0;
    const outstandingBilling = unpaidEntry ? unpaidEntry.total : 0;

    // 3. Bed Occupancy Aggregation ($group)
    const bedAgg = await Bed.aggregate([
      { $match: { clinicId: { $in: clinicIds } } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const totalBeds = bedAgg.reduce((acc, curr) => acc + curr.count, 0);
    const occupiedBeds = bedAgg.find((b) => b._id === "occupied")?.count || 0;
    const bedOccupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

    // 4. Low Stock Medicines Aggregation
    const lowStockMedicines = await Medicine.countDocuments({
      clinicId: { $in: clinicIds },
      stockQuantity: { $lt: 10 },
    });

    // 5. Appointment Analytics Aggregation ($facet)
    const apptAgg = await Appointment.aggregate([
      { $match: apptMatch },
      {
        $facet: {
          statusCounts: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
          clinicApptCounts: [
            {
              $group: {
                _id: "$clinicId",
                count: { $sum: 1 },
              },
            },
          ],
          referralCounts: [
            {
              $match: { followUpForAppointmentId: { $exists: true, $ne: null } },
            },
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const statusCounts = apptAgg[0]?.statusCounts || [];
    const clinicApptCounts = apptAgg[0]?.clinicApptCounts || [];
    const referralCounts = apptAgg[0]?.referralCounts || [];

    const getStatusCount = (s: string) => statusCounts.find((c: any) => c._id === s)?.count || 0;
    const totalAppts = statusCounts.reduce((acc: number, curr: any) => acc + curr.count, 0);
    const completedAppts = getStatusCount("completed");
    const apptCompletionRate = totalAppts > 0 ? Math.round((completedAppts / totalAppts) * 100) : 0;

    const totalReferrals = referralCounts.reduce((acc: number, curr: any) => acc + curr.count, 0);
    const completedReferrals = referralCounts.find((r: any) => r._id === "completed")?.count || 0;
    const referralCompletionRate = totalReferrals > 0 ? Math.round((completedReferrals / totalReferrals) * 100) : 0;

    // Build Clinics Performance Breakdown map
    const clinicBreakdownList = invoiceAgg[0]?.clinicBreakdown || [];

    const clinicsPerformance = clinics.map((c) => {
      const cIdStr = c.id;

      const cPaid = clinicBreakdownList.find((cb: any) => cb._id.clinicId?.toString() === cIdStr && cb._id.status === "paid");
      const cUnpaid = clinicBreakdownList.find((cb: any) => cb._id.clinicId?.toString() === cIdStr && cb._id.status === "unpaid");
      const cAppt = clinicApptCounts.find((ca: any) => ca._id?.toString() === cIdStr);

      return {
        id: c.id,
        name: c.name,
        city: c.city,
        appointmentCount: cAppt ? cAppt.count : 0,
        revenue: cPaid ? cPaid.totalAmount : 0,
        outstanding: cUnpaid ? cUnpaid.totalAmount : 0,
      };
    });

    // 6. Doctor Specialization Counts
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
        appointmentStats: {
          total: totalAppts,
          completed: completedAppts,
          pending: getStatusCount("pending"),
          confirmed: getStatusCount("confirmed"),
          checkedIn: getStatusCount("checked-in"),
          cancelled: getStatusCount("cancelled"),
          noShow: getStatusCount("no-show"),
          completionRate: apptCompletionRate,
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

/**
 * NABH Quality Accreditation Indicators & Key Performance Indicators (KPIs)
 * Computes ALOS, BOR, 30-Day Readmission Rate, MAR Compliance Rate, and Patient Satisfaction Index.
 */
export async function getNabhKpis(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const { Admission } = await import("../models/Admission.ts");
    const { MedicationAdministration } = await import("../models/MedicationAdministration.ts");

    let clinics = orgId ? await Clinic.find({ organizationId: orgId, isActive: true }) : [];
    if (clinics.length === 0 && req.user?.role === "root") {
      const rootOrgs = await Organization.find().select("_id").lean();
      const rootOrgIds = rootOrgs.map((o: any) => o._id);
      clinics = await Clinic.find({ organizationId: { $in: rootOrgIds }, isActive: true });
    }
    const clinicIds = clinics.map((c) => c._id);

    // 1. Average Length of Stay (ALOS)
    const clinicFilter = { clinicId: { $in: clinicIds } };
    const dischargedAdmissions = await Admission.find({ status: "discharged", ...clinicFilter });

    let totalInpatientDays = 0;
    dischargedAdmissions.forEach((adm) => {
      const start = adm.admissionDate || adm.createdAt;
      const end = adm.dischargeDate || adm.updatedAt;
      if (start && end) {
        const diffMs = new Date(end).getTime() - new Date(start).getTime();
        const days = Math.max(1, Math.ceil(diffMs / (1000 * 3600 * 24)));
        totalInpatientDays += days;
      }
    });

    const totalDischarges = dischargedAdmissions.length;
    const alosDays = totalDischarges > 0 ? Number((totalInpatientDays / totalDischarges).toFixed(1)) : null;

    // 2. Bed Occupancy Rate (BOR)
    const beds = await Bed.find({ clinicId: { $in: clinicIds } });
    const totalBeds = beds.length;
    const occupiedBeds = beds.filter((b) => b.status === "occupied").length;
    const bedOccupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : null;

    // 3. 30-Day Hospital Readmission Rate
    // Patients with > 1 admission within 30 days
    const patientAdmissionsMap: Record<string, Date[]> = {};
    const allAdmissions = await Admission.find(clinicFilter).sort({ createdAt: 1 });
    allAdmissions.forEach((adm) => {
      const pId = adm.patientId.toString();
      if (!patientAdmissionsMap[pId]) patientAdmissionsMap[pId] = [];
      patientAdmissionsMap[pId].push(new Date(adm.admissionDate || adm.createdAt));
    });

    let readmissionCount = 0;
    Object.values(patientAdmissionsMap).forEach((dates) => {
      for (let i = 1; i < dates.length; i++) {
        const diffDays = (dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 3600 * 24);
        if (diffDays <= 30) {
          readmissionCount++;
          break;
        }
      }
    });

    const uniquePatientsCount = Object.keys(patientAdmissionsMap).length;
    const readmissionRate = uniquePatientsCount > 0 ? Number(((readmissionCount / uniquePatientsCount) * 100).toFixed(1)) : null;

    // 4. MAR Medication Safety Compliance Rate
    const totalMarDoses = await MedicationAdministration.countDocuments(clinicFilter);
    const administeredDoses = await MedicationAdministration.countDocuments({ ...clinicFilter, status: "given" });
    const marComplianceRate = totalMarDoses > 0 ? Math.round((administeredDoses / totalMarDoses) * 100) : null;

    const feedback = await PatientFeedback.find(clinicFilter).select("rating").lean();
    const patientSatisfactionScore = feedback.length > 0
      ? Number(((feedback.reduce((sum, item) => sum + item.rating, 0) / feedback.length / 5) * 100).toFixed(1))
      : null;

    return reply.code(200).send(
      successResponse({
        nabhStandardsVersion: "NABH 5th Edition Standards",
        indicators: {
          averageLengthOfStayDays: alosDays,
          bedOccupancyRatePercent: bedOccupancyRate,
          readmissionRate30DaysPercent: readmissionRate,
          marMedicationCompliancePercent: marComplianceRate,
          hospitalAcquiredInfectionRatePer1000: null,
          patientSatisfactionScorePercent: patientSatisfactionScore,
        },
        benchmarks: {
          targetALOS: "3.0 - 5.0 days",
          targetBOR: "75 - 85%",
          targetReadmissionRate: "< 5.0%",
          targetMARCompliance: "> 95%",
        },
      })
    );
  } catch (err) {
    console.error("getNabhKpis error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * Clinical Summary & Patient Throughput Analytics
 */
export async function getClinicalSummaryAnalyticsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    let clinics = orgId ? await Clinic.find({ organizationId: orgId, isActive: true }) : [];
    if (clinics.length === 0 && req.user?.role === "root") {
      const rootOrgs = await Organization.find().select("_id").lean();
      const rootOrgIds = rootOrgs.map((o: any) => o._id);
      clinics = await Clinic.find({ organizationId: { $in: rootOrgIds }, isActive: true });
    }
    const clinicIds = clinics.map((c) => c._id);

    const encounterFilter = { clinicId: { $in: clinicIds } };
    const totalEncounters = await Encounter.countDocuments(encounterFilter);
    const completedEncounters = await Encounter.countDocuments({ ...encounterFilter, status: "completed" });
    const activeEncounters = await Encounter.countDocuments({ ...encounterFilter, status: "in_progress" });
    const totalClaims = await Claim.countDocuments({ clinicId: { $in: clinicIds }, deletedAt: null });
    const approvedClaims = await Claim.countDocuments({ clinicId: { $in: clinicIds }, deletedAt: null, status: { $in: ["approved", "settled"] } });

    return reply.code(200).send(
      successResponse({
        totalEncounters,
        completedEncounters,
        activeEncounters,
        throughputRatePercent: totalEncounters > 0 ? Math.round((completedEncounters / totalEncounters) * 100) : null,
        claimApprovalRate: totalClaims > 0 ? Number(((approvedClaims / totalClaims) * 100).toFixed(1)) : null,
      })
    );
  } catch (err) {
    console.error("getClinicalSummaryAnalyticsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * Export Analytics & Quality Report Data (JSON/CSV Payload)
 */
export async function exportAnalyticsReportController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const format = (req.query as any)?.format || "json";
    const reportType = (req.query as any)?.reportType || "executive";

    let rootOrgIds: any[] = [];
    if (!orgId && req.user?.role === "root") {
      const rootOrgs = await Organization.find().select("_id").lean();
      rootOrgIds = rootOrgs.map((o: any) => o._id);
    }
    const clinics = orgId
      ? await Clinic.find({ organizationId: orgId, isActive: true }).select("_id")
      : (req.user?.role === "root" ? await Clinic.find({ organizationId: { $in: rootOrgIds }, isActive: true }).select("_id") : []);
    const clinicIds = clinics.map((clinic) => clinic._id);
    const clinicFilter = { clinicId: { $in: clinicIds } };
    const [invoiceCount, appointmentCount, encounterCount, claimCount] = await Promise.all([
      Invoice.countDocuments(clinicFilter),
      Appointment.countDocuments(clinicFilter),
      Encounter.countDocuments(clinicFilter),
      Claim.countDocuments({ ...clinicFilter, deletedAt: null }),
    ]);

    const reportData = {
      exportedAt: new Date().toISOString(),
      organizationId: orgId || "GLOBAL",
      reportType,
      summary: "ANANTA Healthcare Executive & NABH Quality Accreditation Report",
      status: "generated",
      metrics: { invoiceCount, appointmentCount, encounterCount, claimCount },
    };

    if (format === "csv") {
      reply.header("Content-Type", "text/csv");
      reply.header("Content-Disposition", 'attachment; filename="analytics-report.csv"');
      return reply.code(200).send([
        "Metric,Value",
        `Exported At,${reportData.exportedAt}`,
        `Report Type,${reportData.reportType}`,
        `Invoice Count,${invoiceCount}`,
        `Appointment Count,${appointmentCount}`,
        `Encounter Count,${encounterCount}`,
        `Claim Count,${claimCount}`,
      ].join("\n"));
    }

    return reply.code(200).send(successResponse(reportData));
  } catch (err) {
    console.error("exportAnalyticsReportController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

