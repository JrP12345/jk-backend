import { LabOrder } from "../../models/LabOrder.ts";
import { LabTest } from "../../models/LabTest.ts";
import { User } from "../../models/User.ts";
import { Doctor } from "../../models/Doctor.ts";
import {
  type TimelineEvent,
  type TimelineProvider,
  type TimelineQueryOptions,
  TimelineSource,
} from "../../types/timeline.ts";

/**
 * LabProvider — surfaces LabOrder events into the longitudinal EHR timeline.
 *
 * v1.6.0 enrichment:
 *   - Structured result value, unit, reference range
 *   - Interpretation flag (Normal / Abnormal / Critical)
 *   - Priority surfacing (urgent/stat get amber badge)
 *   - Department classification
 *   - Distinct ordering doctor identity
 *   - Abnormal results render with amber badge for clinical visibility
 */
export class LabProvider implements TimelineProvider {
  name = "LabProvider";

  supports(query: TimelineQueryOptions): boolean {
    return !query.category || query.category === "all" || query.category === "lab";
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    const orders = await LabOrder.find({
      patientId: query.patientId,
      ...(query.organizationId && !query.isCrossOrgAllowed ? { organizationId: query.organizationId } : {}),
    }).setOptions({ bypassTenantFilter: query.isCrossOrgAllowed === true })
      .populate("testId", "name code department sampleType normalRange")
      .populate("orderedBy", "name")
      .populate("doctorId", "name")
      .lean();

    const events: TimelineEvent[] = [];

    for (const order of orders as any[]) {
      const testName  = order.testId?.name       || "Diagnostic Lab Test";
      const testCode  = order.testId?.code       || "";
      const dept      = order.testId?.department || "Laboratory";

      // Resolve ordering practitioner
      const actorDoc  = order.orderedBy || order.doctorId;
      const doctorName = actorDoc?.name || "Ordering Physician";
      const doctorId   = actorDoc?._id?.toString() || actorDoc?.toString() || "unknown";

      // ─── Structured result or flat string representation ─────────
      const hasStructuredResult = order.result?.value && order.result.value.length > 0;
      const resultValue     = hasStructuredResult ? order.result.value     : (order.resultValue || "");
      const resultUnit      = hasStructuredResult ? order.result.unit      : "";
      const referenceRange  = hasStructuredResult ? order.result.referenceRange : (order.testId?.normalRange || "");
      const interpretation  = hasStructuredResult ? order.result.interpretation : "";
      const isAbnormal      = hasStructuredResult ? order.result.isAbnormal     : false;
      const resultNotes     = hasStructuredResult ? order.result.notes     : (order.resultNotes || "");
      const attachmentUrl   = hasStructuredResult ? order.result.attachmentUrl : (order.attachmentUrl || "");

      // ─── Display label for result ─────────────────────────────────
      const resultDisplay = resultValue
        ? `${resultValue}${resultUnit ? " " + resultUnit : ""}${referenceRange ? " (Ref: " + referenceRange + ")" : ""}`
        : "Pending";

      const interpretationLabel = interpretation
        ? ` — ${interpretation.charAt(0).toUpperCase() + interpretation.slice(1)}`
        : "";

      // ─── Badge: abnormal/critical = amber, urgent/stat = orange, else blue ──
      const badgeColor = isAbnormal || interpretation === "critical"
        ? "amber"
        : order.priority === "stat" || order.priority === "urgent"
          ? "orange"
          : "blue";

      const statusLabel = order.status === "result-uploaded" && interpretation
        ? `${interpretation.charAt(0).toUpperCase() + interpretation.slice(1)}`
        : order.status;

      events.push({
        id: order._id.toString(),
        type: "lab_result",
        occurredAt: order.resultedAt || order.completedDate || order.orderDate || order.createdAt,
        patientId: query.patientId,
        organizationId: order.organizationId?.toString() || query.organizationId,
        title: `Lab: ${testName} (${dept})${order.priority !== "routine" ? " [" + order.priority!.toUpperCase() + "]" : ""}`,
        summary: resultValue
          ? `Result: ${resultDisplay}${interpretationLabel}`
          : `Status: ${order.status}`,
        actor: {
          id: doctorId,
          name: doctorName,
          role: "Doctor",
        },
        sourceRef: {
          source: TimelineSource.LAB,
          resourceType: "LabOrder",
          resourceId: order._id.toString(),
          link: `/dashboard/laboratory?id=${order._id.toString()}`,
        },
        clinicalMetadata: {
          labValues: [
            {
              testName: `${testName}${testCode ? " (" + testCode + ")" : ""}`,
              value:    resultValue || "Pending",
              notes:    [resultNotes, referenceRange ? `Ref: ${referenceRange}` : ""].filter(Boolean).join(" | "),
              attachmentUrl,
            },
          ],
        },
        displayMetadata: {
          icon: "flask",
          badgeColor,
          statusLabel,
          uiCategory: "lab",
        },
        clinicalConcepts: {
          diagnoses:   [],
          medications: [],
          procedures:  [`${testName} (${dept})`],
          allergies:   [],
          vitals:      {},
          labCodes:    [testCode || testName],
        },
      });
    }

    return events;
  }
}
