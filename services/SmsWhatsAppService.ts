import { NotificationLog } from "../models/NotificationLog.ts";
import crypto from "node:crypto";
import { Organization } from "../models/Organization.ts";
import { UsageRecord } from "../models/UsageRecord.ts";
import { Appointment } from "../models/Appointment.ts";
import { issueAppointmentTrackerLink } from "../utilities/publicTracker.ts";
import { whatsAppCloudApiService } from "./WhatsAppCloudApiService.ts";
import { enqueueCommunicationTemplate } from "./CommunicationOutbox.ts";
import { resolveWhatsAppAccount, recordWhatsAppCredentialError } from "./WhatsAppAccountService.ts";
import { assertWhatsAppConsent, assertApprovedTemplate } from "./WhatsAppSendPolicy.ts";
import { claimWhatsAppIntent } from "./WhatsAppLedger.ts";

export type SupportedTemplateId =
  | "OTP_VERIFICATION"
  | "BOOKING_CONFIRMATION"
  | "APPOINTMENT_REMINDER"
  | "APPOINTMENT_CANCELLED"
  | "CONSULTATION_COMPLETED"
  | "QUEUE_UPDATE"
  | "LAB_RESULTS_READY"
  | "BILLING_RECEIPT"
  | "DOCTOR_DISRUPTION"
  | "DISRUPTION_TRANSFER"
  | "DISRUPTION_REFUND_CONFIRMATION"
  | "QUEUE_DELAY_ALERT";

