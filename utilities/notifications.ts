import { Appointment } from "../models/Appointment.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

/**
 * Dispatches existing booking notifications through the configured notification channels.
 */
export async function sendBookingNotification(appointmentId: any, actionType: "booked" | "cancelled" | "rescheduled") {
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

    const targetUserId = appt.patientId?.userId?._id?.toString() || appt.patientId?.userId?.id || appt.patientId?.userId;
    const patientName = appt.patientId?.userId?.name || "Patient";
    const patientEmail = appt.patientId?.userId?.email;
    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Clinic Location";
    const token = appt.tokenNumber;
    const time = new Date(appt.appointmentTime).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });

    if (targetUserId) {
      eventBus.publish({
        eventType: actionType === "booked" ? EVENT_TYPES.PATIENT_APPOINTMENT_BOOKED : EVENT_TYPES.PATIENT_APPOINTMENT_CANCELLED,
        category: "patient",
        targetUserId: targetUserId.toString(),
        title: actionType === "booked" ? `Appointment Confirmed (#${token})` : `Appointment Cancelled`,
        message: actionType === "booked"
          ? `Appointment with Dr. ${doctorName} at ${clinicName} confirmed for ${time}. Token: #${token}`
          : `Your appointment with Dr. ${doctorName} at ${clinicName} scheduled for ${time} has been cancelled.`,
        severity: actionType === "booked" ? "success" : "warning",
        actionUrl: "/dashboard/appointments",
        metadata: { appointmentId, clinicName, doctorName, token, time },
      });
    }

    if (patientEmail) {
      const subject = actionType === "booked"
        ? `Appointment Confirmed - Token #${token} at ${clinicName}`
        : `Appointment Cancelled - ${clinicName}`;
      const body = actionType === "booked"
        ? `Hello ${patientName},\n\nYour appointment booking with Dr. ${doctorName} at ${clinicName} is confirmed for ${time}.\n\nYour assigned daily queue token is #${token}.\n\nPlease scan the reception QR code or check the Queue Dashboard when you arrive to view live wait times.\n\nBest regards,\nAnanta Health Desk`
        : `Hello ${patientName},\n\nThis is to inform you that your appointment with Dr. ${doctorName} at ${clinicName} scheduled for ${time} has been cancelled.\n\nIf you believe this is an error, please contact clinic reception.\n\nBest regards,\nAnanta Health Desk`;

      await emailProvider.sendEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`
      });
    }

    const patientPhone = appt.patientId?.userId?.phone;
    if (patientPhone) {
      const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
      sendSmsWhatsAppNotification({
        organizationId: appt.clinicId?.organizationId?.toString() || appt.organizationId?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: actionType === "booked" ? "BOOKING_CONFIRMATION" : "APPOINTMENT_REMINDER",
        variables: {
          patientName,
          doctorName,
          clinicName,
          appointmentTime: time,
          tokenNumber: String(token),
        },
      }).catch((err) => console.error("SMS/WhatsApp dispatch failed:", err));
    }
  } catch (err) {
    console.error("sendBookingNotification error:", err);
  }
}
