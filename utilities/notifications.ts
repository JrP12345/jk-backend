import { Appointment } from "../models/Appointment.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { enqueueTransactionalEmail } from "../services/CommunicationOutbox.ts";
import { appendTrackerCapability, hashTrackerCapability, issueAppointmentTrackerLink } from "./publicTracker.ts";

/**
 * Dispatches existing booking notifications through the configured notification channels.
 */
export async function sendBookingNotification(appointmentId: any, actionType: "booked" | "cancelled" | "rescheduled", trackerToken?: string) {
  try {
    const appt: any = await Appointment.findById(appointmentId)
      .populate("clinicId", "name email phone city organizationId")
      .populate("doctorId", "name email")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!appt) {
      console.warn(`[Notification Warning] Appointment ${appointmentId} not found`);
      return;
    }

    let targetUserId = appt.patientId?.userId?._id?.toString() || appt.patientId?.userId?.id || appt.patientId?.userId || appt.bookedByUserId?.toString();
    let patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    let patientEmail = appt.patientId?.email || appt.patientId?.userId?.email;
    let patientPhone = appt.patientId?.phone || appt.patientId?.userId?.phone;

    // If patient has no contact info & no linked userId, look up guardian FamilyRelationship
    if (!targetUserId || (!patientEmail && !patientPhone)) {
      const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
      const familyRel: any = await FamilyRelationship.findOne({
        patientId: appt.patientId?._id || appt.patientId,
        status: "active",
      }).populate("userId", "name email phone");

      if (familyRel?.userId) {
        targetUserId = familyRel.userId._id?.toString();
        if (!patientEmail) patientEmail = familyRel.userId.email;
        if (!patientPhone) patientPhone = familyRel.userId.phone;
      }
    }

    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Clinic Location";
    const token = appt.tokenNumber;
    const time = new Date(appt.appointmentTime).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });

    let trackingUrl = `/track/${appt._id}`;
    let capability = trackerToken;
    if (capability && actionType !== "cancelled") {
      appt.trackerTokenHash = hashTrackerCapability(capability);
      appt.trackerTokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      await appt.save();
      trackingUrl = `/track/${appt._id}?t=${encodeURIComponent(capability)}`;
    } else if (actionType !== "cancelled") {
      const issued = await issueAppointmentTrackerLink(appt);
      capability = issued.token;
      trackingUrl = issued.url;
    }

    if (targetUserId) {
      await eventBus.publishDurable({
        eventType: actionType === "booked" ? EVENT_TYPES.PATIENT_APPOINTMENT_BOOKED : EVENT_TYPES.PATIENT_APPOINTMENT_CANCELLED,
        category: "patient",
        targetUserId: targetUserId.toString(),
        title: actionType === "booked" ? `Appointment Confirmed (#${token})` : `Appointment Cancelled`,
        message: actionType === "booked"
          ? `Appointment for ${patientName} with Dr. ${doctorName} at ${clinicName} confirmed for ${time}. Token: #${token}. Track live queue: ${trackingUrl}`
          : `Appointment for ${patientName} with Dr. ${doctorName} at ${clinicName} scheduled for ${time} has been cancelled.`,
        severity: actionType === "booked" ? "success" : "warning",
        actionUrl: actionType === "booked" ? trackingUrl : "/dashboard/appointments",
        metadata: { appointmentId, clinicName, doctorName, token, time, trackingUrl },
      });
    }

    if (patientEmail) {
      const subject = actionType === "booked"
        ? `Appointment Confirmed - Token #${token} at ${clinicName}`
        : `Appointment Cancelled - ${clinicName}`;
      const body = actionType === "booked"
        ? `Hello ${patientName},\n\nYour appointment booking with Dr. ${doctorName} at ${clinicName} is confirmed for ${time}.\n\nYour assigned daily queue token is #${token}.\n\nYou can track your live queue position in real-time here:\n${trackingUrl}\n\nPlease scan the reception QR code or check in via the tracker when you arrive.\n\nBest regards,\nAnant Health Desk`
        : `Hello ${patientName},\n\nThis is to inform you that your appointment with Dr. ${doctorName} at ${clinicName} scheduled for ${time} has been cancelled.\n\nIf you believe this is an error, please contact clinic reception.\n\nBest regards,\nAnant Health Desk`;

      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:booking:${appt._id}:${actionType}`,
      });
    }

    if (patientPhone) {
      const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
      sendSmsWhatsAppNotification({
        organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString() || appointmentId?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: actionType === "booked" ? "BOOKING_CONFIRMATION" : (actionType === "cancelled" ? "APPOINTMENT_CANCELLED" : "APPOINTMENT_REMINDER"),
        variables: {
          patientName,
          doctorName,
          clinicName,
          appointmentTime: time,
          tokenNumber: String(token),
          trackingUrl,
        },
      }).catch((err) => console.error("SMS/WhatsApp dispatch failed:", err));
    }
  } catch (err) {
    console.error("sendBookingNotification error:", err);
  }
}

/**
 * Dispatches live turn approaching notification (e.g. 1-2 patients ahead).
 */
export async function sendTurnApproachingNotification(appointmentId: any, peopleAhead: number) {
  try {
    const appt: any = await Appointment.findById(appointmentId)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) return;

    const targetUserId =
      appt.patientId?.userId?._id?.toString() ||
      appt.patientId?.userId?.id ||
      appt.patientId?.userId ||
      appt.bookedByUserId?.toString();
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const doctorName = appt.doctorId?.name || "Doctor";
    const token = appt.tokenNumber;
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);

    if (targetUserId) {
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.PATIENT_CALL_NEXT,
        category: "patient",
        targetUserId: targetUserId.toString(),
        title: `Your Turn is Approaching! (#${token}) 🩺`,
        message: `${peopleAhead <= 1 ? "You are next in line!" : `Only ${peopleAhead} patients ahead.`} Please stay near Dr. ${doctorName}'s room.`,
        severity: "info",
        actionUrl: trackingUrl,
        metadata: { appointmentId, token, peopleAhead, trackingUrl },
      });
    }

    const patientPhone = appt.patientId?.phone || appt.patientId?.userId?.phone;
    if (patientPhone) {
      const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
      sendSmsWhatsAppNotification({
        organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString() || appointmentId?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: "QUEUE_UPDATE",
        variables: {
          patientName,
          tokenNumber: String(token),
          peopleAhead: String(peopleAhead),
          doctorName,
          trackingUrl,
        },
      }).catch((err) => console.error("SMS/WhatsApp turn approaching dispatch failed:", err));
    }
  } catch (err) {
    console.error("sendTurnApproachingNotification error:", err);
  }
}

