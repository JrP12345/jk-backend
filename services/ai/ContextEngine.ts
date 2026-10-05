import mongoose from "mongoose";
import { Patient } from "../../models/Patient.ts";
import { User } from "../../models/User.ts";
import { Prescription } from "../../models/Prescription.ts";
import { LabOrder } from "../../models/LabOrder.ts";
import { Appointment } from "../../models/Appointment.ts";
import { Clinic } from "../../models/Clinic.ts";
import { Invoice } from "../../models/Invoice.ts";
import { Organization } from "../../models/Organization.ts";
import { OrgMember } from "../../models/OrgMember.ts";
import { getEffectivePermissions } from "../../utilities/permissions.ts";
import { checkPatientAccess } from "../../utilities/tenant.ts";
import { requestContextStore } from "../../utilities/context.ts";
import type { FastifyRequest } from "fastify";

export interface ContextDimensionInput {
  currentRoute?: string;
  activePatientId?: string;
  userRole?: string;
  organizationId?: string;
  userId?: string;
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
    const user = input.userId && mongoose.Types.ObjectId.isValid(input.userId)
      ? await User.findById(input.userId).select("role isActive authVersion").lean() : null;
    const requestContext = requestContextStore.getStore();
    const member = user && input.organizationId && mongoose.Types.ObjectId.isValid(input.organizationId)
      ? await OrgMember.findOne({ userId: user._id, organizationId: input.organizationId }).lean() : null;
    const userRole = user?.role === "root" ? "root" : member?.role || user?.role;
    const organizationAuthorized = !!(user?.isActive && (userRole === "root" || member ||
      (requestContext?.userId === input.userId && requestContext?.organizationId === input.organizationId)));
    const permissions = user?.isActive && userRole
      ? await getEffectivePermissions(userRole, input.organizationId, user?.authVersion) : new Set<string>();
    const canReadFinancials = organizationAuthorized && (userRole === "root" ||
      ["VIEW_BILLING", "MANAGE_BILLING", "VIEW_ANALYTICS"].some((permission) => permissions.has(permission)));
    if (input.activePatientId) {
      if (!user?.isActive || !userRole || (userRole !== "patient" && userRole !== "family_member" && !organizationAuthorized)) {
        throw Object.assign(new Error("Patient context access denied"), { statusCode: 403 });
      }
      if (userRole !== "root" && !permissions.has("VIEW_EHR") && !permissions.has("MANAGE_EHR")) {
        throw Object.assign(new Error("Patient context access denied"), { statusCode: 403 });
      }
      const access = await checkPatientAccess({ user: {
        id: user._id.toString(), role: userRole, organization_id: input.organizationId,
      } } as FastifyRequest, input.activePatientId);
      if (!access.allowed) throw Object.assign(new Error(access.message), { statusCode: access.statusCode });
    }
    // 1. Route Context
    const routeContext = input.currentRoute
      ? `Active Screen / Route: "${input.currentRoute}"`
      : "Active Screen / Route: General Hospital Dashboard";

    // 2. Role Context
    const roleContext = `User Access Role: ${userRole || "unauthorized"}`;

    // 3. Organization Financial & Operational Metrics (Cached with 5m TTL)
    let orgName = "Healthcare System";
    const orgId = input.organizationId;
    const isOperationalQuery = !!(canReadFinancials && orgId && mongoose.Types.ObjectId.isValid(orgId) && input.currentRoute && (
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
      organizationContext = `Facility / Organization: ${orgName}`;
      try {
        const clinicFilter = orgId && mongoose.Types.ObjectId.isValid(orgId)
          ? { organizationId: orgId, isActive: true }
          : { _id: null };

        const clinics = await Clinic.find(clinicFilter).select("name city").lean();

        const clinicIds = clinics.map((c) => c._id);
        const clinicNames = clinics.map(c => `${c.name} (${c.city})`).join(", ") || "No active clinics";
        let operationalDetails = "";

        if (isOperationalQuery) {
          const invoiceFilter = { organizationId: new mongoose.Types.ObjectId(orgId), clinicId: { $in: clinicIds } };
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
            Appointment.countDocuments(invoiceFilter)
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
        for (const [key, entry] of this.metricsCache) if (entry.expiresAt <= Date.now()) this.metricsCache.delete(key);
        if (this.metricsCache.size >= 100) this.metricsCache.delete(this.metricsCache.keys().next().value!);
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
          const recordScope = { organizationId: orgId && mongoose.Types.ObjectId.isValid(orgId) ? orgId : null };
          const patientName = (patient.userId as any)?.name || (patient as any).name || "Patient";
          const prescriptions = await Prescription.find({ patientId: input.activePatientId, ...recordScope }).limit(5).lean();
          const rxList = prescriptions.map(p => `${(p as any).medicineName || (p as any).medicationName || "Medication"} ${p.dosage}`).join(", ") || "None recorded";

          const labOrders = await LabOrder.find({ patientId: input.activePatientId, ...recordScope }).limit(3).lean();
          const labList = labOrders.map(l => `${(l as any).testName || "Lab Test"} (${l.status})`).join(", ") || "None pending";

          const appointments = await Appointment.find({ patientId: input.activePatientId, ...recordScope }).sort({ appointmentTime: -1 }).limit(1).lean();
          const apptDate = appointments[0] ? (appointments[0].appointmentTime || (appointments[0] as any).createdAt) : null;
          const lastAppt = apptDate ? `Last Appt: ${new Date(apptDate).toLocaleDateString()}` : "No past appts";

          const patientConditions = (patient.conditions || []).join(", ") || "None";
          patientRecordContext = `Active Patient Record: Name: ${patientName}, MRN: ${(patient as any).mrn || patient._id.toString()}, Conditions: ${patientConditions}. Active Rx: ${rxList}. Labs: ${labList}.`;
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
