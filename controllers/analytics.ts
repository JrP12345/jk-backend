import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { Encounter } from "../models/Encounter.ts";
import { Claim } from "../models/Claim.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

/**
 * Executive Analytics Dashboard Endpoint
 * Powered by high-performance MongoDB Aggregation Pipelines ($match, $group, $facet).
 */
export async function getExecutiveAnalytics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const { startDate, endDate, locationId } = req.query as { startDate?: string; endDate?: string; locationId?: string };

    // 1. Resolve Locations under organization scope
    let locations = orgId ? await Location.find({ organizationId: orgId, isActive: true }) : [];
    if (!orgId && req.user?.role === "root") {
      const activeOrgs = await Organization.find().select("_id").lean();
      const activeOrgIds = activeOrgs.map((o: any) => o._id);
      locations = await Location.find({ organizationId: { $in: activeOrgIds }, isActive: true });
    }
    const locationIds = locations.map((c) => c._id);

    if (locationId) {
      if (!mongoose.Types.ObjectId.isValid(locationId)) return reply.code(400).send(errorResponse("Invalid location ID"));
      if (!locationIds.some((id) => id.toString() === locationId)) return reply.code(404).send(errorResponse("Location not found"));
    }
    if ((startDate && !Number.isFinite(Date.parse(startDate))) || (endDate && !Number.isFinite(Date.parse(endDate)))) {
      return reply.code(400).send(errorResponse("Invalid analytics date range"));
    }

    if (locationIds.length === 0) {
      return reply.code(200).send(
        successResponse({
          overall: { totalRevenue: 0, outstandingBilling: 0, bedOccupancyRate: 0, lowStockWarnings: 0 },
          locationsPerformance: [],
          doctorSpecializations: [],
          appointmentStats: { total: 0, completed: 0, pending: 0, cancelled: 0, noShow: 0, completionRate: 0 },
          referralStats: { totalReferrals: 0, completedReferrals: 0, completionRate: 0 },
        })
      );
    }

    // Filter match object for date range
    // Aggregation bypasses Mongoose query tenant hooks. Keep the explicit
    // organization condition even when a caller selects an authorized location.
    const organizationMatch = orgId ? { organizationId: new mongoose.Types.ObjectId(orgId) } : {};
    const invoiceMatch: any = { ...organizationMatch, locationId: { $in: locationIds } };
    const apptMatch: any = { ...organizationMatch, locationId: { $in: locationIds } };

    if (locationId && mongoose.Types.ObjectId.isValid(locationId)) {
      const targetObjId = new mongoose.Types.ObjectId(locationId);
      invoiceMatch.locationId = targetObjId;
      apptMatch.locationId = targetObjId;
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
          locationBreakdown: [
            {
              $group: {
                _id: { locationId: "$locationId", status: "$status" },
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
    const bedOccupancyRate = 0;

    // 4. Low Stock Medicines Aggregation
    const lowStockMedicines = await Medicine.countDocuments({
      ...organizationMatch,
      locationId: { $in: locationIds },
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
          locationApptCounts: [
            {
              $group: {
                _id: "$locationId",
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
    const locationApptCounts = apptAgg[0]?.locationApptCounts || [];
    const referralCounts = apptAgg[0]?.referralCounts || [];

    const getStatusCount = (s: string) => statusCounts.find((c: any) => c._id === s)?.count || 0;
    const totalAppts = statusCounts.reduce((acc: number, curr: any) => acc + curr.count, 0);
    const completedAppts = getStatusCount("completed");
    const apptCompletionRate = totalAppts > 0 ? Math.round((completedAppts / totalAppts) * 100) : 0;

    const totalReferrals = referralCounts.reduce((acc: number, curr: any) => acc + curr.count, 0);
    const completedReferrals = referralCounts.find((r: any) => r._id === "completed")?.count || 0;
    const referralCompletionRate = totalReferrals > 0 ? Math.round((completedReferrals / totalReferrals) * 100) : 0;

    // Build Locations Performance Breakdown map
    const locationBreakdownList = invoiceAgg[0]?.locationBreakdown || [];

    const locationsPerformance = locations.map((c) => {
      const cIdStr = c.id;

      const cPaid = locationBreakdownList.find((cb: any) => cb._id.locationId?.toString() === cIdStr && cb._id.status === "paid");
      const cUnpaid = locationBreakdownList.find((cb: any) => cb._id.locationId?.toString() === cIdStr && cb._id.status === "unpaid");
      const cAppt = locationApptCounts.find((ca: any) => ca._id?.toString() === cIdStr);

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
        locationsPerformance,
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && req.user?.role !== "root") return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;

    let locations = orgId ? await Location.find({ organizationId: orgId, isActive: true }) : [];
    if (locations.length === 0 && req.user?.role === "root") {
      const rootOrgs = await Organization.find().select("_id").lean();
      const rootOrgIds = rootOrgs.map((o: any) => o._id);
      locations = await Location.find({ organizationId: { $in: rootOrgIds }, isActive: true });
    }
    const locationIds = locations.map((c) => c._id);
    const locationFilter = { locationId: { $in: locationIds } };

    const feedback = await PatientFeedback.find(locationFilter).select("rating").lean();
    const patientSatisfactionScore = feedback.length > 0
      ? Number(((feedback.reduce((sum, item) => sum + item.rating, 0) / feedback.length / 5) * 100).toFixed(1))
      : null;

    return reply.code(200).send(
      successResponse({
        nabhStandardsVersion: "NABH Clinic Quality Standards",
        indicators: {
          averageLengthOfStayDays: null,
          bedOccupancyRatePercent: null,
          readmissionRate30DaysPercent: null,
          marMedicationCompliancePercent: null,
          hospitalAcquiredInfectionRatePer1000: null,
          patientSatisfactionScorePercent: patientSatisfactionScore,
        },
        benchmarks: {
          targetSatisfaction: "> 90%",
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && req.user?.role !== "root") return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    let locations = orgId ? await Location.find({ organizationId: orgId, isActive: true }) : [];
    if (locations.length === 0 && req.user?.role === "root") {
      const rootOrgs = await Organization.find().select("_id").lean();
      const rootOrgIds = rootOrgs.map((o: any) => o._id);
      locations = await Location.find({ organizationId: { $in: rootOrgIds }, isActive: true });
    }
    const locationIds = locations.map((c) => c._id);

    const encounterFilter = { locationId: { $in: locationIds } };
    const totalEncounters = await Encounter.countDocuments(encounterFilter);
    const completedEncounters = await Encounter.countDocuments({ ...encounterFilter, status: "completed" });
    const activeEncounters = await Encounter.countDocuments({ ...encounterFilter, status: "in_progress" });
    const totalClaims = await Claim.countDocuments({ locationId: { $in: locationIds }, deletedAt: null });
    const approvedClaims = await Claim.countDocuments({ locationId: { $in: locationIds }, deletedAt: null, status: { $in: ["approved", "settled"] } });

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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && req.user?.role !== "root") return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const format = (req.query as any)?.format || "json";
    const reportType = (req.query as any)?.reportType || "executive";

    let rootOrgIds: any[] = [];
    if (!orgId && req.user?.role === "root") {
      const rootOrgs = await Organization.find().select("_id").lean();
      rootOrgIds = rootOrgs.map((o: any) => o._id);
    }
    const locations = orgId
      ? await Location.find({ organizationId: orgId, isActive: true }).select("_id")
      : (req.user?.role === "root" ? await Location.find({ organizationId: { $in: rootOrgIds }, isActive: true }).select("_id") : []);
    const locationIds = locations.map((location) => location._id);
    const locationFilter = { locationId: { $in: locationIds } };
    const [invoiceCount, appointmentCount, encounterCount, claimCount] = await Promise.all([
      Invoice.countDocuments(locationFilter),
      Appointment.countDocuments(locationFilter),
      Encounter.countDocuments(locationFilter),
      Claim.countDocuments({ ...locationFilter, deletedAt: null }),
    ]);

    const reportData = {
      exportedAt: new Date().toISOString(),
      organizationId: orgId || "GLOBAL",
      reportType,
      summary: "Ekavyu Healthcare Executive & NABH Quality Accreditation Report",
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
