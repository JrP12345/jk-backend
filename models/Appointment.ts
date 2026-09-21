import mongoose, { Schema } from "mongoose";
import { getActiveConsultationDoctorDayKey } from "../utilities/consultationLock.ts";

const AppointmentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  bookedByUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  trackerTokenHash: { type: String, select: false, index: true },
  trackerTokenExpiresAt: { type: Date, index: true },
  // A tracker link is a read capability. Self check-in requires this separate,
  // short-lived, single-use capability so an appointment identifier or an old
  // tracker link cannot be replayed at a kiosk.
  checkInTokenHash: { type: String, select: false, index: true },
  checkInTokenExpiresAt: { type: Date, index: true },
  checkInTokenUsedAt: { type: Date },
  appointmentTime: { type: Date, required: true, index: true },
  appointmentType: { type: String, enum: ["walk-in", "online", "reception", "qr"], required: true },
  status: { 
    type: String, 
    enum: ["pending_payment", "pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show", "disruption_triage", "standby"], 
    default: "pending",
    index: true
  },
  paymentStatus: {
    type: String,
    enum: ["not_required", "pending", "paid", "pay_at_clinic", "failed", "refund_pending", "refunded", "unpaid", "partially_paid"],
    default: "pending",
    index: true
  },
  paymentAmount: { type: Number, default: 500 },
  feeType: {
    type: String,
    enum: ["fixed", "post_consultation", "free"],
    default: "fixed",
    index: true
  },
  customConsultationFee: { type: Number },
  invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
  bookingSource: {
    type: String,
    enum: ["patient_portal", "guest", "staff", "reception"],
    default: "patient_portal"
  },
  tokenNumber: { type: Number, required: true },
  queuePosition: { type: Number, index: true },
  // Present only while this appointment holds the doctor's consultation slot.
  // The sparse unique index below makes this an atomic, database-enforced lock.
  activeConsultationDoctorDayKey: { type: String, sparse: true },
  bookingMode: { type: String, enum: ["time_slot", "sequential_queue"], default: "sequential_queue" },
  duration: { type: Number, default: 15 },
  reasonForVisit: { 
    type: String, 
    enum: ["new_consultation", "follow_up", "routine_checkup", "second_opinion", "report_review"], 
    default: "new_consultation" 
  },
  notes: { type: String },
  followUpRecommended: { type: Boolean, default: false },
  followUpTimeline: { type: String },
  followUpNotes: { type: String },
  followUpForAppointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  followUpAppointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  symptoms: { type: String },
  diagnosis: { type: String },
  prescriptions: [{
    name: { type: String, required: true },
    dosage: { type: String, required: true },
    duration: { type: String, required: true }
  }],
  // Doctor Availability Disruption & Patient Triage fields
  disruptionId: { type: Schema.Types.ObjectId, ref: "DoctorDayOverride", index: true },
  originalDoctorId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  originalTokenNumber: { type: Number },
  transferredAt: { type: Date },
  transferredBy: { type: Schema.Types.ObjectId, ref: "User" },
  disruptedAt: { type: Date },
  disruptionNotifiedAt: { type: Date },
  disruptionResponseDeadline: { type: Date, index: true },
  // A bounded claim prevents two timeout workers from refunding/cancelling the
  // same disruption appointment if leadership changes during a sweep.
  disruptionTimeoutClaimedAt: { type: Date, index: true },
  disruptionTimeoutClaimToken: { type: String, index: true },
  cancellationReason: { type: String },
  priorityRescheduledFromId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  triageAction: { 
    type: String, 
    enum: ["pending", "timeout_processing", "transferred", "cancelled", "rescheduled", "refunded"],
    default: "pending" 
  },
  // Parked / Standby Queue Fields
  parkedAt: { type: Date },
  parkedReason: { type: String },
  patientReturned: { type: Boolean, default: false },
  patientReturnedAt: { type: Date },
  // Diagnostic Investigation & 2-Phase Consultation Fields
  consultationPhase: { 
    type: String, 
    enum: ["single", "initial_pending_investigation", "report_review"], 
    default: "single" 
  },
  investigationSentAt: { type: Date },
  investigationNotes: { type: String },
  // Queue Overrun & Delay Notification Fields
  delayNotifiedAt: { type: Date },
  lastNotifiedDelayMinutes: { type: Number },
  // Financial Disruption Reconciliation Fields
  feeVariance: { type: Number, default: 0 },
  feeResolution: { 
    type: String, 
    enum: ["waived_courtesy", "paid_difference", "partial_refund", "exact_match"] 
  },
  // Pre-Consultation Nurse Triage & Vitals Fields
  vitals: {
    bpSystolic: { type: Number },
    bpDiastolic: { type: Number },
    pulse: { type: Number },
    temperature: { type: Number },
    temperatureUnit: { type: String, enum: ["F", "C"], default: "F" },
    spO2: { type: Number },
    weight: { type: Number },
    height: { type: Number },
    bmi: { type: Number },
    bloodSugar: { type: Number },
    bloodSugarType: { type: String, enum: ["random", "fasting", "post_prandial"], default: "random" },
    allergies: [{ type: String }],
    triageNotes: { type: String },
    recordedAt: { type: Date },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
    recordedByName: { type: String },
  },
  // Emergency / STAT Protocol Fields
  isEmergency: { type: Boolean, default: false, index: true },
  emergencyTriagedAt: { type: Date },
  // Diagnostic Investigation Results from Lab
  investigationResults: [
    {
      testId: { type: Schema.Types.ObjectId, ref: "LabTest" },
      testName: { type: String },
      value: { type: String },
      unit: { type: String },
      referenceRange: { type: String },
      isAbnormal: { type: Boolean, default: false },
      resultNotes: { type: String },
      attachmentUrl: { type: String, default: "" },
      resultedAt: { type: Date, default: Date.now },
      labOrderId: { type: Schema.Types.ObjectId, ref: "LabOrder" },
    }
  ],
  // Autonomous Queue Pacing Alert (P2)
  turnApproachingNotifiedAt: { type: Date, default: null },
  // Digital e-Prescription Dispatch Tracking
  rxDispatchedAt: { type: Date, default: null },
  rxDispatchPhone: { type: String, default: null },
  // Follow-Up Care-Gap & Patient Recall Tracking
  lastRecallSentAt: { type: Date, default: null },
  recallCount: { type: Number, default: 0 },
  // Laboratory Panic Alert Fields
  hasPanicAlert: { type: Boolean, default: false, index: true },
  panicAlertDetails: { type: String, default: null },
  // ABDM Milestone 3 Care-Context Tracking
  abdmCareContextLinked: { type: Boolean, default: false, index: true },
  abdmCareContextRef: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

