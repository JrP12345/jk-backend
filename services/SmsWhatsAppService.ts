import { NotificationLog } from "../models/NotificationLog.ts";

export interface SendMessageOptions {
  organizationId?: string;
  phone: string;
  patientName?: string;
  channel?: "sms" | "whatsapp";
  templateId: "BOOKING_CONFIRMATION" | "APPOINTMENT_REMINDER" | "LAB_RESULTS_READY" | "BILLING_RECEIPT";
  variables: Record<string, string>;
}

export async function sendSmsWhatsAppNotification(options: SendMessageOptions): Promise<any> {
  const channel = options.channel || "whatsapp";
  const phone = options.phone.trim();

  let messageContent = "";

  switch (options.templateId) {
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

  // No SMS/WhatsApp provider is configured in the current implementation.
  // Record the failed delivery explicitly instead of reporting a simulated send.
  const log = await NotificationLog.create({
    organizationId: options.organizationId,
    recipientPhone: phone,
    recipientName: options.patientName || options.variables.patientName,
    channel,
    templateId: options.templateId,
    messageContent,
    status: "failed",
    errorReason: "SMS/WhatsApp provider is not configured",
  });

  return log;
}
