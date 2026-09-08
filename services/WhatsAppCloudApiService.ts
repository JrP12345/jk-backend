/**
 * Meta WhatsApp Business Cloud API Client (Graph API v21.0)
 * Handles sending approved WhatsApp templates, request timeouts, retries, and error handling.
 */

export interface MetaWhatsAppMessagePayload {
  to: string; // Recipient E.164 phone number
  templateName: string;
  languageCode?: string;
  parameters: string[]; // Ordered text parameters for {{1}}, {{2}}, etc.
  buttonUrlParam?: string; // Optional dynamic URL suffix for template buttons
  credentials?: {
    phoneNumberId?: string;
    accessToken?: string;
  };
}

export interface MetaWhatsAppDocumentPayload {
  to: string; // Recipient E.164 phone number
  documentUrl: string; // Public HTTPS or relative URL to the PDF document
  filename: string; // Display filename e.g. "Prescription_Dr_Sharma.pdf"
  caption?: string; // Optional message caption
  credentials?: {
    phoneNumberId?: string;
    accessToken?: string;
  };
}

export interface MetaWhatsAppResponse {
  success: boolean;
  providerMessageId?: string;
  status: "sent" | "failed";
  errorReason?: string;
  errorCode?: number;
  rawResponse?: any;
}

export class WhatsAppCloudApiService {
  private defaultApiVersion = "v21.0";
  private timeoutMs = 8000;

  /**
   * Cleans and formats phone numbers to international standard without '+' prefix.
   * Defaults 10-digit numbers to India country code (91).
   */
  public formatPhoneNumber(phone: string): string {
    let cleaned = phone.replace(/\D/g, "");
    if (cleaned.length === 10) {
      cleaned = `91${cleaned}`;
    }
    return cleaned;
  }

  /**
   * Resolves the Meta Cloud API credentials (shared SaaS or dedicated organization).
   */
  private resolveCredentials(customCreds?: { phoneNumberId?: string; accessToken?: string }) {
    const phoneNumberId =
      customCreds?.phoneNumberId ||
      process.env.META_WHATSAPP_PHONE_NUMBER_ID ||
      process.env.WHATSAPP_PHONE_NUMBER_ID;

    const accessToken =
      customCreds?.accessToken ||
      process.env.META_WHATSAPP_ACCESS_TOKEN ||
      process.env.WHATSAPP_ACCESS_TOKEN;

    return { phoneNumberId, accessToken };
  }

  /**
   * Dispatches a pre-approved template message via Meta WhatsApp Cloud API.
   */
  public async sendTemplateMessage(payload: MetaWhatsAppMessagePayload): Promise<MetaWhatsAppResponse> {
    const { phoneNumberId, accessToken } = this.resolveCredentials(payload.credentials);
    const recipientPhone = this.formatPhoneNumber(payload.to);
    const languageCode = payload.languageCode || process.env.META_WHATSAPP_LANG || "en";

    // Build components array for Meta Graph API
    const components: any[] = [];

    if (payload.parameters && payload.parameters.length > 0) {
      components.push({
        type: "body",
        parameters: payload.parameters.map((text) => ({
          type: "text",
          text: String(text ?? "").slice(0, 1024), // Meta max string limit per variable
        })),
      });
    }

    if (payload.buttonUrlParam) {
      components.push({
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [
          {
            type: "text",
            text: payload.buttonUrlParam,
          },
        ],
      });
    }

    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "template",
      template: {
        name: payload.templateName,
        language: {
          code: languageCode,
        },
        components: components.length > 0 ? components : undefined,
      },
    };

    // Sandbox / Development / Test Mock Mode
    const isSandbox =
      process.env.WHATSAPP_SANDBOX_MODE === "true" ||
      !phoneNumberId ||
      !accessToken ||
      process.env.NODE_ENV === "test";