/**
 * Dispatches post-consultation notification when encounter/appointment is marked completed.
 * Directs patient to their digital prescription and invoice summary.
 */
export async function sendConsultationCompletedNotification(
  appointmentId: any,
  options?: { phone?: string; channel?: "whatsapp" | "sms" }
) {
  try {
    const appt: any = await Appointment.findById(appointmentId)
      .populate("clinicId", "name email phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) return;

    const targetUserId =
      appt.patientId?.userId?._id?.toString() ||
      appt.patientId?.userId?.id ||
      appt.patientId?.userId ||
      appt.bookedByUserId?.toString();
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const patientEmail = appt.patientId?.email || appt.patientId?.userId?.email;
    const defaultPatientPhone = appt.patientId?.phone || appt.patientId?.userId?.phone;
    const targetPhone = options?.phone || defaultPatientPhone;
    const channel = options?.channel || "whatsapp";
    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Clinic";
    const token = appt.tokenNumber;
    const { token: trackerToken, url: trackingUrl } = await issueAppointmentTrackerLink(appt);
    const prescriptionUrl = appendTrackerCapability(`/api/public/track/${appt._id}/prescription/print`, trackerToken);

    const rxSummaryList = Array.isArray(appt.prescriptions) && appt.prescriptions.length > 0
      ? appt.prescriptions.map((p: any) => `• ${p.name || p.medicineName} (${p.dosage || "As directed"}, ${p.duration || ""})`).join("\n")
      : "Prescription attached";

    if (targetUserId) {
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.CLINICAL_ENCOUNTER_COMPLETED,
        category: "clinical",
        targetUserId: targetUserId.toString(),
        title: "Consultation Completed ✅ — Prescription & Bill Ready",
        message: `Your consultation with Dr. ${doctorName} is complete. Your digital prescription and invoice are now available.`,
        severity: "success",
        actionUrl: trackingUrl,
        metadata: { appointmentId, token, clinicName, doctorName, trackingUrl },
      });
    }

    if (patientEmail) {
      const subject = `Consultation Completed - Prescription & Bill for Token #${token}`;
      const body = `Hello ${patientName},\n\nYour consultation with Dr. ${doctorName} at ${clinicName} has been completed.\n\nYour digital prescription, prescribed medicines, doctor's advice, and invoice are now available to view and download:\n${trackingUrl}\n\nThank you for choosing ${clinicName}.\n\nBest regards,\nAnant Health Desk`;

      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:consultation-completed:${appt._id}`,
      });
    }

    if (targetPhone) {
      const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
      await sendSmsWhatsAppNotification({
        organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString() || appointmentId?.toString(),
        phone: targetPhone,
        patientName,
        channel,
        templateId: "CONSULTATION_COMPLETED",
        variables: {
          patientName,
          doctorName,
          clinicName,
          tokenNumber: String(token),
          trackingUrl,
          prescriptionUrl,
          medicinesSummary: rxSummaryList,
          diagnosis: appt.diagnosis || "Consultation Completed",
        },
      }).catch((err) => console.error("SMS/WhatsApp consultation completion dispatch failed:", err));

      // Direct WhatsApp PDF Prescription Document Attachment Dispatch
      const { enqueueWhatsAppDocument } = await import("../services/CommunicationOutbox.ts");
      const cleanDocName = (doctorName || "Doctor").replace(/[^a-zA-Z0-9]/g, "_");
      const pdfFilename = `Prescription_Token_${token}_${cleanDocName}.pdf`;
      const documentUrl = prescriptionUrl;

      if (channel === "whatsapp") await enqueueWhatsAppDocument({
        to: targetPhone,
        organizationId: appt.organizationId?.toString(),
        documentUrl,
        filename: pdfFilename,
        idempotencyKey: `whatsapp-document:consultation-complete:${appt._id}`,
        caption: `📄 Official Digital Prescription & Care Advice from Dr. ${doctorName} (Token #${token})`,
      });
    }
  } catch (err) {
    console.error("sendConsultationCompletedNotification error:", err);
  }
}

