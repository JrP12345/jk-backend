import mongoose from "mongoose";
import { Patient } from "../../models/Patient.ts";
import { User } from "../../models/User.ts";
import { Prescription } from "../../models/Prescription.ts";
import { LabOrder } from "../../models/LabOrder.ts";
import { Appointment } from "../../models/Appointment.ts";
import { Clinic } from "../../models/Clinic.ts";
import { Invoice } from "../../models/Invoice.ts";
import { Organization } from "../../models/Organization.ts";

export interface ContextDimensionInput {
  currentRoute?: string;
  activePatientId?: string;
  userRole?: string;
  organizationId?: string;
}

export interface Assembled6DContext {
  routeContext: string;
  patientRecordContext: string;
  roleContext: string;
  encounterContext: string;
  organizationContext: string;
  fullContextSummary: string;
}

export class ContextEngine {
  private static instance: ContextEngine;
  private metricsCache: Map<string, { data: string; expiresAt: number }> = new Map();
  private CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

  private constructor() {}

  static getInstance(): ContextEngine {
    if (!ContextEngine.instance) {
      ContextEngine.instance = new ContextEngine();
    }
    return ContextEngine.instance;
  }

  /**
   * Aggregates 6 dimensions of context across the platform:
   * 1. Route Context
   * 2. Role Context
   * 3. Organization & Live Financial/Operational Metrics (Real-time DB query with 5m TTL cache)
   * 4. Patient Longitudinal EHR
   * 5. Encounter History
   * 6. Clinical Domain Directives
   */
  async build6DContext(input: ContextDimensionInput): Promise<Assembled6DContext> {
    // 1. Route Context
    const routeContext = input.currentRoute
      ? `Active Screen / Route: "${input.currentRoute}"`
      : "Active Screen / Route: General Hospital Dashboard";

    // 2. Role Context
    const roleContext = `User Access Role: ${input.userRole || "clinician"}`;

    // 3. Organization Financial & Operational Metrics (Cached with 5m TTL)
    let orgName = "Healthcare System";
    const orgId = input.organizationId;
    const isOperationalQuery = !!(input.currentRoute && (
      input.currentRoute.includes("analytics") ||
      input.currentRoute.includes("billing") ||
      input.currentRoute.includes("finance") ||
      input.currentRoute.includes("admin")
    ));
    const cacheKey = `${orgId || "default_org"}_${isOperationalQuery ? "ops" : "clin"}`;

    let organizationContext = "";
    const cachedMetrics = this.metricsCache.get(cacheKey);

    if (cachedMetrics && cachedMetrics.expiresAt > Date.now()) {
      organizationContext = cachedMetrics.data;
    } else {
      if (orgId && mongoose.Types.ObjectId.isValid(orgId)) {
        try {
          const orgObj = await Organization.findById(orgId).select("name city").lean();
          if (orgObj) orgName = orgObj.name;
        } catch (e: any) {
          console.warn(`[ContextEngine] Organization lookup warning for ${orgId}:`, e.message);
        }
      }
      if (orgName === "Healthcare System") {
        try {
          const firstOrg = await Organization.findOne({ isActive: true }).select("name city").lean();
          if (firstOrg) orgName = firstOrg.name;
        } catch (e: any) {
          console.warn("[ContextEngine] Default Organization lookup warning:", e.message);
        }
      }

      organizationContext = `Facility / Organization: ${orgName}`;
      try {
        const clinicFilter = orgId && mongoose.Types.ObjectId.isValid(orgId)
          ? { organizationId: orgId, isActive: true }
          : { isActive: true };

        let clinics = await Clinic.find(clinicFilter).select("name city").lean();
        if (clinics.length === 0) {
          // Fallback: filter by valid org IDs to exclude orphan clinics
          const validOrgs = await Organization.find().select("_id").lean();
          const validOrgIds = validOrgs.map((o: any) => o._id);
          clinics = await Clinic.find({ organizationId: { $in: validOrgIds }, isActive: true }).select("name city").lean();
        }

        const clinicIds = clinics.map((c) => c._id);
        const clinicNames = clinics.map(c => `${c.name} (${c.city})`).join(", ") || "Main Clinic";
        let operationalDetails = "";

        if (isOperationalQuery) {
          const invoiceFilter = clinicIds.length > 0 ? { clinicId: { $in: clinicIds } } : {};
          const startOfToday = new Date();
          startOfToday.setHours(0, 0, 0, 0);

          const [aggResults, appointmentsCount] = await Promise.all([
            Invoice.aggregate([
              { $match: invoiceFilter },
              {
                $facet: {
                  statusTotals: [
                    {
                      $group: {
                        _id: "$status",
                        totalAmount: { $sum: "$totalAmount" },
                        count: { $sum: 1 }
                      }
                    }
                  ],
                  todayPaid: [
                    {
                      $match: {
                        status: "paid",
                        $or: [
                          { paymentDate: { $gte: startOfToday } },
                          { createdAt: { $gte: startOfToday } }
                        ]
                      }
                    },
                    {
                      $group: {
                        _id: null,
                        totalAmount: { $sum: "$totalAmount" },
                        count: { $sum: 1 }
                      }
                    }
                  ]
                }
              }
            ]),
            Appointment.countDocuments(clinicIds.length > 0 ? { clinicId: { $in: clinicIds } } : {})
          ]);

          const statusTotals = aggResults[0]?.statusTotals || [];
          const todayPaidStats = aggResults[0]?.todayPaid?.[0];

          const paidStats = statusTotals.find((s: any) => s._id === "paid");
          const unpaidStats = statusTotals.find((s: any) => s._id === "unpaid");

          const totalRevenue = paidStats ? paidStats.totalAmount : 0;
          const paidInvoicesCount = paidStats ? paidStats.count : 0;
          const outstandingBilling = unpaidStats ? unpaidStats.totalAmount : 0;
          const unpaidInvoicesCount = unpaidStats ? unpaidStats.count : 0;
          const effectiveTodayRevenue = todayPaidStats ? todayPaidStats.totalAmount : totalRevenue;

          operationalDetails = [
            `- Today's Revenue Collections: ₹${effectiveTodayRevenue.toLocaleString()} (${paidInvoicesCount} paid transactions)`,
            `- Total Cumulative Revenue Collections: ₹${totalRevenue.toLocaleString()} (${paidInvoicesCount} total transactions)`,
            `- Outstanding Billings (Unpaid): ₹${outstandingBilling.toLocaleString()} (${unpaidInvoicesCount} pending invoices)`,
            `- Total Patient Visits / Appointments: ${appointmentsCount} recorded`,
          ].join("\n");
        } else {
          // Standard Clinical Workflow: zero financial exposure, lean token footprint
          operationalDetails = `- Clinical Care Context: Facility operational with active clinical encounters.`;
        }

        organizationContext = [
          `Facility / Organization Context:`,
          `- Facility Name: ${orgName}`,
          `- Organization ID: ${orgId}`,
          `- Active Clinics (${clinics.length}): ${clinicNames}`,
          operationalDetails,
        ].filter(Boolean).join("\n");

        // Cache the formatted organizationContext
        this.metricsCache.set(cacheKey, {
          data: organizationContext,
          expiresAt: Date.now() + this.CACHE_TTL_MS
        });
      } catch (err: any) {
        console.warn("[ContextEngine] Failed to build live organization context:", err.message);
      }
    }


    // 4 & 5. Patient Longitudinal EHR & Encounter Context
    let patientRecordContext = "Active Patient Context: No active patient chart selected.";
    let encounterContext = "Active Encounter Context: General Inquiry.";

    if (input.activePatientId && input.activePatientId.length === 24) {
      try {
        const patient = await Patient.findById(input.activePatientId).populate("userId", "name email").lean();
        if (patient) {
          const patientName = (patient.userId as any)?.name || "Patient";
          const prescriptions = await Prescription.find({ patientId: input.activePatientId }).limit(5).lean();
          const rxList = prescriptions.map(p => `${(p as any).medicineName || (p as any).medicationName || "Medication"} ${p.dosage}`).join(", ") || "None recorded";

          const labOrders = await LabOrder.find({ patientId: input.activePatientId }).limit(3).lean();
          const labList = labOrders.map(l => `${(l as any).testName || "Lab Test"} (${l.status})`).join(", ") || "None pending";

          const appointments = await Appointment.find({ patientId: input.activePatientId }).sort({ appointmentTime: -1 }).limit(1).lean();
          const apptDate = appointments[0] ? (appointments[0].appointmentTime || (appointments[0] as any).createdAt) : null;
          const lastAppt = apptDate ? `Last Appt: ${new Date(apptDate).toLocaleDateString()}` : "No past appts";

          const patientConditions = (patient.conditions || []).join(", ") || "None";
          patientRecordContext = `Active Patient Record: Name: ${patientName}, MRN: MRN-${patient._id.toString().substring(18).toUpperCase()}, Conditions: ${patientConditions}. Active Rx: ${rxList}. Labs: ${labList}.`;
          encounterContext = `Encounter History: ${lastAppt}.`;
        }
      } catch (err) {
        console.warn("[ContextEngine] Failed to build patient EHR context:", err);
      }
    }

    const fullContextSummary = [
      routeContext,
      roleContext,
      organizationContext,
      patientRecordContext,
      encounterContext
    ].join("\n");

    return {
      routeContext,
      patientRecordContext,
      roleContext,
      encounterContext,
      organizationContext,
      fullContextSummary
    };
  }
}

export const contextEngine = ContextEngine.getInstance();
