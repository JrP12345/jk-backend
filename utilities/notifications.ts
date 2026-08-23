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

    if (targetUserId) {
      eventBus.publish({
        eventType: actionType === "booked" ? EVENT_TYPES.PATIENT_APPOINTMENT_BOOKED : EVENT_TYPES.PATIENT_APPOINTMENT_CANCELLED,
        category: "patient",
        targetUserId: targetUserId.toString(),
        title: actionType === "booked" ? `Appointment Confirmed (#${token})` : `Appointment Cancelled`,
        message: actionType === "booked"
          ? `Appointment for ${patientName} with Dr. ${doctorName} at ${clinicName} confirmed for ${time}. Token: #${token}`
          : `Appointment for ${patientName} with Dr. ${doctorName} at ${clinicName} scheduled for ${time} has been cancelled.`,
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
