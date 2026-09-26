import crypto from "node:crypto";
import { getPlatformAccount, type WhatsAppCredentials } from "./WhatsAppAccountService.ts";

export interface MetaWhatsAppMessagePayload {
  to: string;
  templateName: string;
  languageCode?: string;
  parameters: string[];
  buttonUrlParam?: string;
  credentials?: WhatsAppCredentials;
}
export interface MetaWhatsAppDocumentPayload {
  to: string;
  documentUrl: string;
  filename: string;
  caption?: string;
  credentials?: WhatsAppCredentials;
}
export interface MetaWhatsAppResponse {
  success: boolean;
  providerMessageId?: string;
  status: "accepted" | "failed";
  errorReason?: string;
  errorCode?: number;
  rawResponse?: any;
}

export class WhatsAppCloudApiService {
  public formatPhoneNumber(phone: string): string {
    let digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 10) digits = `91${digits}`;
    return digits;
  }

  public async request(path: string, credentials: WhatsAppCredentials, method = "GET", body?: unknown): Promise<any> {
    if (!/^[A-Za-z0-9_/?=&%,.-]+$/.test(path) || path.includes("..")) throw new Error("INVALID_GRAPH_PATH");
    const version = process.env.WHATSAPP_API_VERSION || "v25.0";
    if (!/^v\d+\.\d+$/.test(version)) throw new Error("INVALID_GRAPH_VERSION");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
        method, headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      const data = await response.json() as any;
      if (!response.ok) {
        const error: any = new Error(`META_ERROR_${data?.error?.code || response.status}`);
        error.code = data?.error?.code || response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }

  private async send(to: string, content: Record<string, unknown>, credentials?: WhatsAppCredentials): Promise<MetaWhatsAppResponse> {
    const phone = this.formatPhoneNumber(to);
    if (!/^[1-9]\d{7,14}$/.test(phone)) return { success: false, status: "failed", errorReason: "INVALID_PHONE" };
    const account: any = credentials || await getPlatformAccount();
    if (process.env.NODE_ENV === "test" || (process.env.WHATSAPP_SANDBOX_MODE === "true" && process.env.NODE_ENV !== "production")) {
      return { success: true, status: "accepted", providerMessageId: `wamid.sandbox.${crypto.randomUUID()}`, rawResponse: { mode: "sandbox" } };
    }
    if (account.enabled === false || !account.phoneNumberId || !account.accessToken || !account.appSecret || account.accessToken === "[DECRYPTION_FAILED]" || account.appSecret === "[DECRYPTION_FAILED]") {
      return { success: false, status: "failed", errorReason: "WHATSAPP_NOT_CONFIGURED" };
    }
    try {
      // Never repeat a POST after an uncertain network outcome.
      const data = await this.request(`${account.phoneNumberId}/messages`, account, "POST", {
        messaging_product: "whatsapp", recipient_type: "individual", to: phone, ...content,
      });
      if (!data?.messages?.[0]?.id) return { success: false, status: "failed", errorReason: "AMBIGUOUS_NETWORK" };
      return { success: true, status: "accepted", providerMessageId: data.messages[0].id };
    } catch (error: any) {
      return { success: false, status: "failed", errorCode: error.code,
        errorReason: error.code === 131026 ? "RECIPIENT_NOT_ON_WHATSAPP" : error.code ? `META_ERROR_${error.code}` : "AMBIGUOUS_NETWORK" };
    }
  }

  public sendTemplateMessage(payload: MetaWhatsAppMessagePayload) {
    const components: any[] = [];
    if (payload.parameters.length) components.push({ type: "body", parameters: payload.parameters.map(text => ({ type: "text", text: String(text ?? "").slice(0, 1024) })) });
    if (payload.buttonUrlParam) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: payload.buttonUrlParam }] });
    return this.send(payload.to, { type: "template", template: { name: payload.templateName, language: { code: payload.languageCode || process.env.META_WHATSAPP_LANG || "en" }, components } }, payload.credentials);
  }
  public sendFreeformTextMessage(params: { to: string; text: string; credentials?: WhatsAppCredentials }) {
    return this.send(params.to, { type: "text", text: { preview_url: true, body: params.text.slice(0, 4096) } }, params.credentials);
  }
  public async sendDocumentMessage(payload: MetaWhatsAppDocumentPayload): Promise<MetaWhatsAppResponse> {
    if (!/^https:\/\//i.test(payload.documentUrl) && process.env.NODE_ENV !== "test") {
      return { success: false, status: "failed", errorReason: "DOCUMENT_REQUIRES_PUBLIC_HTTPS" };
    }
    if (process.env.NODE_ENV === "test" || (process.env.WHATSAPP_SANDBOX_MODE === "true" && process.env.NODE_ENV !== "production")) {
      return this.send(payload.to, { type: "document", document: { link: payload.documentUrl, filename: payload.filename, caption: payload.caption } }, payload.credentials);
    }
    const account = payload.credentials || await getPlatformAccount();
    if (!account.phoneNumberId || !account.accessToken || !account.appSecret) return { success: false, status: "failed", errorReason: "WHATSAPP_NOT_CONFIGURED" };
    try {
      const documentUrl = new URL(payload.documentUrl);
      const allowedOrigins = [process.env.PUBLIC_API_BASE_URL, process.env.API_BASE_URL, process.env.R2_CUSTOM_DOMAIN].filter(Boolean).map(value => new URL(value!).origin);
      if (!allowedOrigins.includes(documentUrl.origin)) throw new Error("UNTRUSTED_DOCUMENT_ORIGIN");
      const file = await fetch(documentUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!file.ok || !file.headers.get("content-type")?.includes("application/pdf") || !file.body) throw new Error("INVALID_PDF_RESPONSE");
      const reader = file.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Error("PDF_TOO_LARGE"); }
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("INVALID_PDF");
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("file", new Blob([buffer], { type: "application/pdf" }), payload.filename);
      const version = process.env.WHATSAPP_API_VERSION || "v25.0";
      const uploaded = await fetch(`https://graph.facebook.com/${version}/${account.phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${account.accessToken}` }, body: form, signal: AbortSignal.timeout(15_000) });
      const media = await uploaded.json() as any;
      if (!uploaded.ok || !media.id) throw new Error("MEDIA_UPLOAD_FAILED");
      return this.send(payload.to, { type: "document", document: { id: media.id, filename: payload.filename, caption: payload.caption } }, account);
    } catch {
      return { success: false, status: "failed", errorReason: "MEDIA_UPLOAD_FAILED" };
    }
  }
}
export const whatsAppCloudApiService = new WhatsAppCloudApiService();