export interface SendMessageOptions {
  organizationId?: string;
  appointmentId?: string;
  phone: string;
  patientName?: string;
  channel?: "sms" | "whatsapp";
  templateId: SupportedTemplateId;
  variables: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * Accepted delivery API for application code. Clinical communications are
 * persisted first; only OTP delivery remains immediate because its five-minute
 * authentication window requires the low-latency auth path.
 */
export async function sendSmsWhatsAppNotification(options: SendMessageOptions): Promise<any> {
  if (options.templateId === "OTP_VERIFICATION") {
    return dispatchSmsWhatsAppNotification(options);
  }

  const queued = await enqueueCommunicationTemplate(options);
  const record = (queued as any).toObject ? (queued as any).toObject() : queued;
  return {
    ...record,
    isDuplicate: record.status !== "pending",
    creditsDeducted: 0,
  };
}

/** Provider-only dispatch. This must only be called by the outbound worker. */
export async function dispatchSmsWhatsAppNotification(options: SendMessageOptions): Promise<any> {
  const channel = options.channel || "whatsapp";
  const phone = options.phone.trim();
  const appointmentId = options.appointmentId;
  const templateId = options.templateId;

  // ───────────────────────────────────────────────────────────────────────────
  // 1. WhatsApp Channel Processing (Meta Cloud API & Credit System)
  // ───────────────────────────────────────────────────────────────────────────
  if (channel === "whatsapp") {
    const key = options.idempotencyKey || (appointmentId ? `whatsapp_${appointmentId}_${templateId}` : `immediate:${crypto.randomUUID()}`);
    const existing = await NotificationLog.findOne({ idempotencyKey: key });
    if (existing && ["accepted", "sent", "delivered", "read"].includes(existing.status)) return { ...existing.toObject(), isDuplicate: true, creditsDeducted: 0 };
    if (existing?.status === "sending" || existing?.errorReason === "AMBIGUOUS_NETWORK") throw new Error("AMBIGUOUS_NETWORK");
    const fields = { organizationId: options.organizationId, recipientPhone: phone, recipientName: options.patientName,
      channel: "whatsapp", templateId, messageContent: "[WhatsApp notification]" };
    const suppress = (reason: string) => NotificationLog.findOneAndUpdate({ idempotencyKey: key },
      { $set: { ...fields, status: "failed", errorReason: reason } }, { upsert: true, returnDocument: "after" });
    const org = options.organizationId ? await Organization.findById(options.organizationId) : null;
    if (org?.whatsappConfig?.mode === "disabled") return suppress("WHATSAPP_DISABLED_FOR_ORGANIZATION");
    const toggles: Partial<Record<SupportedTemplateId, string>> = {
      BOOKING_CONFIRMATION: "sendBookingConfirmation", CONSULTATION_COMPLETED: "sendConsultationComplete",
      APPOINTMENT_CANCELLED: "sendAppointmentCancellation", QUEUE_UPDATE: "sendTurnApproaching", QUEUE_DELAY_ALERT: "sendQueueDelayAlert",
      DOCTOR_DISRUPTION: "sendDisruptionAlert", DISRUPTION_TRANSFER: "sendDisruptionAlert", DISRUPTION_REFUND_CONFIRMATION: "sendDisruptionAlert",
    };
    if (toggles[templateId] && (org?.whatsappConfig?.notifications as any)?.[toggles[templateId]!] === false) return null;
    let account: any;
    let windowOpen: boolean;
    const { templateName, parameters, messageContent } = buildMetaTemplateParams(options);
    const language = process.env.META_WHATSAPP_LANG || "en";
    try {
      account = await resolveWhatsAppAccount(options.organizationId);
      windowOpen = await assertWhatsAppConsent(account, phone);
      if (!windowOpen || templateId === "OTP_VERIFICATION") await assertApprovedTemplate(account, templateName, language, parameters.length);
    } catch (error: any) { return suppress(error.message); }
    const claim = await claimWhatsAppIntent(key, fields);
    if (!claim.claimed) return { ...claim.log!.toObject(), isDuplicate: true, creditsDeducted: 0 };
    const intent = claim.log!;
    let charged = false;
    if (org?.whatsappConfig?.mode === "shared") {
      const reserved = await Organization.updateOne({ _id: org._id, "whatsappConfig.creditsBalance": { $gte: 1 } },
        { $inc: { "whatsappConfig.creditsBalance": -1, "whatsappConfig.creditsUsedThisMonth": 1 } });
      if (!reserved.modifiedCount) return suppress("INSUFFICIENT_CREDITS");
      charged = true;
    }
    const sendTemplate = () => whatsAppCloudApiService.sendTemplateMessage({
      to: phone, templateName, parameters, languageCode: language, credentials: account,
      ...(templateId === "OTP_VERIFICATION" ? { buttonUrlParam: options.variables.otpCode } : {}),
    });
    let response = windowOpen && templateId !== "OTP_VERIFICATION"
      ? await whatsAppCloudApiService.sendFreeformTextMessage({ to: phone, text: messageContent, credentials: account })
      : await sendTemplate();
    if (!response.success && [131047, 131051].includes(response.errorCode || 0)) {
      try { await assertApprovedTemplate(account, templateName, language, parameters.length); response = await sendTemplate(); }
      catch { response = { success: false, status: "failed", errorReason: "TEMPLATES_NOT_READY" }; }
    }
    await recordWhatsAppCredentialError(account, response.errorCode);
    const log = await NotificationLog.findByIdAndUpdate(intent._id, { $set: {
      status: response.status, providerMessageId: response.providerMessageId, metaMessageId: response.providerMessageId,
      errorReason: response.errorReason, creditsDeducted: charged && (response.success || response.errorReason === "AMBIGUOUS_NETWORK") ? 1 : 0,
    } }, { returnDocument: "after" });
    if (!response.success && response.errorReason !== "AMBIGUOUS_NETWORK" && charged) {
      await Organization.updateOne({ _id: org!._id }, { $inc: { "whatsappConfig.creditsBalance": 1, "whatsappConfig.creditsUsedThisMonth": -1 } });
    }
    if (options.organizationId) await UsageRecord.findOneAndUpdate({ organizationId: options.organizationId },
      { $inc: { [response.success ? "whatsappSentCount" : "whatsappFailedCount"]: 1 } }, { upsert: true });
    return log;
  }

  const messageContent = buildPlainMessageContent(options);
  const smsProvider = process.env.SMS_PROVIDER || "console";
  const msg91AuthKey = process.env.MSG91_AUTH_KEY || process.env.SMS_PROVIDER_API_KEY;
  const msg91TemplateId = process.env.MSG91_OTP_TEMPLATE_ID || process.env.SMS_TEMPLATE_ID;

  if (smsProvider === "msg91" && msg91AuthKey) {
    try {
      const recipientMobile = whatsAppCloudApiService.formatPhoneNumber(phone);
      const res = await fetch("https://control.msg91.com/api/v5/otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "authkey": msg91AuthKey,
        },
        body: JSON.stringify({
          template_id: msg91TemplateId || undefined,
          mobile: recipientMobile,
          otp: options.variables.otpCode,
        }),
      });

      const responseData: any = await res.json();
      const isSuccess = res.ok && responseData.type === "success";

      return await NotificationLog.create({
        organizationId: options.organizationId,
        recipientPhone: phone,
        recipientName: options.patientName || options.variables.patientName,
        channel: "sms",
        templateId,
        messageContent,
        status: isSuccess ? "sent" : "failed",
        errorReason: isSuccess ? undefined : JSON.stringify(responseData),
      });
    } catch (err: any) {
      console.error("[MSG91 SMS Error]:", err);
      return await NotificationLog.create({
        organizationId: options.organizationId,
        recipientPhone: phone,
        recipientName: options.patientName || options.variables.patientName,
        channel: "sms",
        templateId,
        messageContent,
        status: "failed",
        errorReason: err.message || "MSG91 HTTP dispatch error",
      });
    }
  }

  // Development / Console Fallback mode
  return await NotificationLog.create({
    organizationId: options.organizationId,
    recipientPhone: phone,
    recipientName: options.patientName || options.variables.patientName,
    channel: "sms",
    templateId,
    messageContent,
    status: smsProvider === "console" ? "sent" : "failed",
    errorReason: smsProvider === "console" ? undefined : "SMS provider is not configured",
  });
}