/**
 * Dispatches disruption notification via email and WhatsApp.
 */
export async function sendDisruptionAlertNotification(appointmentId: any, params: {
  doctorName: string;
  clinicName: string;
  formattedTime: string;
  rescheduleUrl: string;
  cancelUrl: string;
}) {
  try {
    const appt: any = await Appointment.findById(appointmentId)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) return;

    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const patientPhone = appt.patientId?.phone || appt.patientId?.userId?.phone;
    const patientEmail = appt.patientId?.email || appt.patientId?.userId?.email;

    if (patientPhone) {
      const { SmsWhatsAppService } = await import("../services/SmsWhatsAppService.ts");
      await SmsWhatsAppService.sendDisruptionAlert(
        appt._id.toString(),
        appt.clinicId?.organizationId?.toString() || "",
        patientPhone,
        {
          patientName,
          doctorName: params.doctorName,
          clinicName: params.clinicName,
          appointmentTime: params.formattedTime,
          rescheduleUrl: params.rescheduleUrl,
          cancelUrl: params.cancelUrl,
          actionDeadlineMinutes: 60,
        }
      );
    }

    if (patientEmail) {
      const subject = `Urgent: Schedule Disruption for Dr. ${params.doctorName}`;
      const body = `Hello ${patientName},\n\nWe regret to inform you that Dr. ${params.doctorName} at ${params.clinicName} has experienced an unexpected schedule disruption for your appointment on ${params.formattedTime}.\n\nPlease choose one of the following options within 60 minutes:\n- Reschedule: ${params.rescheduleUrl}\n- Cancel & Refund: ${params.cancelUrl}\n\nWe apologize for any inconvenience.\n\nBest regards,\nAnant Health Desk`;
      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:disruption:${appt._id}`,
      });
    }
  } catch (err) {
    console.error("sendDisruptionAlertNotification error:", err);
  }
}

/**
 * Dispatches payment receipt notification via email and WhatsApp.
 */
export async function sendPaymentReceiptNotification(params: {
  appointmentId: string;
  invoiceId?: string;
  amount: number;
  paymentMethod: string;
}): Promise<void> {
  try {
    const { Appointment } = await import("../models/Appointment.ts");
    const { Invoice } = await import("../models/Invoice.ts");

    const appt: any = await Appointment.findById(params.appointmentId)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) return;

    let invoice: any = null;
    if (params.invoiceId) {
      invoice = await Invoice.findById(params.invoiceId);
    } else {
      invoice = await Invoice.findOne({ appointmentId: appt._id });
    }

    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const patientPhone = appt.patientId?.phone || appt.patientId?.userId?.phone;
    const patientEmail = appt.patientId?.email || appt.patientId?.userId?.email;
    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Ananta Health Clinic";
    const token = appt.tokenNumber || "OPD";
    const invoiceNum = invoice?.invoiceNumber || "INV-REC";
    const amountStr = `₹${Number(params.amount).toFixed(2)}`;

    let backendBase = process.env.NEXT_PUBLIC_API_URL;
    if (!backendBase) backendBase = "http://localhost:5000/api";
    const cleanBase = backendBase.replace(/\/+$/, "");
    const receiptUrl = `${cleanBase}/public/invoices/${invoice?._id || params.invoiceId}/print`;
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);

    if (patientPhone) {
      const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
      await sendSmsWhatsAppNotification({
        organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: "BILLING_RECEIPT",
        variables: {
          patientName,
          doctorName,
          clinicName,
          tokenNumber: String(token),
          amount: amountStr,
          paymentMethod: params.paymentMethod.toUpperCase(),
          invoiceNumber: invoiceNum,
          receiptUrl,
          trackingUrl,
        },
      }).catch((err) => console.error("SMS/WhatsApp payment receipt dispatch notice:", err));
    }

    if (patientEmail) {
      const subject = `Payment Confirmed - Receipt #${invoiceNum} (${amountStr})`;
      const body = `Hello ${patientName},\n\nWe have received your payment of ${amountStr} via ${params.paymentMethod.toUpperCase()} for Token #${token} (Dr. ${doctorName} at ${clinicName}).\n\nYour official payment receipt is available here:\n${receiptUrl}\n\nView your live visit tracker:\n${trackingUrl}\n\nThank you for choosing ${clinicName}.\n\nBest regards,\nAnant Health Billing Team`;

      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:payment-receipt:${invoice?._id || params.invoiceId || appt._id}:${params.paymentMethod}:${params.amount}`,
      }).catch((err) => console.error("Email payment receipt outbox enqueue failed:", err));
    }
  } catch (err) {
    console.error("sendPaymentReceiptNotification error:", err);
  }
}

/**
 * Dispatches proactive follow-up review recall notification.
 */
export async function sendFollowUpRecallNotification(params: {
  appointmentId: string;
  phone?: string;
  channel?: "whatsapp" | "sms";
}): Promise<void> {
  try {
    const { Appointment } = await import("../models/Appointment.ts");
    const appt: any = await Appointment.findById(params.appointmentId)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) return;

    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const targetPhone = params.phone || appt.patientId?.phone || appt.patientId?.userId?.phone;
    if (!targetPhone) return;

    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Clinic";
    const token = appt.tokenNumber || "OPD";
    const apptTime = new Date(appt.appointmentTime).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);

    const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
    await sendSmsWhatsAppNotification({
      organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
      appointmentId: appt._id?.toString(),
      phone: targetPhone,
      patientName,
      channel: params.channel || "whatsapp",
      templateId: "APPOINTMENT_REMINDER",
      variables: {
        patientName,
        doctorName,
        clinicName,
        appointmentTime: apptTime,
        tokenNumber: String(token),
        trackingUrl,
      },
    }).catch((err) => console.error("Follow-up recall SMS/WhatsApp notice:", err));
  } catch (err) {
    console.error("sendFollowUpRecallNotification error:", err);
  }
}

/**
 * Dispatches instant WhatsApp doorway summon notice when doctor calls patient into the cabin.
 */
export async function sendDoorwaySummonNotification(params: {
  appointmentId: string;
  phone?: string;
  cabinName?: string;
}): Promise<void> {
  try {
    const { Appointment } = await import("../models/Appointment.ts");
    const appt: any = await Appointment.findById(params.appointmentId)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) return;

    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const targetPhone = params.phone || appt.patientId?.phone || appt.patientId?.userId?.phone;
    if (!targetPhone) return;

    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Clinic";
    const token = appt.tokenNumber || "OPD";
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);

    const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
    await sendSmsWhatsAppNotification({
      organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
      appointmentId: appt._id?.toString(),
      phone: targetPhone,
      patientName,
      channel: "whatsapp",
      templateId: "QUEUE_UPDATE",
      variables: {
        patientName,
        doctorName,
        clinicName,
        tokenNumber: String(token),
        peopleAhead: "0 (CALLED IN NOW)",
        estimatedWaitTime: "0 mins - Please proceed inside to the Doctor Cabin",
        trackingUrl,
      },
    }).catch((err) => console.error("Doorway summon SMS/WhatsApp notice:", err));
  } catch (err) {
    console.error("sendDoorwaySummonNotification error:", err);
  }
}
