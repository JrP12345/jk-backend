import { Patient } from "../models/Patient.ts";
import { WhatsAppRecipient } from "../models/WhatsAppRecipient.ts";
import { WhatsAppTemplate } from "../models/WhatsAppTemplate.ts";
import { computeBlindIndex } from "../utilities/encryption.ts";
import { whatsAppCloudApiService } from "./WhatsAppCloudApiService.ts";

export function phoneHash(phone: string) { return computeBlindIndex(whatsAppCloudApiService.formatPhoneNumber(phone)); }
export async function assertWhatsAppConsent(account: any, phone: string) {
  const digits = whatsAppCloudApiService.formatPhoneNumber(phone);
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new Error("INVALID_PHONE");
  const recipient = await WhatsAppRecipient.findOne({ scope: account.scope, phoneHash: phoneHash(phone) });
  if (recipient?.optedOut) throw new Error("PATIENT_OPTED_OUT_WHATSAPP");
  const patient = await Patient.findOne({
    ...(account.organizationId ? { organizationId: account.organizationId } : {}),
    phone: { $in: [digits, `+${digits}`, digits.startsWith("91") ? digits.slice(2) : digits] }, optOutWhatsApp: true,
  });
  if (patient) throw new Error("PATIENT_OPTED_OUT_WHATSAPP");
  return !!recipient?.lastInboundAt && Date.now() - recipient.lastInboundAt.getTime() < 86400_000;
}
export async function assertApprovedTemplate(account: any, name: string, language: string, parameterCount?: number) {
  if (process.env.NODE_ENV === "test" || (process.env.WHATSAPP_SANDBOX_MODE === "true" && process.env.NODE_ENV !== "production")) return;
  const template = await WhatsAppTemplate.findOne({ scope: account.scope, name, language, status: "APPROVED" });
  if (!template) throw new Error("TEMPLATES_NOT_READY");
  const body = (template.components as any[])?.find(component => component.type === "BODY");
  if (body?.text && parameterCount !== undefined) {
    const variables = new Set((body.text.match(/\{\{\d+\}\}/g) || []));
    if (variables.size !== parameterCount) throw new Error("TEMPLATE_PARAMETER_MISMATCH");
  }
}
export function isPermanentWhatsAppFailure(reason?: string) {
  return !!reason && (["AMBIGUOUS_NETWORK", "INVALID_PHONE", "WHATSAPP_NOT_CONFIGURED", "ORGANIZATION_NOT_FOUND", "PATIENT_OPTED_OUT_WHATSAPP", "WHATSAPP_DISABLED_FOR_ORGANIZATION", "TEMPLATES_NOT_READY", "TEMPLATE_PARAMETER_MISMATCH", "SESSION_WINDOW_CLOSED", "DOCUMENT_REQUIRES_PUBLIC_HTTPS", "RECIPIENT_NOT_ON_WHATSAPP"].includes(reason)
    || (reason.startsWith("META_ERROR_") && !/^META_ERROR_(429|5\d\d|130429|131000|131056|80007)$/.test(reason)));
}