async function issueTrackerUrlForAppointment(appointmentId: string): Promise<string> {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) return "";
  const { url } = await issueAppointmentTrackerLink(appointment as any);
  return url;
}

/**
 * Maps templateId and variables to Meta WhatsApp template format
 */
export function buildMetaTemplateParams(options: SendMessageOptions) {
  const v = options.variables;
  const patientName = options.patientName || v.patientName || "Patient";

  switch (options.templateId) {
    case "OTP_VERIFICATION":
      return { templateName: process.env.META_WHATSAPP_OTP_TEMPLATE || "otp_verification", parameters: [v.otpCode || ""], messageContent: "Your verification code is " + (v.otpCode || "") };
    case "LAB_RESULTS_READY":
      return { templateName: process.env.META_WHATSAPP_LAB_TEMPLATE || "lab_results_ready", parameters: [patientName, v.testName || "Lab test", v.trackingUrl || ""], messageContent: `Your ${v.testName || "lab"} results are ready. ${v.trackingUrl || ""}` };
    case "BILLING_RECEIPT":
      return { templateName: process.env.META_WHATSAPP_RECEIPT_TEMPLATE || "billing_receipt", parameters: [patientName, v.invoiceNumber || "", v.amount || "0", v.trackingUrl || ""], messageContent: `Payment received for invoice ${v.invoiceNumber}. Amount: ${v.amount}. ${v.trackingUrl || ""}` };
    case "QUEUE_DELAY_ALERT":
      return { templateName: process.env.META_WHATSAPP_DELAY_TEMPLATE || "queue_delay_alert", parameters: [patientName, v.doctorName || "Doctor", v.delayMinutes || "15", v.trackingUrl || v.trackerUrl || ""], messageContent: `Your visit with Dr. ${v.doctorName} is delayed by approximately ${v.delayMinutes || "15"} minutes. ${v.trackingUrl || v.trackerUrl || ""}` };
    case "BOOKING_CONFIRMATION":
      return {
        templateName: process.env.META_WHATSAPP_BOOKING_TEMPLATE || "appointment_booking_confirmation",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.clinicName || "Clinic",
          v.appointmentTime || "Today",
          v.tokenNumber || "1",
          v.trackingUrl || "",
        ],
        messageContent: `Appointment confirmed with Dr. ${v.doctorName} at ${v.clinicName} for ${v.appointmentTime}. Token #${v.tokenNumber}. Track live: ${v.trackingUrl}`,
      };

    case "CONSULTATION_COMPLETED":
      return {
        templateName: process.env.META_WHATSAPP_COMPLETED_TEMPLATE || "consultation_completed",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.clinicName || "Clinic",
          v.tokenNumber || "1",
          v.trackingUrl || "",
        ],
        messageContent: `Your consultation with Dr. ${v.doctorName} is complete. Your prescription and bill are ready at: ${v.trackingUrl}`,
      };

    case "QUEUE_UPDATE":
      return {
        templateName: process.env.META_WHATSAPP_QUEUE_TEMPLATE || "queue_turn_approaching",
        parameters: [
          patientName,
          v.tokenNumber || "1",
          v.peopleAhead || "1",
          v.doctorName || "Doctor",
          v.trackingUrl || "",
        ],
        messageContent: `Token #${v.tokenNumber}: Only ${v.peopleAhead} patient(s) ahead of you for Dr. ${v.doctorName}. Live tracker: ${v.trackingUrl}`,
      };

    case "APPOINTMENT_CANCELLED":
      return {
        templateName: process.env.META_WHATSAPP_CANCELLED_TEMPLATE || "appointment_cancelled",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.clinicName || "Clinic",
          v.appointmentTime || "Today",
        ],
        messageContent: `Appointment for ${patientName} with Dr. ${v.doctorName} at ${v.clinicName} scheduled for ${v.appointmentTime} has been cancelled.`,
      };

    case "APPOINTMENT_REMINDER":
      return {
        templateName: process.env.META_WHATSAPP_REMINDER_TEMPLATE || "appointment_reminder",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.clinicName || "Clinic",
          v.appointmentTime || "Tomorrow",
        ],
        messageContent: `Reminder: Appointment with Dr. ${v.doctorName} at ${v.clinicName} tomorrow at ${v.appointmentTime}.`,
      };

    case "DOCTOR_DISRUPTION":
      return {
        templateName: process.env.META_WHATSAPP_DISRUPTION_TEMPLATE || "doctor_disruption_alert",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.clinicName || "Clinic",
          v.appointmentTime || "Today",
          v.rescheduleUrl || "",
          v.cancelUrl || "",
        ],
        messageContent: `Important: Dr. ${v.doctorName} at ${v.clinicName} is unavailable on ${v.appointmentTime}. Choose: Reschedule: ${v.rescheduleUrl} | Cancel & Refund: ${v.cancelUrl}`,
      };

    case "DISRUPTION_TRANSFER":
      return {
        templateName: process.env.META_WHATSAPP_TRANSFER_TEMPLATE || "appointment_transfer_alert",
        parameters: [
          patientName,
          v.originalDoctorName || "Original Doctor",
          v.newDoctorName || "Doctor",
          v.clinicName || "Clinic",
          v.tokenNumber || "1",
          v.trackingUrl || "",
        ],
        messageContent: `Appointment update: Transferred from Dr. ${v.originalDoctorName} to Dr. ${v.newDoctorName} at ${v.clinicName}. Token #${v.tokenNumber}. Track live: ${v.trackingUrl}`,
      };

    case "DISRUPTION_REFUND_CONFIRMATION":
      return {
        templateName: process.env.META_WHATSAPP_REFUND_TEMPLATE || "appointment_refund_confirmation",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.clinicName || "Clinic",
          v.refundAmount || "0",
          v.refundId || "",
        ],
        messageContent: `Refund confirmed: ₹${v.refundAmount} initiated for cancelled appointment with Dr. ${v.doctorName} at ${v.clinicName} (Ref: ${v.refundId}).`,
      };

    default:
      return {
        templateName: "general_notification",
        parameters: [patientName, JSON.stringify(v)],
        messageContent: `Notification for ${patientName}: ${JSON.stringify(v)}`,
      };
  }
}

