import type { FastifyRequest, FastifyReply } from "fastify";
import { Clinic } from "../models/Clinic.ts";
import { Invoice } from "../models/Invoice.ts";
import { Bed } from "../models/Bed.ts";
import { Medicine } from "../models/Medicine.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function getExecutiveAnalytics(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId = req.user!.organization_id;
    
    // 1. Fetch clinics under organization (or all clinics for Root Admin)
    let clinics = orgId ? await Clinic.find({ organizationId: orgId, isActive: true }) : [];
    if (clinics.length === 0 && req.user?.role === "root") {
      clinics = await Clinic.find({ isActive: true });
    }
    const clinicIds = clinics.map(c => c._id);

    if (clinicIds.length === 0) {
      return reply.code(200).send(successResponse({
        overall: { totalRevenue: 0, outstandingBilling: 0, bedOccupancyRate: 0, lowStockWarnings: 0 },
        clinicsPerformance: [],
        doctorSpecializations: [],
        referralStats: { totalReferrals: 0, completedReferrals: 0, completionRate: 0 }
      }));
    }

    // 2. Fetch invoices for revenue calculations
    const invoices = await Invoice.find({ clinicId: { $in: clinicIds } });
    
    let totalRevenue = 0;
    let outstandingBilling = 0;
    
    // Calculate today's start
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    invoices.forEach(inv => {
      if (inv.status === "paid") {
        totalRevenue += inv.totalAmount;
      } else if (inv.status === "unpaid") {
        outstandingBilling += inv.totalAmount;
      }
    });

    // 3. Fetch beds for occupancy calculations
    const beds = await Bed.find({ clinicId: { $in: clinicIds } });
    const totalBeds = beds.length;
    const occupiedBeds = beds.filter(b => b.status === "occupied").length;
    const bedOccupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

    // 4. Fetch medicines for low stock warnings
    const lowStockMedicines = await Medicine.countDocuments({
      clinicId: { $in: clinicIds },
      stockQuantity: { $lt: 10 }
    });

    // 5. Calculate per-clinic performance
    const appointments = await Appointment.find({ clinicId: { $in: clinicIds } });
    
    const clinicsPerformance = clinics.map(clinic => {
      const clinicInvoices = invoices.filter(inv => inv.clinicId.toString() === clinic.id);
      const clinicAppts = appointments.filter(app => app.clinicId.toString() === clinic.id);

      const clinicRevenue = clinicInvoices
        .filter(inv => inv.status === "paid")
        .reduce((sum, inv) => sum + inv.totalAmount, 0);

      const clinicOutstanding = clinicInvoices
        .filter(inv => inv.status === "unpaid")
        .reduce((sum, inv) => sum + inv.totalAmount, 0);

      return {
        id: clinic.id,
        name: clinic.name,
        city: clinic.city,
        appointmentCount: clinicAppts.length,
        revenue: clinicRevenue,
        outstanding: clinicOutstanding
      };
    });

    // 6. Referral performance stats
    // We check appointments where followUpForAppointmentId is set (referred from a previous appointment)
    const referrals = appointments.filter(app => app.followUpForAppointmentId !== null && app.followUpForAppointmentId !== undefined);
    const totalReferrals = referrals.length;
    const completedReferrals = referrals.filter(app => app.status === "completed").length;
    const referralCompletionRate = totalReferrals > 0 ? Math.round((completedReferrals / totalReferrals) * 100) : 0;

    // 7. Doctor specializations count
    // Fetch all user profiles with role doctor
    const doctorsList = await Doctor.find({ organizationId: orgId });
    const specCounts: Record<string, number> = {};
    doctorsList.forEach((doc: any) => {
      const spec = doc.specialization || "General Medicine";
      specCounts[spec] = (specCounts[spec] || 0) + 1;
    });

    const doctorSpecializations = Object.entries(specCounts).map(([name, count]) => ({
      name,
      count
    }));

    return reply.code(200).send(successResponse({
      overall: {
        totalRevenue,
        outstandingBilling,
        bedOccupancyRate,
        lowStockWarnings: lowStockMedicines
      },
      clinicsPerformance,
      doctorSpecializations,
      referralStats: {
        totalReferrals,
        completedReferrals,
        completionRate: referralCompletionRate
      }
    }));
  } catch (err) {
    console.error("getExecutiveAnalytics error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
