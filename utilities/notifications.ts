import { Appointment } from "../models/Appointment.ts";

/**
 * Simulates sending an email notification to patients for booking confirmations and cancellations.
 * In a production environment, this would integrate with nodemailer, SendGrid, or AWS SES.
 */
export async function sendBookingNotification(appointmentId: any, actionType: "booked" | "cancelled") {
  try {
    const appt: any = await Appointment.findById(appointmentId)
      .populate("clinicId", "name email phone city")
      .populate("doctorId", "name email")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!appt) {
      console.warn(`[Notification Warning] Appointment ${appointmentId} not found`);
      return;
    }

    const patientName = appt.patientId?.userId?.name || "Patient";
    const patientEmail = appt.patientId?.userId?.email || "no-email@healthos.placeholder.com";
    const doctorName = appt.doctorId?.name || "Doctor";
    const clinicName = appt.clinicId?.name || "Clinic Location";
    const token = appt.tokenNumber;
    const time = new Date(appt.appointmentTime).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });

    console.log("\n==========================================================");
    console.log(`[EMAIL NOTIFICATION SERVICE - ${actionType.toUpperCase()}]`);
    console.log(`To              : ${patientEmail}`);
    console.log(`Clinic          : ${clinicName}`);
    console.log(`Doctor          : Dr. ${doctorName}`);
    console.log(`Time Slot       : ${time}`);
    console.log(`Queue Token     : #${token}`);
    
    if (actionType === "booked") {
      console.log(`Subject         : Appointment Confirmed - Token #${token} at ${clinicName}`);
      console.log(`Body            : Hello ${patientName},\n\nYour appointment booking with Dr. ${doctorName} at ${clinicName} is confirmed for ${time}.\n\nYour assigned daily queue token is #${token}.\n\nPlease scan the reception QR code or check the Queue Dashboard when you arrive to view live wait times.\n\nBest regards,\nHealthOS Clinic Desk`);
    } else {
      console.log(`Subject         : Appointment Cancelled - ${clinicName}`);
      console.log(`Body            : Hello ${patientName},\n\nThis is to inform you that your appointment with Dr. ${doctorName} at ${clinicName} scheduled for ${time} has been cancelled.\n\nIf you believe this is an error, please contact the clinic reception directly.\n\nBest regards,\nHealthOS Clinic Desk`);
    }
    console.log("==========================================================\n");
  } catch (err) {
    console.error("sendBookingNotification error:", err);
  }
}