/**
 * Builds plain text for SMS and fallback logs
 */
function buildPlainMessageContent(options: SendMessageOptions): string {
  const v = options.variables;
  switch (options.templateId) {
    case "OTP_VERIFICATION":
      return v.purpose === "record_access" ? `Your ANANTA approval code is ${v.otpCode}. Share it with your clinician only if you agree to let them view your medical history from other organizations for 10 minutes. This code expires in 5 minutes.` : `Your ANANTA verification code is ${v.otpCode}. Valid for 5 minutes.`;
    case "BOOKING_CONFIRMATION":
      return `Appointment with Dr. ${v.doctorName} at ${v.clinicName} confirmed for ${v.appointmentTime}. Token #${v.tokenNumber}.`;
    case "APPOINTMENT_REMINDER":
      return `Reminder: Appointment with Dr. ${v.doctorName} at ${v.clinicName} on ${v.appointmentTime}.`;
    case "DOCTOR_DISRUPTION":
      return `Important: Dr. ${v.doctorName} is unavailable on ${v.appointmentTime}. Reschedule: ${v.rescheduleUrl} | Cancel & Refund: ${v.cancelUrl}`;
    case "DISRUPTION_TRANSFER":
      return `Appointment at ${v.clinicName} transferred to Dr. ${v.newDoctorName}. Token #${v.tokenNumber}. Track: ${v.trackingUrl}`;
    case "DISRUPTION_REFUND_CONFIRMATION":
      return `Refund of ₹${v.refundAmount} initiated for cancelled appointment with Dr. ${v.doctorName}. Ref: ${v.refundId}`;
    case "LAB_RESULTS_READY":
      return `Lab test results for ${v.testName} are now ready on your patient portal.`;
    case "BILLING_RECEIPT":
      return `Invoice #${v.invoiceNumber} for ₹${v.amount} processed successfully.`;
    default:
      return `Notification: ${JSON.stringify(v)}`;
  }
}

