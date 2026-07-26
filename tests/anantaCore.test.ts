import { describe, it, expect, vi } from "vitest";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { Logger } from "../utilities/logger.ts";
import { DocumentUploadProvider } from "../services/providers/DocumentUploadProvider.ts";
import { generatePrintablePrescriptionHtml } from "../utilities/prescriptionFormatter.ts";
import { gatewayAuthMiddleware } from "../platform/gateway.ts";

describe("ANANTA Core Infrastructure (Sprint 1)", () => {
  it("should format OpenTelemetry structured JSON log lines correctly", () => {
    const logger = new Logger("test-service");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Test event logged", { traceId: "trc_123", tenantId: "tenant_456" });

    expect(spy).toHaveBeenCalledTimes(1);
    const logArg = spy.mock.calls[0][0];
    const parsed = JSON.parse(logArg);

    expect(parsed.level).toBe("INFO");
    expect(parsed.message).toBe("Test event logged");
    expect(parsed.traceId).toBe("trc_123");
    expect(parsed.tenantId).toBe("tenant_456");

    spy.mockRestore();
  });

  it("should publish and receive CloudEvents v1.0 domain events over EventBus", async () => {
    const receivedEvents: any[] = [];

    eventBus.subscribe(EVENT_TYPES.DOCUMENT_UPLOADED, (event) => {
      receivedEvents.push(event);
    });

    eventBus.publish({
      eventType: EVENT_TYPES.DOCUMENT_UPLOADED,
      category: "clinical",
      title: "New Document Uploaded",
      message: "Patient uploaded blood test PDF",
      metadata: { documentId: "doc_9912" },
    });

    // Wait for setImmediate dispatch
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventType).toBe("ananta.document.uploaded");
    expect(receivedEvents[0].metadata.documentId).toBe("doc_9912");
  });

  it("should initialize DocumentUploadProvider and check supports query", () => {
    const provider = new DocumentUploadProvider();
    expect(provider.name).toBe("DocumentUploadProvider");
    expect(provider.supports({ patientId: "123", organizationId: "456", category: "all" })).toBe(true);
    expect(provider.supports({ patientId: "123", organizationId: "456", category: "documents" })).toBe(true);
    expect(provider.supports({ patientId: "123", organizationId: "456", category: "lab" })).toBe(true);
    expect(provider.supports({ patientId: "123", organizationId: "456", category: "billing" })).toBe(false);
  });

  it("should format printable prescription HTML for Dr. Rajesh", () => {
    const html = generatePrintablePrescriptionHtml({
      clinicName: "Apollo Clinic Bangalore",
      clinicAddress: "Indiranagar, Bangalore",
      clinicPhone: "+918012345678",
      doctorName: "Dr. Rajesh Sharma",
      doctorSpecialty: "General Medicine & Diabetology",
      doctorLicenseNumber: "KMC-99821",
      patientName: "Ananya Patel",
      patientAge: 36,
      patientGender: "Female",
      encounterDate: "2026-07-25",
      diagnoses: ["Type 2 Diabetes Mellitus"],
      medications: [
        { medicineName: "Metformin XR", dosage: "500mg", frequency: "1-0-1", duration: "30 days", instructions: "Take after meals" },
      ],
    });

    expect(html).toContain("Apollo Clinic Bangalore");
    expect(html).toContain("Dr. Rajesh Sharma");
    expect(html).toContain("Ananya Patel");
    expect(html).toContain("Metformin XR");
    expect(html).toContain("500mg");
  });

  it("should authenticate valid Platform API keys in gatewayAuthMiddleware", async () => {
    const req = {
      headers: { "x-ananta-api-key": "ananta_live_testkey_9921" },
      url: "/api/v1/timeline",
    } as any;
    const reply = {} as any;

    await gatewayAuthMiddleware(req, reply);
    expect(req.gatewayClient).toBeDefined();
    expect(req.gatewayClient.apiKey).toBe("ananta_live_testkey_9921");
    expect(req.gatewayClient.clientId).toBe("dev_partner_001");
  });
});
