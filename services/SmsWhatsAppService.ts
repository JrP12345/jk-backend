import { NotificationLog } from "../models/NotificationLog.ts";

export interface SendMessageOptions {
  organizationId?: string;
  phone: string;
  patientName?: string;
  channel?: "sms" | "whatsapp";
  templateId: "OTP_VERIFICATION" | "BOOKING_CONFIRMATION" | "APPOINTMENT_REMINDER" | "LAB_RESULTS_READY" | "BILLING_RECEIPT";
  variables: Record<string, string>;
}

export async function sendSmsWhatsAppNotification(options: SendMessageOptions): Promise<any> {
  const channel = options.channel || "whatsapp";
  const phone = options.phone.trim();

  let messageContent = "";

  switch (options.templateId) {
    case "OTP_VERIFICATION":
      messageContent = `Your ANANTA verification code is ${options.variables.otpCode}. Valid for 5 minutes. Do not share this code with anyone.`;
      break;

    case "BOOKING_CONFIRMATION":
      messageContent = `Dear ${options.variables.patientName || "Patient"}, your appointment with Dr. ${options.variables.doctorName} at ${options.variables.clinicName} is confirmed for ${options.variables.appointmentTime}. Queue Token: #${options.variables.tokenNumber}.`;
      break;

    case "APPOINTMENT_REMINDER":
      messageContent = `Reminder: You have an upcoming appointment with Dr. ${options.variables.doctorName} at ${options.variables.clinicName} tomorrow at ${options.variables.appointmentTime}.`;
      break;

    case "LAB_RESULTS_READY":
      messageContent = `Dear ${options.variables.patientName || "Patient"}, your diagnostic lab test results for ${options.variables.testName} are now ready to view on your patient portal.`;
      break;

    case "BILLING_RECEIPT":
      messageContent = `Dear ${options.variables.patientName || "Patient"}, invoice #${options.variables.invoiceNumber} for ₹${options.variables.amount} has been processed successfully. Thank you.`;
      break;

    default:
      messageContent = `HealthOS Notification: ${JSON.stringify(options.variables)}`;
  }

  const smsProvider = process.env.SMS_PROVIDER || "console";
  const msg91AuthKey = process.env.MSG91_AUTH_KEY || process.env.SMS_PROVIDER_API_KEY;
  const msg91TemplateId = process.env.MSG91_OTP_TEMPLATE_ID || process.env.SMS_TEMPLATE_ID;

  if (smsProvider === "msg91" && msg91AuthKey) {
    try {
      let recipientMobile = phone.replace(/\D/g, "");
      if (recipientMobile.length === 10) {
        recipientMobile = `91${recipientMobile}`;
      }

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

      const log = await NotificationLog.create({
        organizationId: options.organizationId,
        recipientPhone: phone,
        recipientName: options.patientName || options.variables.patientName,
        channel: "sms",
        templateId: options.templateId,
        messageContent,
        status: isSuccess ? "sent" : "failed",
        errorReason: isSuccess ? undefined : JSON.stringify(responseData),
      });

      return log;
    } catch (err: any) {
      console.error("[MSG91 SMS Error]:", err);
      const log = await NotificationLog.create({
        organizationId: options.organizationId,
        recipientPhone: phone,
        recipientName: options.patientName || options.variables.patientName,
        channel: "sms",
        templateId: options.templateId,
        messageContent,
        status: "failed",
        errorReason: err.message || "MSG91 HTTP dispatch error",
      });
      return log;
    }
  }

  // Development / Console Fallback mode
  const log = await NotificationLog.create({
    organizationId: options.organizationId,
    recipientPhone: phone,
    recipientName: options.patientName || options.variables.patientName,
    channel,
    templateId: options.templateId,
    messageContent,
    status: smsProvider === "console" ? "sent" : "failed",
    errorReason: smsProvider === "console" ? undefined : "SMS/WhatsApp provider is not configured",
  });

  return log;
}
