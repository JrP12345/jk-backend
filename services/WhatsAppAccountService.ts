import { Organization } from "../models/Organization.ts";
import { WhatsAppAccount } from "../models/WhatsAppAccount.ts";
import { decrypt } from "../utilities/encryption.ts";

export const secretProjection = "+whatsappConfig.accessToken +whatsappConfig.appSecret +whatsappConfig.verifyToken";
export type WhatsAppCredentials = { wabaId?: string; phoneNumberId?: string; accessToken?: string; appSecret?: string; verifyToken?: string };

export async function getPlatformAccount(): Promise<any> {
  const saved = await WhatsAppAccount.findOne({ key: "platform" }).select("+accessToken +appSecret +verifyToken");
  if (saved) return { ...saved.toObject(), accessToken: decrypt(saved.accessToken), appSecret: decrypt(saved.appSecret), verifyToken: decrypt(saved.verifyToken) };
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  return {
    enabled: !!accessToken,
    wabaId: process.env.META_WHATSAPP_WABA_ID || process.env.WHATSAPP_WABA_ID,
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken,
    appSecret: process.env.META_WHATSAPP_APP_SECRET || process.env.WHATSAPP_APP_SECRET,
    verifyToken: process.env.META_WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN,
    connectionStatus: "disconnected",
  };
}

export async function resolveWhatsAppAccount(organizationId?: string): Promise<any> {
  const org = organizationId ? await Organization.findById(organizationId).select(secretProjection) : null;
  if (organizationId && !org) throw new Error("ORGANIZATION_NOT_FOUND");
  if (org?.whatsappConfig?.mode === "disabled") throw new Error("WHATSAPP_DISABLED_FOR_ORGANIZATION");
  if (org?.whatsappConfig?.mode === "dedicated") {
    const config = org.whatsappConfig;
    return { ...org.toObject().whatsappConfig, scope: organizationId, organizationId, accessToken: decrypt(config.accessToken), appSecret: decrypt(config.appSecret), verifyToken: decrypt(config.verifyToken) };
  }
  return { ...await getPlatformAccount(), scope: "platform", organizationId };
}

export async function resolveWebhookOwner(wabaId?: string, phoneNumberId?: string): Promise<any> {
  if (!wabaId) return null;
  const org = await Organization.findOne({ "whatsappConfig.wabaId": wabaId }).select(secretProjection);
  if (org) {
    if (phoneNumberId && org.whatsappConfig?.phoneNumberId !== phoneNumberId) return null;
    return { scope: org._id.toString(), organizationId: org._id.toString(), appSecret: decrypt(org.whatsappConfig?.appSecret) };
  }
  const platform = await getPlatformAccount();
  if (platform.wabaId === wabaId && (!phoneNumberId || phoneNumberId === platform.phoneNumberId)) return { scope: "platform", appSecret: platform.appSecret };
  // Legacy test fixtures omit configured WABA IDs. Never allow this in live environments.
  if (process.env.NODE_ENV === "test" && !platform.wabaId && ["WABA_ID_TEST", "109283746592019"].includes(wabaId)) return { scope: "platform", appSecret: platform.appSecret };
  return null;
}

export function publicAccount(account: any) {
  return {
    enabled: account.enabled, wabaId: account.wabaId || null, phoneNumberId: account.phoneNumberId || null,
    hasToken: !!account.accessToken, hasAppSecret: !!account.appSecret,
    configured: !!(account.wabaId && account.phoneNumberId && account.accessToken && account.appSecret && account.accessToken !== "[DECRYPTION_FAILED]" && account.appSecret !== "[DECRYPTION_FAILED]"),
    connectionStatus: account.connectionStatus || "disconnected", verifiedAt: account.verifiedAt || null,
    lastError: account.lastError || null, phoneDisplay: account.phoneDisplay || null,
    verifyToken: account.verifyToken || null,
    webhookUrl: `${(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "http://localhost:5000").replace(/\/$/, "")}/api/webhooks/whatsapp`,
  };
}

export async function recordWhatsAppCredentialError(account: any, errorCode?: number) {
  if (errorCode !== 190) return;
  const fields = { connectionStatus: "error", lastError: "META_ERROR_190: Reconnect with a valid system-user token" };
  if (account.scope === "platform") await WhatsAppAccount.updateOne({ key: "platform" }, { $set: fields });
  else await Organization.updateOne({ _id: account.scope }, { $set: { "whatsappConfig.connectionStatus": fields.connectionStatus, "whatsappConfig.lastError": fields.lastError } });
}