export const SmsWhatsAppService = {
  sendSmsWhatsAppNotification,
  dispatchSmsWhatsAppNotification,

  async sendBookingConfirmation(
    appointmentId: string,
    organizationId: string,
    phone: string,
    params: {
      patientName?: string;
      tokenNumber: number | string;
      doctorName: string;
      clinicName?: string;
      date?: string;
      time?: string;
      appointmentTime?: string;
      trackingUrl?: string;
    }
  ) {
    const trackingUrl = params.trackingUrl || await issueTrackerUrlForAppointment(appointmentId);
    const log = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId,
      phone,
      patientName: params.patientName,
      channel: "whatsapp",
      templateId: "BOOKING_CONFIRMATION",
      variables: {
        patientName: params.patientName || "Patient",
        tokenNumber: String(params.tokenNumber),
        doctorName: params.doctorName,
        clinicName: params.clinicName || "Clinic",
        appointmentTime:
          params.appointmentTime ||
          `${params.date || ""} ${params.time || ""}`.trim() ||
          "Today",
        trackingUrl,
      },
    });

    const isSuccess =
      log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" ||
      log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
    return {
      success: isSuccess,
      log,
      creditsDeducted: (log as any)?.isDuplicate ? 0 : (log?.creditsDeducted ?? 0),
      isDuplicate: !!(log as any)?.isDuplicate,
      errorReason: log?.errorReason,
      status: log?.status,
    };
  },

  async sendConsultationCompleted(
    appointmentId: string,
    organizationId: string,
    phone: string,
    params: {
      patientName?: string;
      doctorName: string;
      prescriptionUrl?: string;
      invoiceAmount?: number | string;
      paymentStatus?: string;
      paymentUrl?: string;
    }
  ) {
    const trackerUrl = await issueTrackerUrlForAppointment(appointmentId);
    const prescriptionUrl = params.prescriptionUrl || trackerUrl;
    const paymentUrl = params.paymentUrl || trackerUrl;
    const log = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId,
      phone,
      patientName: params.patientName,
      channel: "whatsapp",
      templateId: "CONSULTATION_COMPLETED",
      variables: {
        patientName: params.patientName || "Patient",
        doctorName: params.doctorName,
        prescriptionUrl,
        invoiceAmount: String(params.invoiceAmount || "0"),
        paymentStatus: params.paymentStatus || "Paid",
        paymentUrl,
      },
    });

    const isSuccess =
      log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" ||
      log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
    return {
      success: isSuccess,
      log,
      creditsDeducted: (log as any)?.isDuplicate ? 0 : (log?.creditsDeducted ?? 0),
      isDuplicate: !!(log as any)?.isDuplicate,
      errorReason: log?.errorReason,
      status: log?.status,
    };
  },

  async sendDisruptionAlert(
    appointmentId: string,
    organizationId: string,
    phone: string,
    params: {
      patientName?: string;
      doctorName: string;
      clinicName?: string;
      appointmentTime?: string;
      rescheduleUrl: string;
      cancelUrl: string;
      actionDeadlineMinutes?: number | string;
      trackingUrl?: string;
    }
  ) {
    const trackingUrl = params.trackingUrl || await issueTrackerUrlForAppointment(appointmentId);
    const log = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId,
      phone,
      patientName: params.patientName,
      channel: "whatsapp",
      templateId: "DOCTOR_DISRUPTION",
      variables: {
        patientName: params.patientName || "Patient",
        doctorName: params.doctorName,
        clinicName: params.clinicName || "Clinic",
        appointmentTime: params.appointmentTime || "Today",
        rescheduleUrl: params.rescheduleUrl,
        cancelUrl: params.cancelUrl,
        actionDeadlineMinutes: String(params.actionDeadlineMinutes || 60),
      },
    });

    const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" ||
      log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
    return {
      success: isSuccess,
      log,
      creditsDeducted: (log as any)?.isDuplicate ? 0 : (log?.creditsDeducted ?? 0),
      isDuplicate: !!(log as any)?.isDuplicate,
      errorReason: log?.errorReason,
      status: log?.status,
    };
  },

  async sendDisruptionTransferAlert(
    appointmentId: string,
    organizationId: string,
    phone: string,
    params: {
      patientName?: string;
      originalDoctorName: string;
      newDoctorName: string;
      clinicName?: string;
      tokenNumber: number | string;
      trackingUrl?: string;
    }
  ) {
    const trackingUrl = params.trackingUrl || await issueTrackerUrlForAppointment(appointmentId);
    const log = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId,
      phone,
      patientName: params.patientName,
      channel: "whatsapp",
      templateId: "DISRUPTION_TRANSFER",
      variables: {
        patientName: params.patientName || "Patient",
        originalDoctorName: params.originalDoctorName,
        newDoctorName: params.newDoctorName,
        clinicName: params.clinicName || "Clinic",
        tokenNumber: String(params.tokenNumber),
        trackingUrl,
      },
    });

    const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" ||
      log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
    return {
      success: isSuccess,
      log,
      creditsDeducted: (log as any)?.isDuplicate ? 0 : (log?.creditsDeducted ?? 0),
      isDuplicate: !!(log as any)?.isDuplicate,
      errorReason: log?.errorReason,
      status: log?.status,
    };
  },

  async sendDisruptionRefundAlert(
    appointmentId: string,
    organizationId: string,
    phone: string,
    params: {
      patientName?: string;
      doctorName: string;
      clinicName?: string;
      refundAmount: number | string;
      refundId: string;
    }
  ) {
    const log = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId,
      phone,
      patientName: params.patientName,
      channel: "whatsapp",
      templateId: "DISRUPTION_REFUND_CONFIRMATION",
      variables: {
        patientName: params.patientName || "Patient",
        doctorName: params.doctorName,
        clinicName: params.clinicName || "Clinic",
        refundAmount: String(params.refundAmount),
        refundId: params.refundId,
      },
    });

    const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" ||
      log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
    return {
      success: isSuccess,
      log,
      creditsDeducted: (log as any)?.isDuplicate ? 0 : (log?.creditsDeducted ?? 0),
      isDuplicate: !!(log as any)?.isDuplicate,
      errorReason: log?.errorReason,
      status: log?.status,
    };
  },

  async sendQueueDelayAlert(
    appointmentId: string,
    organizationId: string,
    phone: string,
    params: {
      patientName?: string;
      doctorName: string;
      clinicName?: string;
      delayMinutes: number | string;
      revisedArrivalTime: string;
      trackerUrl: string;
    }
  ) {
    const log = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId,
      phone,
      patientName: params.patientName,
      channel: "whatsapp",
      templateId: "QUEUE_DELAY_ALERT",
      variables: {
        patientName: params.patientName || "Patient",
        doctorName: params.doctorName,
        clinicName: params.clinicName || "Clinic",
        delayMinutes: String(params.delayMinutes),
        revisedArrivalTime: params.revisedArrivalTime,
        trackerUrl: params.trackerUrl,
      },
    });

    const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" ||
      log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
    return {
      success: isSuccess,
      log,
      creditsDeducted: (log as any)?.isDuplicate ? 0 : (log?.creditsDeducted ?? 0),
      isDuplicate: !!(log as any)?.isDuplicate,
      errorReason: log?.errorReason,
      status: log?.status,
    };
  },
};
