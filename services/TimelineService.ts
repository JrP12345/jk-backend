import { Patient } from "../models/Patient.ts";
import type {
  TimelineEvent,
  TimelineProvider,
  TimelineQueryOptions,
  TimelineQueryResponse,
} from "../types/timeline.ts";
import { ConsultationProvider } from "./providers/ConsultationProvider.ts";
import { LabProvider } from "./providers/LabProvider.ts";
import { AdmissionProvider } from "./providers/AdmissionProvider.ts";
import { BillingProvider } from "./providers/BillingProvider.ts";
import { MARProvider } from "./providers/MARProvider.ts";
import { DischargeSummaryProvider } from "./providers/DischargeSummaryProvider.ts";
import { DocumentUploadProvider } from "./providers/DocumentUploadProvider.ts";

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
    this.registry.register(new AdmissionProvider());
    this.registry.register(new BillingProvider());
    // v1.5.0: Medication Administration Record (MAR) provider
    this.registry.register(new MARProvider());
    // v1.7.0: Discharge Summary provider
    this.registry.register(new DischargeSummaryProvider());
    // ANANTA v1.0: Patient & Clinic Document Upload provider
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
    const patient = await Patient.findById(query.patientId).lean();
    if (!patient) {
      return null; // Controller will return 404
    }

    if (patient.organizationId && patient.organizationId.toString() !== query.organizationId) {
      return null; // 404 Masking for multi-tenancy cross-tenant security
    }

    // 2. Select matching providers from registry
    const providers = this.registry.getProvidersFor(query);
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

    // 5. Deterministic Sort: occurredAt DESC, id DESC tiebreaker
    allEvents.sort((a, b) => {
      const timeA = new Date(a.occurredAt).getTime();
      const timeB = new Date(b.occurredAt).getTime();
      if (timeA !== timeB) {
        return timeB - timeA; // Most recent first
      }
      return b.id.localeCompare(a.id); // Tiebreaker by ID
    });

    const totalCount = allEvents.length;

    // 6. Cursor-Based Pagination
    let paginatedEvents = allEvents;
    if (query.cursor) {
      const decoded = TimelineService.decodeCursor(query.cursor);
      if (decoded) {
        const cursorTime = decoded.timestamp.getTime();
        paginatedEvents = allEvents.filter((ev) => {
          const evTime = new Date(ev.occurredAt).getTime();
          if (evTime < cursorTime) return true;
          if (evTime === cursorTime && ev.id.localeCompare(decoded.id) < 0) return true;
          return false;
        });
      }
    }

    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const hasMore = paginatedEvents.length > limit;
    const resultEvents = paginatedEvents.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasMore && resultEvents.length > 0) {
      const last = resultEvents[resultEvents.length - 1];
      nextCursor = TimelineService.encodeCursor(new Date(last.occurredAt), last.id);
    }

    const durationMs = Date.now() - startTime;

    return {
      version: 1,
      events: resultEvents,
      nextCursor,
      hasMore,
      returnedCount: resultEvents.length,
      totalCount,
      metrics: {
        durationMs,
        providerExecutionTimesMs,
      },
    };
  }
}

export const timelineService = new TimelineService();