AppointmentSchema.index(
  { clinicId: 1, doctorId: 1, appointmentTime: 1 },
  {
    name: "uniq_timeslot_appointment",
    unique: true,
    partialFilterExpression: {
      bookingMode: "time_slot",
      status: { $in: ["confirmed", "pending", "pending_payment", "checked-in", "in-consultation"] }
    }
  }
);
AppointmentSchema.index({ organizationId: 1, appointmentTime: -1 });
AppointmentSchema.index({ clinicId: 1, status: 1, appointmentTime: -1 });
AppointmentSchema.index({ clinicId: 1, doctorId: 1, appointmentTime: 1, queuePosition: 1 });
AppointmentSchema.index(
  { activeConsultationDoctorDayKey: 1 },
  { name: "uniq_active_consultation_per_doctor_day", unique: true, sparse: true },
);

// Preserve the lock invariant for document saves and model-level updates. API
// handlers also set/unset the field explicitly; these hooks protect less common
// paths such as teleconsultation and future maintenance code.
AppointmentSchema.pre("save", function () {
  const appointment = this as any;
  if (appointment.status === "in-consultation") {
    appointment.activeConsultationDoctorDayKey = getActiveConsultationDoctorDayKey(
      appointment.doctorId,
      appointment.appointmentTime,
    );
  } else if (appointment.activeConsultationDoctorDayKey) {
    appointment.activeConsultationDoctorDayKey = undefined;
  }
});

AppointmentSchema.pre(["findOneAndUpdate", "updateOne"], async function () {
  const operation = this as any;
  const update = operation.getUpdate() || {};
  const nextStatus = update?.$set?.status ?? update?.status;

  if (nextStatus === "in-consultation") {
    if (!(update.$set?.activeConsultationDoctorDayKey || update.activeConsultationDoctorDayKey)) {
      const appointment = await operation.model
        .findOne(operation.getQuery())
        .select("doctorId appointmentTime")
        .lean();
      if (appointment) {
        update.$set = {
          ...(update.$set || {}),
          activeConsultationDoctorDayKey: getActiveConsultationDoctorDayKey(
            appointment.doctorId,
            appointment.appointmentTime,
          ),
        };
      }
    }
  } else if (nextStatus && nextStatus !== "in-consultation") {
    update.$unset = { ...(update.$unset || {}), activeConsultationDoctorDayKey: 1 };
  }

  operation.setUpdate(update);
});

AppointmentSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

AppointmentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Appointment = mongoose.model("Appointment", AppointmentSchema);
