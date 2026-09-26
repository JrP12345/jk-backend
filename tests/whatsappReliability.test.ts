import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { NotificationLog } from "../models/NotificationLog.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { WhatsAppWebhookInbox } from "../models/WhatsAppWebhookInbox.ts";
import { WhatsAppRecipient } from "../models/WhatsAppRecipient.ts";
import { WhatsAppTemplate } from "../models/WhatsAppTemplate.ts";
import { UsageRecord } from "../models/UsageRecord.ts";
import { dispatchSmsWhatsAppNotification } from "../services/SmsWhatsAppService.ts";
import { whatsAppCloudApiService } from "../services/WhatsAppCloudApiService.ts";
import { resolveWhatsAppAccount } from "../services/WhatsAppAccountService.ts";
import { assertApprovedTemplate, assertWhatsAppConsent, phoneHash } from "../services/WhatsAppSendPolicy.ts";
import { enqueueWhatsAppFreeform } from "../services/CommunicationOutbox.ts";
import { outboundMessageDeliveryWorker } from "../services/OutboundMessageDeliveryWorker.ts";
import { whatsAppWebhookWorker } from "../services/WhatsAppWebhookService.ts";

describe("WhatsApp setup, isolation and durable delivery", () => {
  let organizationId: string;
  let cookie: string;
  const secret = "test-only-meta-app-secret";
  const phone = "919876510001";
  const wabaId = "100001";
  const phoneNumberId = "200001";
  beforeAll(async () => {
    const response = await app.inject({ method: "POST", url: "/api/onboarding/organization", payload: {
      org_name: "WhatsApp Reliability Clinic", city: "Mumbai", admin_name: "Admin",
      admin_email: `wa-reliability-${Date.now()}@example.com`, admin_password: "Password123", plan: "pro",
    } });
    expect(response.statusCode).toBe(201);
    cookie = (response.headers["set-cookie"] as string[]).map(row => row.split(";")[0]).join("; ");
    organizationId = response.json().data.organization.id;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const signed = (payload: any, appSecret = secret) => ({
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", appSecret).update(JSON.stringify(payload)).digest("hex")}`,
  });
  const inbound = (id: string, text: string, accountId = wabaId) => ({ object: "whatsapp_business_account", entry: [{ id: accountId, changes: [{ field: "messages", value: {
    metadata: { phone_number_id: phoneNumberId }, messages: [{ id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] });

  it("saves encrypted credentials, preserves blank secrets and exposes only readiness flags", async () => {
    const saved = await app.inject({ method: "PATCH", url: "/api/organization/whatsapp", headers: { cookie }, payload: {
      mode: "dedicated", wabaId, phoneNumberId, accessToken: "test-access-token", appSecret: secret,
    } });
    expect(saved.statusCode).toBe(200);
    const raw = await Organization.collection.findOne({ _id: (await Organization.findById(organizationId))!._id });
    expect(raw!.whatsappConfig.accessToken).toMatch(/^enc:v1:/);
    expect(raw!.whatsappConfig.appSecret).toMatch(/^enc:v1:/);
    const firstToken = raw!.whatsappConfig.accessToken;
    await app.inject({ method: "PATCH", url: "/api/organization/whatsapp", headers: { cookie }, payload: { accessToken: "", appSecret: "" } });
    const rawAfter = await Organization.collection.findOne({ _id: raw!._id });
    expect(rawAfter!.whatsappConfig.accessToken).toBe(firstToken);
    const config = await app.inject({ method: "GET", url: "/api/organization/whatsapp", headers: { cookie } });
    expect(config.body).not.toContain(secret);
    expect(config.body).not.toContain("test-access-token");
    expect(config.json().data.connection).toMatchObject({ configured: true, connectionStatus: "pending", hasToken: true, hasAppSecret: true });
    expect(config.json().data.connection.verifyToken).toMatch(/^ananta_/);
  });
  it("denies tenant users access to root settings and rejects WABA reuse", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/whatsapp", headers: { cookie } })).statusCode).toBe(403);
    const other = await Organization.create({ name: "Other account", city: "Pune", whatsappConfig: { wabaId: "100002" } });
    const clash = await app.inject({ method: "PATCH", url: "/api/organization/whatsapp", headers: { cookie }, payload: { wabaId: "100002" } });
    expect(clash.statusCode).toBe(409);
    expect((await Organization.findById(other._id))?.whatsappConfig?.wabaId).toBe("100002");
  });
  it("verifies phone ownership and syncs every template page", async () => {
    const graph = vi.spyOn(whatsAppCloudApiService, "request")
      .mockResolvedValueOnce({ data: [{ id: phoneNumberId, display_phone_number: "+91 90000 00000" }] })
      .mockResolvedValueOnce({ data: [{ id: "t1", name: "appointment_booking_confirmation", language: "en", status: "APPROVED", category: "UTILITY" }], paging: { next: "ignored", cursors: { after: "page2" } } })
      .mockResolvedValueOnce({ data: [{ id: "t2", name: "document_ready", language: "en", status: "APPROVED", category: "UTILITY" }] });
    expect((await app.inject({ method: "POST", url: "/api/organization/whatsapp/test", headers: { cookie }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/organization/whatsapp/templates/sync", headers: { cookie }, payload: {} })).statusCode).toBe(200);
    expect(graph).toHaveBeenCalledTimes(3);
    expect(await WhatsAppTemplate.countDocuments({ scope: organizationId })).toBe(2);
  });
  it("acknowledges signed events before processing, dedupes by message ID and strips payloads", async () => {
    const payload = inbound("inbound-stop-1", "STOP ALL!");
    vi.stubEnv("NODE_ENV", "development");
    const first = await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", headers: signed(payload), payload });
    expect(first.statusCode).toBe(200);
    expect(await WhatsAppRecipient.findOne({ scope: organizationId, phoneHash: phoneHash(phone) })).toBeNull();
    payload.entry[0].changes[0].value.messages[0].timestamp = "100";
    await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", headers: signed(payload), payload });
    expect(await WhatsAppWebhookInbox.countDocuments({ scope: organizationId })).toBe(1);
    vi.stubEnv("NODE_ENV", "test");
    await whatsAppWebhookWorker.processBatch();
    const row = await WhatsAppWebhookInbox.findOne({ scope: organizationId }).select("+payloadCiphertext");
    expect(row?.status).toBe("done");
    expect(row?.payloadCiphertext).toBeUndefined();
    const account = await resolveWhatsAppAccount(organizationId);
    await expect(assertWhatsAppConsent(account, phone)).rejects.toThrow("PATIENT_OPTED_OUT_WHATSAPP");
  });
  it("rejects forged events, drops unknown WABAs and permits explicit START", async () => {
    const payload = inbound("inbound-start-1", "START");
    const forged = await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", payload });
    expect(forged.statusCode).toBe(401);
    const unknown = inbound("unknown-1", "STOP", "999999");
    const countBefore = await WhatsAppWebhookInbox.countDocuments();
    await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", headers: signed(unknown), payload: unknown });
    expect(await WhatsAppWebhookInbox.countDocuments()).toBe(countBefore);
    await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", headers: signed(payload), payload });
    expect((await WhatsAppRecipient.findOne({ scope: organizationId, phoneHash: phoneHash(phone) }))?.optedOut).toBe(false);
  });
  it("keeps statuses forward-only and does not double-count delivered callbacks", async () => {
    const log = await NotificationLog.create({ organizationId, recipientPhone: phone, channel: "whatsapp", templateId: "TEST", messageContent: "private body", status: "accepted", metaMessageId: "wamid.status-test" });
    const send = async (status: string) => {
      const payload = { object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: "wamid.status-test", status, timestamp: "1790000000" }] } }] }] };
      await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", headers: signed(payload), payload });
    };
    await send("delivered"); await send("delivered");
    expect((await UsageRecord.findOne({ organizationId }))?.whatsappDeliveredCount).toBe(1);
    await send("read"); await send("sent"); await send("failed");
    expect((await NotificationLog.findById(log._id))?.status).toBe("read");
    expect((await NotificationLog.collection.findOne({ _id: log._id }))!.messageContent).not.toBe("private body");
  });
  it("buffers a status arriving before its ledger row", async () => {
    const payload = { object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: "wamid.orphan", status: "delivered", timestamp: "1790000001" }] } }] }] };
    await app.inject({ method: "POST", url: "/api/webhooks/whatsapp", headers: signed(payload), payload });
    const pending = await WhatsAppWebhookInbox.findOne({ error: "ORPHAN_STATUS" });
    expect(pending?.status).toBe("pending");
    await NotificationLog.create({ organizationId, recipientPhone: phone, channel: "whatsapp", templateId: "TEST", messageContent: "notice", status: "accepted", metaMessageId: "wamid.orphan" });
    await WhatsAppWebhookInbox.updateOne({ _id: pending!._id }, { $set: { nextAttemptAt: new Date(0) } });
    await whatsAppWebhookWorker.processBatch();
    expect((await NotificationLog.findOne({ metaMessageId: "wamid.orphan" }))?.status).toBe("delivered");
  });
  it("prevents duplicate sends and charges under concurrent dispatch", async () => {
    await Organization.updateOne({ _id: organizationId }, { $set: { "whatsappConfig.mode": "shared", "whatsappConfig.creditsBalance": 10 } });
    const provider = vi.spyOn(whatsAppCloudApiService, "sendTemplateMessage").mockResolvedValue({ success: true, status: "accepted", providerMessageId: "wamid.concurrent" });
    const options = { organizationId, phone, templateId: "BOOKING_CONFIRMATION" as const, variables: {}, idempotencyKey: "concurrent-send" };
    await Promise.allSettled([dispatchSmsWhatsAppNotification(options), dispatchSmsWhatsAppNotification(options)]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await Organization.findById(organizationId))?.whatsappConfig?.creditsBalance).toBe(9);
  });
  it("never retries an ambiguous provider result, including manual job replay", async () => {
    const provider = vi.spyOn(whatsAppCloudApiService, "sendFreeformTextMessage").mockResolvedValue({ success: false, status: "failed", errorReason: "AMBIGUOUS_NETWORK" });
    const queued = await enqueueWhatsAppFreeform({ to: phone, organizationId, text: "A reply", idempotencyKey: "ambiguous-reply" });
    await outboundMessageDeliveryWorker.processBatch(20);
    expect((await OutboundMessage.findById(queued._id))?.status).toBe("failed");
    await OutboundMessage.updateOne({ _id: queued._id }, { $set: { status: "pending", nextAttemptAt: new Date(0) } });
    await outboundMessageDeliveryWorker.processBatch(20);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("enforces expired session windows and approved template state outside sandbox", async () => {
    const account = { scope: organizationId, organizationId };
    await WhatsAppRecipient.updateOne({ scope: organizationId, phoneHash: phoneHash(phone) }, { $set: { lastInboundAt: new Date(Date.now() - 86400_001), optedOut: false } });
    expect(await assertWhatsAppConsent(account, phone)).toBe(false);
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("WHATSAPP_SANDBOX_MODE", "false");
    await WhatsAppTemplate.updateOne({ scope: organizationId, name: "document_ready" }, { $set: { status: "PAUSED" } });
    await expect(assertApprovedTemplate(account, "document_ready", "en")).rejects.toThrow("TEMPLATES_NOT_READY");
  });
  it("makes one POST attempt on network failure and fails when live credentials are missing", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("WHATSAPP_SANDBOX_MODE", "false");
    const fetchMock = vi.fn().mockRejectedValue(new Error("network unavailable")); vi.stubGlobal("fetch", fetchMock);
    const result = await whatsAppCloudApiService.sendTemplateMessage({ to: phone, templateName: "test", parameters: [], credentials: { phoneNumberId, accessToken: "token", appSecret: secret } });
    expect(result.errorReason).toBe("AMBIGUOUS_NETWORK"); expect(fetchMock).toHaveBeenCalledTimes(1);
    const missing = await whatsAppCloudApiService.sendTemplateMessage({ to: phone, templateName: "test", parameters: [], credentials: {} });
    expect(missing.errorReason).toBe("WHATSAPP_NOT_CONFIGURED"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("uploads a verified PDF and sends its media ID instead of a URL", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("WHATSAPP_SANDBOX_MODE", "false"); vi.stubEnv("PUBLIC_API_BASE_URL", "https://api.example.com");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("%PDF-1.4\nTest file", { headers: { "content-type": "application/pdf" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-test" }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.pdf" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await whatsAppCloudApiService.sendDocumentMessage({ to: phone, filename: "rx.pdf", documentUrl: "https://api.example.com/rx.pdf", credentials: { phoneNumberId, accessToken: "token", appSecret: secret } });
    expect(result.status).toBe("accepted");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.document).toMatchObject({ id: "media-test", filename: "rx.pdf" });
    expect(body.document.link).toBeUndefined();
  });
  it("scopes health logs to the clinic and limits daily totals to today", async () => {
    const yesterday = new Date(Date.now() - 2 * 86400_000);
    await NotificationLog.create({ organizationId, recipientPhone: phone, channel: "whatsapp", templateId: "OLD", messageContent: "old notice", status: "delivered", createdAt: yesterday });
    const other = await Organization.findOne({ name: "Other account" });
    await NotificationLog.create({ organizationId: other!._id, recipientPhone: "919999999999", channel: "whatsapp", templateId: "OTHER_TENANT", messageContent: "private other body", status: "sent" });
    const response = await app.inject({ method: "GET", url: "/api/organization/whatsapp/health", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(response.body).not.toContain("OTHER_TENANT");
    expect(response.body).not.toContain("private other body");
    expect(data.messages.every((row: any) => row.recipientPhone.startsWith("••••"))).toBe(true);
    expect(data.today.reduce((total: number, row: any) => total + row.count, 0)).toBe(await NotificationLog.countDocuments({ organizationId, channel: "whatsapp" }) - 1);
  });
  it("fails unsafe/non-PDF downloads before contacting the message endpoint", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("WHATSAPP_SANDBOX_MODE", "false"); vi.stubEnv("PUBLIC_API_BASE_URL", "https://api.example.com");
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>print</html>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    const credentials = { phoneNumberId, accessToken: "token", appSecret: secret };
    expect((await whatsAppCloudApiService.sendDocumentMessage({ to: phone, filename: "rx.pdf", documentUrl: "https://untrusted.example.com/rx.pdf", credentials })).errorReason).toBe("MEDIA_UPLOAD_FAILED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await whatsAppCloudApiService.sendDocumentMessage({ to: phone, filename: "rx.pdf", documentUrl: "https://api.example.com/rx.pdf", credentials })).errorReason).toBe("MEDIA_UPLOAD_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
