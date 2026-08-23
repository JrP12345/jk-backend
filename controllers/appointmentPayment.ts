import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { Invoice } from "../models/Invoice.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { checkClinicAccess } from "../utilities/tenant.ts";
import { requestHasAnyPermission, BILLING_STAFF_PAYMENT_PERMISSIONS } from "../utilities/permissions.ts";

async function authorizeAppointmentAccess(
  req: FastifyRequest,
  appointment: {
    bookedByUserId?: mongoose.Types.ObjectId | string | null;
    patientId: mongoose.Types.ObjectId | string;
    clinicId?: mongoose.Types.ObjectId | string;
  }
): Promise<boolean> {
  const userId = req.user!.id;
  const userRole = req.user!.role;

  if (userRole === "root") return true;

  if (appointment.bookedByUserId?.toString() === userId) return true;

  const rel = await FamilyRelationship.findOne({ userId, patientId: appointment.patientId, status: "active" });
  if (rel) return true;

  if (!appointment.clinicId) return false;
  const clinicCheck = await checkClinicAccess(req, appointment.clinicId);
  if (!clinicCheck.allowed) return false;

  if (userRole === "admin") return true;
  return requestHasAnyPermission(req, ...BILLING_STAFF_PAYMENT_PERMISSIONS);
}

// ─── POST /api/appointment-payments/create-order ─────────────────────
export async function createAppointmentPaymentOrder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.body as { appointmentId: string };

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await authorizeAppointmentAccess(req, appointment))) {
      return reply.code(403).send(errorResponse("Unauthorized access to appointment"));
    }

    let invoice = await Invoice.findOne({ appointmentId: appointment._id });
    if (!invoice) {
      const assignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId });
      const fees = assignment?.fees || 500;
      const { generateClinicInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
      const invoiceNumber = await generateClinicInvoiceNumber(appointment.clinicId.toString());
      invoice = await Invoice.create({
        invoiceNumber,
        patientId: appointment.patientId,
        appointmentId: appointment._id,
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
        organizationId: appointment.organizationId,
        items: [{ description: "Consultation Fee", amount: fees, quantity: 1 }],
        subtotal: fees,
        totalAmount: fees,
        status: "unpaid",
      });
    }

    if (invoice.status === "paid") {
      return reply.code(400).send(errorResponse("This appointment invoice has already been paid"));
    }

    const idempotencyKey = `pay_order_${appointment._id.toString()}_${invoice.totalAmount}`;

    const existingPayment = await AppointmentPayment.findOne({ idempotencyKey, status: "created" });
    if (existingPayment?.razorpayOrderId) {
      const publicParams = await razorpayService.getPublicParams();
      return reply.code(200).send(
        successResponse({
          razorpayOrderId: existingPayment.razorpayOrderId,
          keyId: publicParams.keyId,
          amount: existingPayment.amount,
          currency: existingPayment.currency,
          appointmentId: appointment.id,
        })
      );
    }

    const razorpayOrder = await razorpayService.createOrder({
      amount: invoice.totalAmount,
      currency: "INR",
      receipt: invoice.invoiceNumber,
      notes: {
        appointmentId: appointment.id,
        patientId: appointment.patientId.toString(),
      },
    });

    const paymentRecord = await AppointmentPayment.create({
      appointmentId: appointment._id,
      invoiceId: invoice._id,
      patientId: appointment.patientId,
      amount: invoice.totalAmount,
      currency: "INR",
      paymentMethod: "razorpay",
      razorpayOrderId: razorpayOrder.id,
      status: "created",
      idempotencyKey,
    });

    const publicParams = await razorpayService.getPublicParams();

    return reply.code(200).send(
      successResponse({
        razorpayOrderId: razorpayOrder.id,
        keyId: publicParams.keyId,
        amount: invoice.totalAmount,
        currency: "INR",
        appointmentId: appointment.id,
        paymentRecordId: paymentRecord.id,
      })
    );
  } catch (err: any) {
    console.error("createAppointmentPaymentOrder error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to create payment order"));
  }
}

// ─── POST /api/appointment-payments/verify ────────────────────────────
export async function verifyAppointmentPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, appointmentId } = req.body as {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
      appointmentId?: string;
    };

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return reply.code(400).send(errorResponse("Missing required payment verification parameters"));
    }

    const isValid = await razorpayService.verifyPaymentSignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    if (!isValid) {
      return reply.code(400).send(errorResponse("Invalid payment signature verification failed"));
    }

    const paymentRecord = await AppointmentPayment.findOne({ razorpayOrderId });
    if (!paymentRecord) {
      return reply.code(404).send(errorResponse("Payment record not found"));
    }

    const appointment = await Appointment.findById(paymentRecord.appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (appointmentId && appointmentId !== paymentRecord.appointmentId.toString()) {
      return reply.code(400).send(errorResponse("Appointment ID does not match payment record"));
    }

    if (!(await authorizeAppointmentAccess(req, appointment))) {
      return reply.code(403).send(errorResponse("Unauthorized access to appointment"));
    }

    paymentRecord.status = "captured";
    paymentRecord.razorpayPaymentId = razorpayPaymentId;
    paymentRecord.razorpaySignature = razorpaySignature;
    await paymentRecord.save();

    appointment.paymentStatus = "paid";
    if (appointment.status === "pending_payment" || appointment.status === "pending") {
      appointment.status = "confirmed";
    }
    await appointment.save();

    await Invoice.updateOne(
      { appointmentId: appointment._id },
      {
        status: "paid",
        amountPaid: paymentRecord.amount || 0,
        paymentMethod: "online",
        paymentDate: new Date(),
      }
    );

    return reply.code(200).send(successResponse(null, "Appointment payment verified and confirmed successfully!"));
  } catch (err: any) {
    console.error("verifyAppointmentPayment error:", err);
    return reply.code(500).send(errorResponse(err.message || "Payment verification failed"));
  }
}

// ─── POST /api/appointment-payments/pay-at-clinic ─────────────────────
export async function selectPayAtClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.body as { appointmentId: string };

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await authorizeAppointmentAccess(req, appointment))) {
      return reply.code(403).send(errorResponse("Unauthorized access to appointment"));
    }

    const assignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId });
    if (assignment && assignment.allowPayAtClinic === false) {
      return reply.code(400).send(errorResponse("Pay at clinic is disabled for this doctor. Online payment is required."));
    }

    appointment.paymentStatus = "pay_at_clinic";
    if (appointment.status === "pending_payment" || appointment.status === "pending") {
      appointment.status = "confirmed";
    }
    await appointment.save();

    await AppointmentPayment.create({
      appointmentId: appointment._id,
      patientId: appointment.patientId,
      amount: 0,
      paymentMethod: "pay_at_clinic",
      status: "pay_at_clinic",
    });

    return reply.code(200).send(successResponse(appointment, "Pay at clinic option selected. Appointment confirmed!"));
  } catch (err: any) {
    console.error("selectPayAtClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
