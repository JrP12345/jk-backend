import { describe, it, expect, beforeAll, vi } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { NotificationLog } from "../models/NotificationLog.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { SmsWhatsAppService } from "../services/SmsWhatsAppService.ts";
import { outboundMessageDeliveryWorker } from "../services/OutboundMessageDeliveryWorker.ts";
import { enqueueTransactionalEmail, enqueueWhatsAppDocument, enqueueWhatsAppFreeform } from "../services/CommunicationOutbox.ts";
import { whatsAppCloudApiService } from "../services/WhatsAppCloudApiService.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

describe("Meta WhatsApp Business & Credit Management Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let testPatientId: string;
  const testPhone = "919876543210";
  const testAppointmentId = `apt_test_${Date.now()}`;

  beforeAll(async () => {
    // 1. Bootstrap Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `WhatsApp Health Center ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Operations Admin",
        admin_email: `wa_admin_${Date.now()}@health.com`,
        admin_password: "Password123",
        plan: "pro",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // Create a test patient
    const patient = await Patient.create({
      organizationId: orgId,
      name: "Ramesh Sharma",
      phone: testPhone,
      email: "ramesh@example.com",
      gender: "male",
      dob: "1982-01-01",
    });
    testPatientId = patient._id.toString();
  });

  it("1. should fetch initial WhatsApp configuration with default quotas and packs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/organization/whatsapp",
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.mode).toBe("shared");
    expect(body.data.creditsBalance).toBeGreaterThanOrEqual(500);
    expect(body.data.monthlyQuota).toBeGreaterThanOrEqual(500);
    expect(body.data.availablePacks).toHaveLength(3);
    expect(body.data.availablePacks[0].id).toBe("bronze");
    expect(body.data.availablePacks[1].id).toBe("silver");
    expect(body.data.availablePacks[2].id).toBe("gold");
  });

  it("derives WhatsApp configuration scope from membership and rejects a cross-tenant query", async () => {
    const otherOrganization = await Organization.create({
      name: `Other WhatsApp Tenant ${Date.now()}`,
      city: "Pune",
      email: `other-wa-${Date.now()}@health.test`,
      whatsappConfig: { mode: "dedicated", creditsBalance: 77 },
    });

    const crossTenantQuery = await app.inject({
      method: "GET",
      url: `/api/organization/whatsapp?organizationId=${otherOrganization._id}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(crossTenantQuery.statusCode).toBe(403);

    // A forged legacy header is ignored. The response remains the caller's
    // organization rather than the target tenant's distinct credit balance.
    const forgedHeader = await app.inject({
      method: "GET",
      url: "/api/organization/whatsapp",
      headers: {
        cookie: adminCookies.join("; "),
        "x-organization-id": otherOrganization._id.toString(),
      },
    });
    expect(forgedHeader.statusCode).toBe(200);
    expect(JSON.parse(forgedHeader.body).data.creditsBalance).not.toBe(77);
  });

  it("2. persists a PHI-minimized booking delivery before the worker deducts a credit and creates NotificationLog", async () => {
    // Reset initial credits to exactly 100 for clear arithmetic
    await Organization.updateOne(
      { _id: orgId },
      { $set: { "whatsappConfig.creditsBalance": 100 } }
    );

    const sendRes = await SmsWhatsAppService.sendBookingConfirmation(
      testAppointmentId,
      orgId,
      testPhone,
      {
        patientName: "Ramesh Sharma",
        tokenNumber: 12,
        doctorName: "Dr. Ananya Roy",
        date: "2026-09-07",
        time: "10:30 AM",
        trackingUrl: `https://app.ananthealth.com/track/${testAppointmentId}`,
      }
    );

    expect(sendRes.success).toBe(true);
    expect(sendRes.status).toBe("pending");
    expect(sendRes.creditsDeducted).toBe(0);

    const outboxKey = `whatsapp_${testAppointmentId}_BOOKING_CONFIRMATION`;
    const queued = await OutboundMessage.findOne({ idempotencyKey: outboxKey }).lean();
    expect(queued?.kind).toBe("communication_template");
    expect(queued?.status).toBe("pending");
    expect((queued as any)?.payload.phone).toBeUndefined();
    expect((queued as any)?.sensitivePayloadCiphertext).toBeUndefined();

    // The API does not debit credits or call Meta. Only the worker does so.
    expect((await Organization.findById(orgId))?.whatsappConfig?.creditsBalance).toBe(100);
    expect(await NotificationLog.exists({ idempotencyKey: outboxKey })).toBeFalsy();

    await outboundMessageDeliveryWorker.processBatch();

    const updatedOrg = await Organization.findById(orgId);
    expect(updatedOrg?.whatsappConfig?.creditsBalance).toBe(99);

    // Verify NotificationLog record
    const log = await NotificationLog.findOne({
      idempotencyKey: outboxKey,
    });
    expect(log).not.toBeNull();
    expect(log?.creditsDeducted).toBe(1);
    expect(log?.channel).toBe("whatsapp");
    expect(log?.status).toBe("accepted");
    expect(log?.recipientPhone).toBe(testPhone);
  });

  it("3. should prevent duplicate sends and credit deductions via idempotency guard", async () => {
    const initialOrg = await Organization.findById(orgId);
    const initialBalance = initialOrg?.whatsappConfig?.creditsBalance || 0;

    // Retry sending exact same notification for the same appointment
    const duplicateRes = await SmsWhatsAppService.sendBookingConfirmation(
      testAppointmentId,
      orgId,
      testPhone,
      {
        patientName: "Ramesh Sharma",
        tokenNumber: 12,
        doctorName: "Dr. Ananya Roy",
        date: "2026-09-07",
        time: "10:30 AM",
        trackingUrl: `https://app.ananthealth.com/track/${testAppointmentId}`,
      }
    );

    expect(duplicateRes.success).toBe(true);
    expect(duplicateRes.creditsDeducted).toBe(0); // Zero additional deduction!

    // Verify balance was NOT touched
    const afterOrg = await Organization.findById(orgId);
    expect(afterOrg?.whatsappConfig?.creditsBalance).toBe(initialBalance);
  });

  it("persists WhatsApp documents and two-way replies before the worker calls Meta", async () => {
    const documentSpy = vi.spyOn(whatsAppCloudApiService, "sendDocumentMessage").mockResolvedValue({
      success: true,
      status: "accepted",
      providerMessageId: "wamid.document-outbox-test",
    });
    const replySpy = vi.spyOn(whatsAppCloudApiService, "sendFreeformTextMessage").mockResolvedValue({
      success: true,
      status: "accepted",
      providerMessageId: "wamid.reply-outbox-test",
    });

    try {
      const documentKey = `whatsapp-document:test:${Date.now()}`;
      const replyKey = `whatsapp-freeform:test:${Date.now()}`;
      await enqueueWhatsAppDocument({
        to: testPhone,
        documentUrl: "https://example.test/private-prescription.pdf?capability=secret",
        filename: "Prescription.pdf",
        caption: "Private prescription",
        idempotencyKey: documentKey,
      });
      await enqueueWhatsAppFreeform({
        to: testPhone,
        text: "Private clinical reply",
        organizationId: orgId,
        recipientName: "Ramesh Sharma",
        idempotencyKey: replyKey,
      });

      const storedDocument = await OutboundMessage.findOne({ idempotencyKey: documentKey }).lean();
      expect(storedDocument?.status).toBe("pending");
      expect((storedDocument as any)?.payload.documentUrl).toBeUndefined();
      expect((storedDocument as any)?.sensitivePayloadCiphertext).toBeUndefined();

      await outboundMessageDeliveryWorker.processBatch();

      expect(documentSpy).toHaveBeenCalledOnce();
      expect(replySpy).toHaveBeenCalledOnce();
      expect((await OutboundMessage.findOne({ idempotencyKey: documentKey }))?.status).toBe("sent");
      expect((await OutboundMessage.findOne({ idempotencyKey: replyKey }))?.status).toBe("sent");
      expect(await NotificationLog.exists({ idempotencyKey: `outbound:${replyKey}` })).toBeTruthy();
    } finally {
      documentSpy.mockRestore();
      replySpy.mockRestore();
    }
  });

  it("persists transactional email encrypted and dispatches it only from the worker", async () => {
    const emailSpy = vi.spyOn(emailProvider, "sendEmail").mockResolvedValue(true);
    const idempotencyKey = `transactional-email:test:${Date.now()}`;

    try {
      await enqueueTransactionalEmail({
        to: "private-recipient@example.test",
        subject: "Private clinical update",
        text: "Sensitive appointment details",
        html: "<p>Sensitive appointment details</p>",
        idempotencyKey,
      });
      // A retry from the producer does not add a second durable delivery.
      await enqueueTransactionalEmail({
        to: "private-recipient@example.test",
        subject: "Private clinical update",
        text: "Sensitive appointment details",
        html: "<p>Sensitive appointment details</p>",
        idempotencyKey,
      });

      const queued = await OutboundMessage.findOne({ idempotencyKey }).lean();
      expect(queued?.kind).toBe("transactional_email");
      expect(queued?.status).toBe("pending");
      expect((queued as any)?.payload.to).toBeUndefined();
      expect((queued as any)?.payload.subject).toBeUndefined();
      expect((queued as any)?.sensitivePayloadCiphertext).toBeUndefined();
      expect(await OutboundMessage.countDocuments({ idempotencyKey })).toBe(1);
      expect(emailSpy).not.toHaveBeenCalled();

      await outboundMessageDeliveryWorker.processBatch();

      expect(emailSpy).toHaveBeenCalledOnce();
      expect((await OutboundMessage.findOne({ idempotencyKey }))?.status).toBe("sent");
    } finally {
      emailSpy.mockRestore();
    }
  });

  it("4. should gracefully fall back without error when credits are completely exhausted (Zero Disruption)", async () => {
    // Set credits to 0
    await Organization.updateOne(
      { _id: orgId },
      { $set: { "whatsappConfig.creditsBalance": 0 } }
    );

    const exhaustedAptId = `apt_exhausted_${Date.now()}`;
    const result = await SmsWhatsAppService.sendBookingConfirmation(
      exhaustedAptId,
      orgId,
      testPhone,
      {
        patientName: "Ramesh Sharma",
        tokenNumber: 15,
        doctorName: "Dr. Ananya Roy",
        date: "2026-09-07",
        time: "11:00 AM",
        trackingUrl: `https://app.ananthealth.com/track/${exhaustedAptId}`,
      }
    );

    // API acceptance remains non-blocking; the worker records the terminal,
    // non-retryable credit failure without affecting the booking flow.
    expect(result.success).toBe(true);
    expect(result.status).toBe("pending");
    await outboundMessageDeliveryWorker.processBatch();

    // Balance remains 0 (never negative)
    const org = await Organization.findById(orgId);
    expect(org?.whatsappConfig?.creditsBalance).toBe(0);

    // Verify failure log was recorded
    const log = await NotificationLog.findOne({
      idempotencyKey: `whatsapp_${exhaustedAptId}_BOOKING_CONFIRMATION`,
    });
    expect(log).not.toBeNull();
    expect(log?.status).toBe("failed");
    expect(log?.creditsDeducted).toBe(0);
    expect((await OutboundMessage.findOne({ idempotencyKey: `whatsapp_${exhaustedAptId}_BOOKING_CONFIRMATION` }))?.status).toBe("failed");
  });

  it("5. should top-up Bronze pack (+1,000 credits) and generate SaaSInvoice", async () => {
    const topUpRes = await app.inject({
      method: "POST",
      url: "/api/organization/whatsapp/top-up",
      headers: { cookie: adminCookies.join("; ") },
      payload: { pack: "bronze" },
    });

    expect(topUpRes.statusCode).toBe(201);
    const body = JSON.parse(topUpRes.body);
    expect(body.success).toBe(true);
    expect(body.data.creditsAdded).toBe(1000);
    expect(body.data.newCreditsBalance).toBe(1000);

    // Verify Organization balance and prepaid credits
    const org = await Organization.findById(orgId);
    expect(org?.whatsappConfig?.creditsBalance).toBe(1000);
    expect(org?.whatsappConfig?.prepaidCredits).toBe(1000);

    // Verify SaaSInvoice
    const invoice = await SaaSInvoice.findOne({ invoiceNumber: body.data.invoiceNumber });
    expect(invoice).toBeDefined();
    expect(invoice?.totalAmount).toBe(200);
    expect(invoice?.currency).toBe("INR");
    expect(invoice?.status).toBe("paid");
  });

  it("6. should verify Meta Webhook GET challenge", async () => {
    process.env.META_WHATSAPP_VERIFY_TOKEN = "test_meta_webhook_token_123";
    process.env.WHATSAPP_VERIFY_TOKEN = "test_meta_webhook_token_123";

    const challenge = "9988776655";
    const res = await app.inject({
      method: "GET",
      url: `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test_meta_webhook_token_123&hub.challenge=${challenge}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(challenge);
  });

  it("7. should process Meta Webhook delivery status update to 'delivered'", async () => {
    // Create a mock log with metaMessageId
    const testMetaId = `wamid.HBgM${Date.now()}`;
    const log = await NotificationLog.create({
      organizationId: orgId,
      recipientPhone: testPhone,
      channel: "whatsapp",
      providerMessageId: testMetaId,
      metaMessageId: testMetaId,
      templateId: "BOOKING_CONFIRMATION",
      messageContent: "Test confirmation message",
      idempotencyKey: `whatsapp_webhook_test_${Date.now()}`,
      status: "sent",
      creditsDeducted: 1,
    });

    const statusPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "109283746592019",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550123456",
                  phone_number_id: "104928374650192",
                },
                statuses: [
                  {
                    id: testMetaId,
                    status: "delivered",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: testPhone,
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const webhookRes = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      payload: statusPayload,
    });

    expect(webhookRes.statusCode).toBe(200);
    const resBody = JSON.parse(webhookRes.body);
    expect(resBody.success).toBe(true);

    // Verify NotificationLog status was updated to delivered
    const updatedLog = await NotificationLog.findById(log._id);
    expect(updatedLog?.status).toBe("delivered");
  });

  it("8. should process inbound STOP opt-out compliance", async () => {
    const inboundStopPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "109283746592019",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550123456",
                  phone_number_id: "104928374650192",
                },
                messages: [
                  {
                    from: testPhone,
                    id: `wamid.inbound_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: {
                      body: "STOP",
                    },
                    type: "text",
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const stopRes = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      payload: inboundStopPayload,
    });

    expect(stopRes.statusCode).toBe(200);

    // Verify Patient record has optOutWhatsApp set to true
    const patient = await Patient.findById(testPatientId);
    expect(patient?.optOutWhatsApp).toBe(true);

    // Future notifications to this patient must now be blocked
    const blockedAptId = `apt_blocked_${Date.now()}`;
    const blockedResult = await SmsWhatsAppService.sendBookingConfirmation(
      blockedAptId,
      orgId,
      testPhone,
      {
        patientName: "Ramesh Sharma",
        tokenNumber: 22,
        doctorName: "Dr. Ananya Roy",
        date: "2026-09-07",
        time: "12:00 PM",
        trackingUrl: `https://app.ananthealth.com/track/${blockedAptId}`,
      }
    );

    expect(blockedResult.success).toBe(true);
    expect(blockedResult.status).toBe("pending");
    await outboundMessageDeliveryWorker.processBatch();
    const blockedLog = await NotificationLog.findOne({
      idempotencyKey: `whatsapp_${blockedAptId}_BOOKING_CONFIRMATION`,
    });
    expect(blockedLog?.errorReason).toBe("PATIENT_OPTED_OUT_WHATSAPP");
    expect((await OutboundMessage.findOne({ idempotencyKey: `whatsapp_${blockedAptId}_BOOKING_CONFIRMATION` }))?.status).toBe("failed");
  });
});