    if (isSandbox) {
      const syntheticWamid = `wamid.HBgM${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      return {
        success: true,
        providerMessageId: syntheticWamid,
        status: "sent",
        rawResponse: {
          messaging_product: "whatsapp",
          contacts: [{ input: recipientPhone, wa_id: recipientPhone }],
          messages: [{ id: syntheticWamid, message_status: "accepted" }],
          mode: "sandbox",
        },
      };
    }

    // Live Meta Graph API Call
    const endpoint = `https://graph.facebook.com/${this.defaultApiVersion}/${phoneNumberId}/messages`;

    let attempts = 0;
    const maxAttempts = 2; // 1 retry on transient network issues

    while (attempts < maxAttempts) {
      attempts++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const data: any = await response.json();

        if (response.ok && data?.messages?.[0]?.id) {
          return {
            success: true,
            providerMessageId: data.messages[0].id,
            status: "sent",
            rawResponse: data,
          };
        }

        // Handle specific Meta error codes
        const metaError = data?.error;
        const errorCode = metaError?.code;
        const errorMessage = metaError?.message || metaError?.error_data?.details || response.statusText;

        // Meta Error 131026: Message undeliverable / user is not on WhatsApp
        if (errorCode === 131026) {
          return {
            success: false,
            status: "failed",
            errorCode,
            errorReason: "RECIPIENT_NOT_ON_WHATSAPP",
            rawResponse: data,
          };
        }

        // Meta Error 130429: Rate limit hit
        if (errorCode === 130429 && attempts < maxAttempts) {
          await new Promise((res) => setTimeout(res, 1000));
          continue;
        }

        return {
          success: false,
          status: "failed",
          errorCode,
          errorReason: `Meta API Error (${errorCode || response.status}): ${errorMessage}`,
          rawResponse: data,
        };
      } catch (err: any) {
        clearTimeout(timeout);
        const isAbort = err.name === "AbortError";
        if (attempts < maxAttempts) {
          await new Promise((res) => setTimeout(res, 800));
          continue;
        }

        return {
          success: false,
          status: "failed",
          errorReason: isAbort ? "Meta API request timed out (8s)" : err.message || "Network error",
        };
      }
    }

    return {
      success: false,
      status: "failed",
      errorReason: "Maximum delivery attempts exceeded",
    };
  }

  /**
   * Sends a freeform conversational text reply (for 24h patient-initiated sessions)
   */
  public async sendFreeformTextMessage(params: {
    to: string;
    text: string;
    credentials?: { phoneNumberId?: string; accessToken?: string };
  }): Promise<MetaWhatsAppResponse> {
    const { phoneNumberId, accessToken } = this.resolveCredentials(params.credentials);
    const recipientPhone = this.formatPhoneNumber(params.to);

    if (!phoneNumberId || !accessToken) {
      return {
        success: true,
        providerMessageId: `mock_text_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        status: "sent",
        rawResponse: { mock: true, text: params.text },
      };
    }

    try {
      const endpoint = `https://graph.facebook.com/${this.defaultApiVersion}/${phoneNumberId}/messages`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipientPhone,
          type: "text",
          text: { preview_url: true, body: params.text },
        }),
      });
      const data: any = await response.json();
      if (response.ok && data?.messages?.[0]?.id) {
        return {
          success: true,
          providerMessageId: data.messages[0].id,
          status: "sent",
          rawResponse: data,
        };
      }
      return {
        success: false,
        status: "failed",
        errorReason: data?.error?.message || "Failed to send text message",
      };
    } catch (err: any) {
      return {
        success: false,
        status: "failed",
        errorReason: err.message || "Network error",
      };
    }
  }

  /**
   * Dispatches a direct document (e.g. PDF prescription, invoice) via Meta WhatsApp Cloud API.
   */
  public async sendDocumentMessage(payload: MetaWhatsAppDocumentPayload): Promise<MetaWhatsAppResponse> {
    const { phoneNumberId, accessToken } = this.resolveCredentials(payload.credentials);
    const recipientPhone = this.formatPhoneNumber(payload.to);

    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "document",
      document: {
        link: payload.documentUrl,
        filename: payload.filename,
        caption: payload.caption || undefined,
      },
    };

    const isSandbox =
      process.env.WHATSAPP_SANDBOX_MODE === "true" ||
      !phoneNumberId ||
      !accessToken ||
      process.env.NODE_ENV === "test";

    if (isSandbox) {
      const syntheticWamid = `wamid.HBgM${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      return {
        success: true,
        providerMessageId: syntheticWamid,
        status: "sent",
        rawResponse: {
          messaging_product: "whatsapp",
          contacts: [{ input: recipientPhone, wa_id: recipientPhone }],
          messages: [{ id: syntheticWamid, message_status: "accepted" }],
          mode: "sandbox",
          documentSent: {
            filename: payload.filename,
            link: payload.documentUrl,
          },
        },
      };
    }

    const endpoint = `https://graph.facebook.com/${this.defaultApiVersion}/${phoneNumberId}/messages`;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const data: any = await response.json();

        if (!response.ok) {
          const errMessage = data?.error?.message || "Unknown Meta Cloud API error";
          const errCode = data?.error?.code || response.status;
          if (response.status >= 500 && attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          return {
            success: false,
            status: "failed",
            errorReason: errMessage,
            errorCode: errCode,
            rawResponse: data,
          };
        }

        const msgId = data?.messages?.[0]?.id;
        return {
          success: true,
          providerMessageId: msgId,
          status: "sent",
          rawResponse: data,
        };
      } catch (err: any) {
        clearTimeout(timeout);
        if (attempts >= maxAttempts) {
          return {
            success: false,
            status: "failed",
            errorReason: err.name === "AbortError" ? "Request timeout to Meta WhatsApp API" : err.message,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return { success: false, status: "failed", errorReason: "Max attempts exceeded" };
  }
}

export const whatsAppCloudApiService = new WhatsAppCloudApiService();
