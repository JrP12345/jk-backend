import { Invoice } from "../../models/Invoice.ts";
import {
  type TimelineEvent,
  type TimelineProvider,
  type TimelineQueryOptions,
  TimelineSource,
} from "../../types/timeline.ts";

export class BillingProvider implements TimelineProvider {
  name = "BillingProvider";

  supports(query: TimelineQueryOptions): boolean {
    // Only execute if explicitly requested via includeFinancial or category === 'billing'
    if (query.category === "billing") return true;
    if (query.includeFinancial === true && (!query.category || query.category === "all")) return true;
    return false;
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    const invoices = await Invoice.find({
      patientId: query.patientId,
    }).lean();

    const events: TimelineEvent[] = [];

    for (const inv of invoices as any[]) {
      events.push({
        id: inv._id.toString(),
        type: "billing",
        occurredAt: inv.paidAt || inv.createdAt,
        patientId: query.patientId,
        organizationId: query.organizationId,
        title: `Invoice #${inv.invoiceNumber || inv._id.toString().slice(-6)}`,
        summary: `Amount: ₹${inv.totalAmount || 0} — Status: ${inv.status || "unpaid"}`,
        actor: {
          id: "system",
          name: "Billing System",
          role: "Finance",
        },
        sourceRef: {
          source: TimelineSource.BILLING,
          resourceType: "Invoice",
          resourceId: inv._id.toString(),
          link: `/dashboard/bills?id=${inv._id.toString()}`,
        },
        clinicalMetadata: {
          billing: {
            totalAmount: inv.totalAmount || 0,
            paymentStatus: inv.status || "unpaid",
            paidAt: inv.paymentDate ? new Date(inv.paymentDate).toISOString() : undefined,
          },
        },
        displayMetadata: {
          icon: "credit-card",
          badgeColor: "amber",
          statusLabel: inv.status || "unpaid",
          uiCategory: "billing",
        },
        clinicalConcepts: {
          diagnoses: [],
          medications: [],
          procedures: ["Invoice Processing"],
          allergies: [],
          vitals: {},
          labCodes: [],
        },
      });
    }

    return events;
  }
}
