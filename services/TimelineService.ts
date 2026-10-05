import { Patient } from "../models/Patient.ts";
import { getOrganizationPatient, hasPatientRecordAccess } from "./PatientRecordAccessService.ts";
import type {
  TimelineEvent,
  TimelineProvider,
  TimelineQueryOptions,
  TimelineQueryResponse,
} from "../types/timeline.ts";
import { ConsultationProvider } from "./providers/ConsultationProvider.ts";
import { LabProvider } from "./providers/LabProvider.ts";
import { BillingProvider } from "./providers/BillingProvider.ts";
import { DocumentUploadProvider } from "./providers/DocumentUploadProvider.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";

/** P2 providers gated by org module toggles — P1 providers always run. */
const PROVIDER_MODULE_REQUIREMENTS: Record<string, string> = {
  LabProvider: "laboratory",
};

export class TimelineProviderRegistry {
  private providers: TimelineProvider[] = [];

  register(provider: TimelineProvider): void {
    this.providers.push(provider);
  }

  getProvidersFor(query: TimelineQueryOptions): TimelineProvider[] {
    return this.providers.filter((p) => p.supports(query));
  }
}

export class TimelineService {
  private registry: TimelineProviderRegistry;

  constructor() {
    this.registry = new TimelineProviderRegistry();
    // Register built-in clinical & financial providers
    this.registry.register(new ConsultationProvider());
    this.registry.register(new LabProvider());
    this.registry.register(new BillingProvider());
    // Ekavyu v1.0: Patient & Clinic Document Upload provider
    this.registry.register(new DocumentUploadProvider());
  }


  /**
   * Encodes a timestamp and event ID into an opaque base64 cursor string.
   */
  static encodeCursor(timestamp: Date, id: string): string {
    return Buffer.from(`${timestamp.toISOString()}__${id}`).toString("base64");
  }

  /**
   * Decodes an opaque base64 cursor string into a timestamp and event ID tiebreaker.
   */
  static decodeCursor(cursor: string): { timestamp: Date; id: string } | null {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const [iso, id] = decoded.split("__");
      if (!iso || !id) return null;
      return { timestamp: new Date(iso), id };
    } catch {
      return null;
    }
  }

  async getPatientTimeline(query: TimelineQueryOptions): Promise<TimelineQueryResponse | null> {
    const startTime = Date.now();

    // 1. Verify Patient exists and check Multi-Tenant isolation
    const patient = await Patient.findById(query.patientId).setOptions({ bypassTenantFilter: true }).lean() as any;
    if (!patient) {
      return null; // Controller will return 404
    }

    // An organization sees its own events; a visit never grants access to another organization's history.
    query.isCrossOrgAllowed = false;
    if (query.organizationId && !await getOrganizationPatient(query.patientId, query.organizationId)) return null;
    if (query.includeAllRecords) {
      if (!await hasPatientRecordAccess(query.recordAccessToken, query.patientId, query.userId, query.organizationId, query.sessionId)) return null;
      query.isCrossOrgAllowed = true;
      const { AuditLog } = await import("../models/AuditLog.ts");
      await AuditLog.create({ userId: query.userId, organizationId: query.organizationId, action: "CROSS_ORG_PHI_READ", targetId: patient._id, targetModel: "Patient", category: "CLINICAL_READ", details: { reason: "Patient OTP approval" } });
    }

    // 2. Select matching providers from registry (skip disabled P3/P2 modules)
    const allProviders = this.registry.getProvidersFor(query);
    const providers: TimelineProvider[] = [];
    for (const provider of allProviders) {
      const requiredModule = PROVIDER_MODULE_REQUIREMENTS[provider.name];
      if (!requiredModule) {
        providers.push(provider);
        continue;
      }
      const enabled = query.organizationId ? await isModuleEnabledForOrganization(query.organizationId, requiredModule) : true;
      if (enabled) providers.push(provider);
    }
    const providerExecutionTimesMs: Record<string, number> = {};

    // 3. Execute providers in parallel with timing metrics
    const providerPromises = providers.map(async (provider) => {
      const pStart = Date.now();
      const events = await provider.fetch(query);
      providerExecutionTimesMs[provider.name] = Date.now() - pStart;
      return events;
    });

    const eventArrays = await Promise.all(providerPromises);
    let allEvents: TimelineEvent[] = eventArrays.flat();

    // Sort/window source events before text filtering. A sparse search page may
    // be empty with hasMore=true; its source cursor still advances safely.
    allEvents.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime() || b.id.localeCompare(a.id));
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const hasMore = allEvents.length > limit;
    const scanWindow = allEvents.slice(0, limit);
    const lastScanned = scanWindow.at(-1);
    const nextCursor = hasMore && lastScanned ? TimelineService.encodeCursor(new Date(lastScanned.occurredAt), lastScanned.id) : null;
    allEvents = scanWindow;
    // 4. Keyword Text Search Filtering (`q`)
    if (query.q && query.q.trim().length > 0) {
      const search = query.q.trim().toLowerCase();
      allEvents = allEvents.filter((ev) => {
        const titleMatch = ev.title.toLowerCase().includes(search);
        const summaryMatch = ev.summary.toLowerCase().includes(search);
        const actorMatch = ev.actor.name.toLowerCase().includes(search);
        const diagMatch = ev.clinicalConcepts.diagnoses.some((d) => d.toLowerCase().includes(search));
        const medMatch = ev.clinicalConcepts.medications.some((m) => m.toLowerCase().includes(search));
        const labMatch = ev.clinicalConcepts.labCodes.some((l) => l.toLowerCase().includes(search));
        return titleMatch || summaryMatch || actorMatch || diagMatch || medMatch || labMatch;
      });
    }

    const resultEvents = allEvents;
    const totalCount = resultEvents.length; // This is a page count, not an unbounded historical count.
    const durationMs = Date.now() - startTime;

    return {
      version: 1,
      events: resultEvents,
      nextCursor,
      hasMore,
      returnedCount: resultEvents.length,
      totalCount,
      totalCountIsExact: !hasMore && !query.cursor,
      metrics: {
        durationMs,
        providerExecutionTimesMs,
      },
    };
  }
}

export const timelineService = new TimelineService();
