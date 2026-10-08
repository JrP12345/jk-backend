import { withClinicalTransaction } from "../utilities/transaction.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { getActiveConsultationDoctorDayKey, isActiveConsultationLockConflict } from "../utilities/consultationLock.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { Organization } from "../models/Organization.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { getEffectivePermissions, isPrivilegedRole } from "../utilities/permissions.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import {
  acquireSlotLock,
  releaseSlotLock,
  checkSlotLock,
  validateSlotLockForBooking,
  forceReleaseSlotLock,
} from "../services/SlotLockService.ts";
import { checkLocationAccess, getRequestLocationIds } from "../utilities/tenant.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";
import { requestContextStore } from "../utilities/context.ts";
import { locationDateKey, getLocationTimezone } from "../utilities/locationTime.ts";
import { DoctorBookingUnavailableError } from "../services/SlotService.ts";

import { appointmentService, AppointmentDomainError, validateAppointmentAvailability, type BookAppointmentInput } from "../services/AppointmentService.ts";

async function ensureAppointmentLocationAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  locationId: unknown,
): Promise<boolean> {
  const check = await checkLocationAccess(req, locationId);
  if (!check.allowed) {
    reply.code(check.statusCode).send(errorResponse(check.message));
    return false;
  }
  return true;
}

type AppointmentAccessPurpose = "view" | "patient-self-service" | "staff-mutation";

function recordId(value: unknown): string {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
}

/**
 * Location membership alone is not enough for a patient-facing appointment URL:
 * patients can book at any active location, so a known appointment ID must still
 * be bound to the caller's own or active family-member patient profile.
 */
async function ensureAppointmentObjectAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  appointment: { locationId: unknown; doctorId: unknown; patientId: unknown; bookedByUserId?: unknown },
  purpose: AppointmentAccessPurpose = "view",
): Promise<boolean> {
  if (!(await ensureAppointmentLocationAccess(req, reply, appointment.locationId))) return false;

  const { role, id: userId } = req.user!;
  if (["patient", "family_member", "guest"].includes(role)) {
    const patientId = recordId(appointment.patientId);
    const isBookingOwner = recordId(appointment.bookedByUserId) === String(userId);
    const ownsPatient = await Patient.exists({ _id: patientId, userId });
    const hasFamilyRelationship = await FamilyRelationship.exists({
      userId,
      patientId,
      status: "active",
    });

    if (!isBookingOwner && !ownsPatient && !hasFamilyRelationship) {
      reply.code(403).send(errorResponse("Forbidden: You do not have permission to access this appointment"));
      return false;
    }

    if (purpose === "staff-mutation") {
      reply.code(403).send(errorResponse("Forbidden: Appointment clinical status can only be changed by organization staff"));
      return false;
    }

    return true;
  }

  // A doctor may work at multiple locations, but may only alter consultations
  // assigned to that doctor. Reception and authorised operational roles retain
  // their location-scoped workflow access.
  if (role === "doctor" && recordId(appointment.doctorId) !== String(userId)) {
    reply.code(403).send(errorResponse("Forbidden: You can only access appointments assigned to you"));
    return false;
  }

  return true;
}

const allowedAppointmentTransitions: Record<string, string[]> = {
  pending_payment: ["pending", "confirmed", "cancelled"],
  pending: ["confirmed", "checked-in", "cancelled", "no-show"],
  confirmed: ["checked-in", "cancelled", "no-show"],
  "checked-in": ["in-consultation", "cancelled", "no-show"],
  "in-consultation": ["completed"],
  standby: ["checked-in", "cancelled", "no-show"],
  disruption_triage: ["confirmed", "cancelled"],
  completed: [],
  cancelled: [],
  "no-show": [],
};

function isAllowedAppointmentTransition(from: string, to: string): boolean {
  return allowedAppointmentTransitions[from]?.includes(to) ?? false;
}

export async function bookAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    let orgId = req.user?.organization_id;

    const body = (req.body || {}) as BookAppointmentInput;
    if (!body?.locationId || !body?.doctorId || !body?.appointmentTime || !body?.appointmentType) {
      return reply.code(400).send(errorResponse("locationId, doctorId, appointmentTime, and appointmentType are required"));
    }

    const locationAccess = await checkLocationAccess(req, body.locationId);
    if (!locationAccess.allowed) {
      return reply.code(locationAccess.statusCode).send(errorResponse(locationAccess.message));
    }
    if (locationAccess.organizationId && (!orgId || ["patient", "family_member", "guest"].includes(userRole))) orgId = locationAccess.organizationId;

    const book = () => appointmentService.book(
      { id: userId, role: userRole, organizationId: orgId, bookingPatientId: req.user?.bookingPatientId },
      body,
      orgId
    );
    // Scope only this authorized booking to its branch; keep the signed session unchanged.
    const appointment = ["patient", "family_member", "guest"].includes(userRole)
      ? await requestContextStore.run({ ...requestContextStore.getStore(), organizationId: orgId }, book)
      : await book();

    return reply.code(201).send(
      successResponse(
        {
          id: appointment.id,
          locationId: appointment.locationId,
          doctorId: appointment.doctorId,
          patientId: appointment.patientId,
          appointmentTime: appointment.appointmentTime,
          appointmentType: appointment.appointmentType,
          status: appointment.status,
          tokenNumber: appointment.tokenNumber,
          queuePosition: appointment.queuePosition,
          notes: appointment.notes,
          paymentStatus: appointment.paymentStatus,
          paymentAmount: appointment.paymentAmount,
          trackerToken: appointment.trackerToken
        },
        "Appointment booked successfully"
      )
    );
  } catch (err: any) {
    if (err instanceof AppointmentDomainError) {
      return reply.code(err.statusCode).send(errorResponse(err.message));
    }
    if (err?.code === 11000) {
      return reply.code(409).send(errorResponse("This consultation time slot has already been booked. Please choose another slot."));
    }
    console.error("bookAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Appointments List (Filtered by Role) ───────────────────
export async function getAppointments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;
    const { locationId, doctorId, status, date, startDate, endDate, page, limit, search, reviewOnly } = req.query as any;
    const { appointmentReviewState, reviewCandidateFilter } = await import("../utilities/appointmentReview.ts");

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};

    if (userRole === "patient" || userRole === "family_member") {
      const patient = await Patient.findOne({ userId });
      if (userRole === "patient") {
        filter.$or = [{ bookedByUserId: userId }, ...(patient ? [{ patientId: patient._id }] : [])];
      } else {
        const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
        const rels = await FamilyRelationship.find({ userId, status: "active" }).select("patientId").lean();
        const familyPatientIds: any[] = rels.map((r: any) => r.patientId).filter(Boolean);
        if (patient) familyPatientIds.push(patient._id);
        filter.$or = [
          { patientId: { $in: familyPatientIds } },
          { bookedByUserId: userId },
        ];
      }
    } else if (userRole === "doctor") {
      filter.doctorId = userId;
    }

    if (locationId) {
      if (!(await ensureAppointmentLocationAccess(req, reply, locationId))) return;
      filter.locationId = locationId;
    } else if (orgId && userRole !== "patient" && userRole !== "family_member") {
      // Limit to locations in requesting user's organization
      const locationIds = await getRequestLocationIds(req);
      filter.locationId = { $in: locationIds };
    }

    if (doctorId && userRole !== "doctor") filter.doctorId = doctorId;
    if (status) filter.status = status;

    if (startDate || endDate) {
      filter.appointmentTime = {};
      if (startDate) {
        const sDate = new Date(startDate);
        if (Number.isNaN(sDate.getTime())) return reply.code(400).send(errorResponse("Invalid start date"));
        filter.appointmentTime.$gte = String(startDate).includes("T") ? sDate : new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), 0, 0, 0, 0);
      }
      if (endDate) {
        const eDate = new Date(endDate);
        if (Number.isNaN(eDate.getTime())) return reply.code(400).send(errorResponse("Invalid end date"));
        filter.appointmentTime.$lte = String(endDate).includes("T") ? eDate : new Date(eDate.getFullYear(), eDate.getMonth(), eDate.getDate(), 23, 59, 59, 999);
      }
    } else if (date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
      const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
      filter.appointmentTime = { $gte: startOfDay, $lte: endOfDay };
    }

    if (search && String(search).trim()) {
      const term = String(search).trim().slice(0, 100);
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "i");
      // Narrow through authorized appointments before matching identifying data.
      const [patientIds, doctorIds] = await Promise.all([
        Appointment.distinct("patientId", filter), Appointment.distinct("doctorId", filter)
      ]);
      const linkedPatients = await Patient.find({ _id: { $in: patientIds } }).select("userId").lean();
      const users = await User.find({ name: pattern, _id: { $in: doctorIds } }).select("_id").lean();
      const patientUsers = await User.find({ _id: { $in: linkedPatients.map(p => p.userId).filter(Boolean) }, $or: [{ name: pattern }, { phone: pattern }] }).select("_id").lean();
      const patients = await Patient.find({ _id: { $in: patientIds }, $or: [
        { name: pattern }, { phone: pattern }, { mrn: pattern }, { globalPatientID: pattern }, { userId: { $in: patientUsers.map(u => u._id) } }
      ] }).select("_id").lean();
      filter.$and = [{ $or: [
        { patientId: { $in: patients.map(p => p._id) } },
        { doctorId: { $in: users.map(u => u._id) } },
        ...(/^\d+$/.test(term) ? [{ tokenNumber: Number(term) }] : [])
      ] }];
    }

    if (reviewOnly === "1" && !["patient", "family_member"].includes(userRole)) {
      filter.$and = [...(filter.$and || []), reviewCandidateFilter()];
    }

    const [totalCount, rawAppointments] = await Promise.all([
      Appointment.countDocuments(filter),
      Appointment.find(filter)
        .populate("locationId", "name city address")
        .populate("doctorId", "name specialization fees")
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name email phone" }
        })
        .sort({ appointmentTime: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);
    const appointments = rawAppointments.map((a: any) => ({ ...a, id: a._id.toString(), reviewState: appointmentReviewState(a) }));

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getAppointments error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Update Appointment Status ──────────────────────────────────
export async function updateAppointmentStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const {
      status,
      notes,
      symptoms,
      diagnosis,
      prescriptions,
      followUpRecommended,
      followUpTimeline,
      followUpNotes,
      dispatchWhatsAppRx,
      recipientPhone,
      cdsOverrideReason,
      documentationMode,
    } = (req.body || {}) as {
      status: string;
      notes?: string;
      symptoms?: string;
      diagnosis?: string;
      prescriptions?: Array<{ name: string; dosage?: string; duration?: string; frequency?: string; instructions?: string }>;
      followUpRecommended?: boolean;
      followUpTimeline?: string;
      followUpNotes?: string;
      dispatchWhatsAppRx?: boolean;
      recipientPhone?: string;
      cdsOverrideReason?: string;
      documentationMode?: "optional";
    };

    if (!status) return reply.code(400).send(errorResponse("status is required"));

    const allowedStatuses = ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show"];
    if (!allowedStatuses.includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    const foundAppointment = await Appointment.findById(id);
    if (!foundAppointment) return reply.code(404).send(errorResponse("Appointment not found"));
    let appointment = foundAppointment;

    if (!(await ensureAppointmentObjectAccess(req, reply, appointment, "staff-mutation"))) return;

    const optionalDocumentation = documentationMode === "optional";
    if (optionalDocumentation) {
      const { isModuleEnabledForOrganization } = await import("../utilities/moduleAccess.ts");
      if (!await isModuleEnabledForOrganization(String(appointment.organizationId), "consultations")) return reply.code(403).send(errorResponse("Consultations module is not enabled"));
      const preferences = await Organization.findById(appointment.organizationId).select("workflowPreferences").lean();
      if (status !== "completed" || preferences?.workflowPreferences?.consultation !== "focused") {
        return reply.code(409).send(errorResponse("Enable focused consultations in organization preferences to complete without a SOAP note."));
      }
      const permissions = await getEffectivePermissions(req.user!.role, req.user!.organization_id, req.user?.authVersion);
      if (!isPrivilegedRole(req.user!.role) && !permissions.has("MANAGE_CLINICAL_NOTES")) {
        return reply.code(403).send(errorResponse("Clinical completion permission is required"));
      }
      if (prescriptions?.length && String(appointment.doctorId) !== req.user!.id) {
        return reply.code(403).send(errorResponse("Only the attending doctor can issue prescriptions"));
      }
      if (prescriptions?.some((p) => !p.name?.trim() || !p.dosage?.trim() || !p.frequency?.trim() || !p.duration?.trim())) {
        return reply.code(400).send(errorResponse("Each medicine requires name, dosage, frequency and duration."));
      }
    }

    if (appointment.status === status) {
      if (status === "completed") {
        const { Encounter } = await import("../models/Encounter.ts");
        const { ClinicalNote } = await import("../models/ClinicalNote.ts");
        const encounter = await Encounter.findOne({ appointmentId: appointment._id, status: "completed" });
        const note = encounter && await ClinicalNote.exists({ encounterId: encounter._id, isLatest: true, status: "signed" });
        const explicitClosure = encounter && await AuditLog.exists({ targetId: appointment._id, $or: [
          { action: "CONSULTATION_AUTO_COMPLETED_ON_NEXT" },
          { action: "CONSULTATION_COMPLETED_WITHOUT_CLINICAL_NOTE", organizationId: appointment.organizationId },
        ] });
        if (!note && !explicitClosure) return reply.code(409).send(errorResponse("This completed visit needs clinical-record review. Required completion records are missing; no records were rewritten.", "CLINICAL_COMPLETION_INCOMPLETE"));
      }
      return reply.code(200).send(successResponse(appointment, `Appointment is already ${status}`));
    }

    if (!isAllowedAppointmentTransition(appointment.status, status)) {
      return reply.code(409).send(
        errorResponse(`Invalid appointment transition from '${appointment.status}' to '${status}'`)
      );
    }

    // ── Clinical Decision Support (CDS) Safety Gate ──────────────────
    let cdsEvaluationResult: any = null;
    let cdsDecision: "accepted" | "overridden" | "blocked" = "accepted";

    if (status === "completed" && prescriptions && Array.isArray(prescriptions) && prescriptions.length > 0) {
      const validPrescriptions = prescriptions.filter((p) => p.name && p.name.trim());
      if (validPrescriptions.length > 0) {
        const { cdsEngine } = await import("../services/CDSEngine.ts");
        const { CDSEvaluation } = await import("../models/CDSEvaluation.ts");
        const { Prescription } = await import("../models/Prescription.ts");

        const patientDoc = await Patient.findById(appointment.patientId).setOptions({ bypassTenantFilter: true }).lean();
        const activeRxs = await Prescription.find({
          patientId: appointment.patientId,
          status: "active",
        }).setOptions({ bypassTenantFilter: true }).select("medicineName").lean();

        const evaluation = await cdsEngine.evaluate({
          patient: {
            id: appointment.patientId.toString(),
            dob: (patientDoc as any)?.dob,
            gender: (patientDoc as any)?.gender,
            allergies: ((patientDoc as any)?.allergies || []) as string[],
            conditions: ((patientDoc as any)?.conditions || []) as string[],
          },
          activeMedications: activeRxs.map((r: any) => ({ medicineName: r.medicineName })),
          proposedPrescriptions: validPrescriptions.map((p) => ({
            medicineName: p.name.trim(),
            dosage: p.dosage || "As directed",
            frequency: p.frequency || "1-0-1",
          })),
        });

        cdsEvaluationResult = evaluation;

        const criticalFindings = evaluation.findings.filter(
          (f) => f.systemAction === "override_required" || f.systemAction === "hard_stop" || f.severity === "critical"
        );

        if (criticalFindings.length > 0) {
          if (!cdsOverrideReason || !cdsOverrideReason.trim()) {
            await CDSEvaluation.create({
              organizationId: (appointment as any).organizationId,
              locationId: appointment.locationId,
              patientId: appointment.patientId,
              engineVersion: evaluation.engineVersion,
              terminologyVersion: evaluation.terminologyVersion,
              interactionDatasetVersion: evaluation.datasetVersion,
              findings: evaluation.findings,
              clinicianDecision: "blocked",
              overrideReason: "",
              metrics: evaluation.metrics,
              evaluatedAt: new Date(),
            }).catch(() => {});

            return reply.code(400).send({
              success: false,
              code: "CDS_SAFETY_CONTRAINDICATION",
              message: "Clinical Decision Support detected critical safety contraindications. Clinical override justification required.",
              findings: evaluation.findings,
              criticalFindings,
            });
          }

          cdsDecision = "overridden";
        }
      }
    }

    const appointmentUpdate: Record<string, unknown> = { status };
    if (status === "in-consultation") {
      appointmentUpdate.activeConsultationDoctorDayKey = getActiveConsultationDoctorDayKey(
        appointment.doctorId,
        appointment.appointmentTime,
      );
    }
    if (notes) appointmentUpdate.notes = notes;
    if (symptoms) appointmentUpdate.symptoms = symptoms;
    if (diagnosis) appointmentUpdate.diagnosis = diagnosis;
    if (prescriptions && Array.isArray(prescriptions)) {
      appointmentUpdate.prescriptions = prescriptions.map((p) => ({
        name: p.name,
        dosage: p.dosage || "As directed",
        duration: p.duration || "5 days",
      }));
    }
    if (followUpRecommended !== undefined) appointmentUpdate.followUpRecommended = Boolean(followUpRecommended);
    if (followUpTimeline) appointmentUpdate.followUpTimeline = followUpTimeline;
    if (followUpNotes) appointmentUpdate.followUpNotes = followUpNotes;

    const originalStatus = appointment.status;
    let afterCommit: Array<() => Promise<unknown>> = [];
    await withClinicalTransaction(async () => {
      afterCommit = [];
    if (optionalDocumentation) {
      const existingEncounter = await Encounter.findOne({ appointmentId: appointment._id });
      if (existingEncounter && (await ClinicalNote.exists({ encounterId: existingEncounter._id }) ||
          await (await import("../models/Prescription.ts")).Prescription.exists({ encounterId: existingEncounter._id }))) {
        throw Object.assign(new Error("This encounter has saved clinical work. Finish and sign it using the full consultation editor."), { statusCode: 409 });
      }
    }
    const transitionedAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: originalStatus },
      {
        $set: appointmentUpdate,
        ...(originalStatus === "in-consultation" && status !== "in-consultation"
          ? { $unset: { activeConsultationDoctorDayKey: 1 } }
          : {}),
      },
      { returnDocument: "after" },
    );
    if (!transitionedAppointment) {
      throw Object.assign(new Error("Appointment was changed by another request. Refresh and try again."), { statusCode: 409 });
    }
    appointment = transitionedAppointment;

    if (status === "in-consultation") {
      const { Encounter } = await import("../models/Encounter.ts");
      const existingEncounter = await Encounter.findOne({ appointmentId: appointment._id });
      if (!existingEncounter) {
        await Encounter.create({
          organizationId: (appointment as any).organizationId,
          locationId: appointment.locationId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
          status: "in_progress",
          startedAt: new Date(),
        });
      }
    }

    if (status === "completed") {
      const { Encounter } = await import("../models/Encounter.ts");
      const now = new Date();
      let encounter = await Encounter.findOne({ appointmentId: appointment._id, status: { $ne: "cancelled" } });
      if (!encounter) {
        encounter = await Encounter.create({
          organizationId: (appointment as any).organizationId,
          locationId: appointment.locationId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
          status: "completed",
          startedAt: appointment.appointmentTime || now,
          endedAt: now,
        });
      } else {
        encounter.status = "completed";
        encounter.endedAt = now;
        await encounter.save();
      }

      // Create individual Prescription records in MongoDB for in-house pharmacy dispensing & timeline
      const createdPrescriptionIds: mongoose.Types.ObjectId[] = [];
      if (prescriptions && Array.isArray(prescriptions) && prescriptions.length > 0) {
        const { Prescription } = await import("../models/Prescription.ts");
        for (const p of prescriptions) {
          if (!p.name || !p.name.trim()) continue;
          const rxDoc = await Prescription.create({
            organizationId: (appointment as any).organizationId,
            locationId: appointment.locationId,
            encounterId: encounter._id,
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            medicineName: p.name.trim(),
            dosage: p.dosage || "As directed",
            frequency: p.frequency || "1-0-1",
            duration: p.duration || "5 days",
            instructions: optionalDocumentation ? (p.instructions || "") : (p.instructions || "Follow prescribed meal instructions"),
            status: "active",
          });
          createdPrescriptionIds.push((rxDoc as any)._id);
          if (optionalDocumentation) {
            const { PrescriptionSealingService } = await import("../services/PrescriptionSealingService.ts");
            await PrescriptionSealingService.sealPrescription(String(rxDoc._id), req.user!.id, { diagnosisDescription: diagnosis });
          }
        }
      }

      // Persist clinical CDSEvaluation record & AuditLog
      if (cdsEvaluationResult) {
        const { CDSEvaluation } = await import("../models/CDSEvaluation.ts");
        await CDSEvaluation.create({
          organizationId: (appointment as any).organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          prescriptionIds: createdPrescriptionIds,
          engineVersion: cdsEvaluationResult.engineVersion,
          terminologyVersion: cdsEvaluationResult.terminologyVersion,
          interactionDatasetVersion: cdsEvaluationResult.datasetVersion,
          findings: cdsEvaluationResult.findings,
          clinicianDecision: cdsDecision,
          overrideReason: cdsOverrideReason || "",
          metrics: cdsEvaluationResult.metrics,
          evaluatedAt: new Date(),
        });

        if (cdsDecision === "overridden") {
          await AuditLog.create({
            action: "CDS_OVERRIDE",
            category: "CLINICAL_WRITE",
            targetId: appointment._id,
            targetModel: "Appointment",
            userId: req.user?.id,
            details: {
              appointmentId: appointment._id,
              encounterId: encounter._id,
              patientId: appointment.patientId,
              overrideReason: cdsOverrideReason,
              findingsCount: cdsEvaluationResult.findings.length,
            },
          });
        }
      }

      // Calculate follow-up target date
      let followUpDate: Date | undefined;
      if (followUpRecommended && followUpTimeline) {
        const target = new Date();
        if (followUpTimeline.includes("day")) {
          const days = parseInt(followUpTimeline, 10) || 7;
          target.setDate(target.getDate() + days);
        } else if (followUpTimeline.includes("week")) {
          const weeks = parseInt(followUpTimeline, 10) || 1;
          target.setDate(target.getDate() + weeks * 7);
        } else if (followUpTimeline.includes("month")) {
          const months = parseInt(followUpTimeline, 10) || 1;
          target.setMonth(target.getMonth() + months);
        } else {
          target.setDate(target.getDate() + 7);
        }
        followUpDate = target;
      }

      // The explicit focused path records the visit without fabricating a SOAP note.
      if (optionalDocumentation) {
        await AuditLog.create({
          userId: req.user!.id, organizationId: appointment.organizationId,
          action: "CONSULTATION_COMPLETED_WITHOUT_CLINICAL_NOTE", category: "CLINICAL_WRITE",
          targetId: appointment._id, targetModel: "Appointment",
          details: { encounterId: encounter._id, documentationMode, prescriptionsCount: createdPrescriptionIds.length },
        });
        const { isModuleEnabledForOrganization } = await import("../utilities/moduleAccess.ts");
        if (await isModuleEnabledForOrganization(String(appointment.organizationId), "billing")) {
          const { autoGenerateEncounterInvoice } = await import("../services/ChargeCaptureService.ts");
          await autoGenerateEncounterInvoice(String(encounter._id));
        }
      } else try {
        const { ClinicalNote } = await import("../models/ClinicalNote.ts");
        const docUser = await User.findById(appointment.doctorId).select("name").lean();
        const docName = docUser?.name || "Doctor";

        let note = await ClinicalNote.findOne({ encounterId: encounter._id, isLatest: true });
        if (!note) {
          await ClinicalNote.create({
            organizationId: (appointment as any).organizationId,
            locationId: appointment.locationId,
            encounterId: encounter._id,
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            version: 1,
            isLatest: true,
            subjective: {
              chiefComplaint: symptoms || "General Outpatient Assessment",
              historyOfPresentIllness: symptoms || "",
              symptoms: symptoms ? [symptoms] : [],
            },
            objective: {
              physicalExamination: "Conducted physical examination during consultation.",
            },
            assessment: {
              diagnoses: diagnosis
                ? [{ code: "CLINICAL", description: diagnosis, status: "active" }]
                : [{ code: "EVAL", description: "Clinical Evaluation Completed", status: "active" }],
              severity: "moderate",
            },
            plan: {
              treatmentPlan: followUpNotes || "Follow prescribed medical regimen and medication schedule.",
              prescriptionIds: createdPrescriptionIds as any,
              followUpDate,
              followUpInstructions: followUpNotes || (followUpRecommended ? `Follow up in ${followUpTimeline}` : undefined),
            },
            status: "signed",
            signature: {
              signerId: appointment.doctorId,
              signerName: `Dr. ${docName.replace(/^dr\.?\s+/i, "")}`,
              signedAt: now,
              signingMethod: "RS256_JWT",
            },
          });
        } else {
          if (symptoms) (note as any).subjective.chiefComplaint = symptoms;
          if (diagnosis) {
            (note as any).assessment.diagnoses = [{ code: "CLINICAL", description: diagnosis, status: "active" } as any];
          }
          if (createdPrescriptionIds.length > 0) {
            (note as any).plan.prescriptionIds = createdPrescriptionIds as any;
          }
          if (followUpDate) (note as any).plan.followUpDate = followUpDate;
          if (followUpNotes) (note as any).plan.followUpInstructions = followUpNotes;
          note.status = "signed";
          await note.save();
        }
      } catch (noteErr) {
        throw noteErr;
      }

      // Auto-schedule confirmed follow-up review appointment in MongoDB
      if (followUpRecommended && followUpDate && appointment.locationId && appointment.patientId && appointment.doctorId) {
        try {
          const existingFollowUp = await Appointment.findOne({
            followUpForAppointmentId: appointment._id,
            status: { $ne: "cancelled" },
          });

          const { canCreateLocationBooking } = await import("../services/billing/SubscriptionAccess.ts");
          if (!existingFollowUp && await canCreateLocationBooking(String(appointment.locationId))) {
            const dateStr = locationDateKey(followUpDate, await getLocationTimezone(String(appointment.locationId)));
            const counterKey = `token_${appointment.locationId}_${appointment.doctorId}_${dateStr}`;
            const tokenNumber = await getNextAtomicSequence(counterKey);

            const followUp = await Appointment.create({
              organizationId: (appointment as any).organizationId || undefined,
              locationId: appointment.locationId,
              doctorId: appointment.doctorId,
              patientId: appointment.patientId,
              appointmentTime: followUpDate,
              appointmentType: "walk-in",
              status: "confirmed",
              tokenNumber,
              queuePosition: tokenNumber,
              notes: followUpNotes || `Recommended Follow-up Review (${followUpTimeline})`,
              followUpRecommended: true,
              followUpForAppointmentId: appointment._id,
              paymentStatus: "unpaid",
            });

            (appointment as any).followUpAppointmentId = followUp._id;
            await appointment.save();
          } else if (existingFollowUp) {
            (appointment as any).followUpAppointmentId = existingFollowUp._id;
            await appointment.save();
          }
        } catch (followUpErr) {
          throw followUpErr;
        }
      }

      afterCommit.push(async () => {
      if (dispatchWhatsAppRx !== false) {
        const { sendConsultationCompletedNotification } = await import("../utilities/notifications.ts");
        await sendConsultationCompletedNotification(appointment._id, {
          phone: recipientPhone?.trim() || undefined,
          channel: "whatsapp",
        });
        (appointment as any).rxDispatchedAt = new Date();
        if (recipientPhone) (appointment as any).rxDispatchPhone = recipientPhone.trim();
        await appointment.save();
      }

      // Real-time pharmacy broadcast for dispensary desk
      if (createdPrescriptionIds.length > 0 && appointment.locationId) {
        try {
          const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
          let patientName = "Patient";
          if ((appointment.patientId as any)?.name) {
            patientName = (appointment.patientId as any).name;
          } else if ((appointment.patientId as any)?.userId?.name) {
            patientName = (appointment.patientId as any).userId.name;
          } else if (appointment.patientId) {
            const patientDoc = (await Patient.findById(appointment.patientId).populate("userId", "name").lean()) as any;
            patientName = patientDoc?.userId?.name || patientDoc?.name || "Patient";
          }

          broadcastQueueUpdate(appointment.locationId.toString(), {
            type: "PRESCRIPTION_ISSUED",
            data: {
              appointmentId: appointment._id.toString(),
              encounterId: encounter._id.toString(),
              patientId: appointment.patientId?.toString(),
              patientName,
              tokenNumber: appointment.tokenNumber,
              doctorId: appointment.doctorId?.toString(),
              prescriptionCount: createdPrescriptionIds.length,
              prescriptions: (prescriptions || []).map((p) => ({
                name: p.name.trim(),
                dosage: p.dosage || "As directed",
                frequency: p.frequency || "1-0-1",
                duration: p.duration || "5 days",
                instructions: optionalDocumentation ? (p.instructions || "") : (p.instructions || "Follow prescribed meal instructions"),
              })),
              locationId: appointment.locationId.toString(),
            },
            timestamp: new Date().toISOString(),
          });
        } catch (wsErr) {
          console.warn("Real-time pharmacy PRESCRIPTION_ISSUED broadcast warning:", wsErr);
        }
      }
      });
    }

    if (status === "cancelled") {
      afterCommit.push(() => sendBookingNotification(appointment._id, "cancelled"));
      await Invoice.updateMany({ appointmentId: appointment._id, status: "unpaid" }, { status: "cancelled" });
    }

    await AuditLog.create({
      userId: req.user!.id,
      action: "APPOINTMENT_STATUS_UPDATE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        status,
        notes,
        symptoms: symptoms || undefined,
        diagnosis: diagnosis || undefined,
        prescriptionsCount: prescriptions?.length || 0,
      }
    });

    });
    appointment.$session(null);
    for (const dispatch of afterCommit) {
      try { await dispatch(); } catch (err) { req.log.error({ err }, "Clinical records committed; notification delivery failed"); }
    }

    // Real-time queue broadcast
    const locationIdStr = appointment.locationId?.toString();
    if (locationIdStr) {
      const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
      broadcastQueueUpdate(locationIdStr, {
        type: "QUEUE_UPDATED",
        data: {
          appointmentId: appointment._id.toString(),
          status: appointment.status,
          doctorId: appointment.doctorId?.toString(),
          locationId: locationIdStr,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Autonomous Queue Pacing (P2): If consultation began, completed, or cancelled, advance pacing for waiting queue
    if (["in-consultation", "completed", "cancelled", "no-show"].includes(status)) {
      const { triggerTurnApproachingPacing } = await import("./queue.ts");
      triggerTurnApproachingPacing(appointment.locationId, appointment.doctorId).catch((err) =>
        console.error("Background turn approaching pacing error on appointment status update:", err)
      );
    }

    return reply.code(200).send(successResponse(appointment, "Appointment status updated successfully"));
  } catch (err) {
    console.error("updateAppointmentStatus error:", err);
    if ((err as any)?.statusCode === 409) return reply.code(409).send(errorResponse((err as Error).message));
    if (isActiveConsultationLockConflict(err)) {
      return reply.code(409).send(errorResponse("Doctor already has an active consultation. Complete it before starting another.", "ACTIVE_CONSULTATION_IN_PROGRESS"));
    }
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Resend Digital Prescription via WhatsApp/SMS ────────────────
export async function resendPrescriptionNotification(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { phone, channel = "whatsapp" } = (req.body || {}) as { phone?: string; channel?: "whatsapp" | "sms" };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentObjectAccess(req, reply, appointment, "staff-mutation"))) return;

    if (appointment.status !== "completed") {
      return reply.code(409).send(errorResponse("A prescription can only be resent after the appointment is completed"));
    }
    if (channel !== "whatsapp" && channel !== "sms") {
      return reply.code(400).send(errorResponse("channel must be whatsapp or sms"));
    }

    const { sendConsultationCompletedNotification } = await import("../utilities/notifications.ts");
    await sendConsultationCompletedNotification(appointment._id, {
      phone: phone?.trim(),
      channel,
    });

    (appointment as any).rxDispatchedAt = new Date();
    if (phone) (appointment as any).rxDispatchPhone = phone.trim();
    await appointment.save();

    const { AuditLog } = await import("../models/AuditLog.ts");
    await AuditLog.create({
      organizationId: (appointment as any).organizationId,
      userId: req.user!.id,
      category: "CLINICAL_WRITE",
      action: "PRESCRIPTION_NOTIFICATION_RESENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        channel,
        phone: phone || "patient_registered_phone",
      },
    });

    return reply.code(200).send(
      successResponse(
        { appointmentId: appointment._id, channel, dispatchedAt: (appointment as any).rxDispatchedAt },
        `Digital e-Prescription successfully dispatched via ${channel.toUpperCase()}`
      )
    );
  } catch (err: any) {
    console.error("resendPrescriptionNotification error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to resend prescription notification"));
  }
}

// ─── Reschedule Appointment ────────────────────────────────────
export async function rescheduleAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const { newTime, reason, lockId } = req.body as {
      newTime: string;
      reason?: string;
      lockId?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    if (!newTime || isNaN(new Date(newTime).getTime())) {
      return reply.code(400).send(errorResponse("Valid newTime is required"));
    }

    const foundAppointment = await Appointment.findById(id);
    if (!foundAppointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    let appointment = foundAppointment;
    if (!(await ensureAppointmentObjectAccess(req, reply, appointment, "patient-self-service"))) return;

    const reschedulableStatuses = ["pending_payment", "pending", "confirmed", "checked-in", "standby", "disruption_triage"];
    if (!reschedulableStatuses.includes(appointment.status)) {
      return reply.code(409).send(errorResponse(`Cannot reschedule an appointment that is already ${appointment.status}`));
    }

    const newDateObj = new Date(newTime);
    if (newDateObj < new Date()) {
      return reply.code(400).send(errorResponse("Cannot reschedule an appointment to a past time"));
    }

    // Validate slot lock anti-double booking (only in time_slot mode)
    const rescheduleAssignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, locationId: appointment.locationId, isActive: true });
    if (!rescheduleAssignment) return reply.code(409).send(errorResponse("The doctor is no longer assigned to this location"));
    await validateAppointmentAvailability({ role: req.user!.role }, {
      doctorId: appointment.doctorId.toString(), locationId: appointment.locationId.toString(),
      appointmentTime: newTime, appointmentType: appointment.appointmentType as BookAppointmentInput["appointmentType"],
      duration: appointment.duration,
    }, rescheduleAssignment, appointment._id.toString());
    const rescheduleMode = (rescheduleAssignment as any)?.bookingMode;
    const rescheduleIsQueue = rescheduleMode ? rescheduleMode === "sequential_queue" : true;
    let lockValidation: { valid: boolean; message?: string; lockKey?: string } = { valid: true };
    if (!rescheduleIsQueue) {
      lockValidation = await validateSlotLockForBooking(
        appointment.locationId.toString(),
        appointment.doctorId.toString(),
        newTime,
        userId,
        lockId
      );
      if (!lockValidation.valid) {
        return reply.code(409).send(errorResponse(lockValidation.message ?? "Slot is unavailable"));
      }
    }

    const oldTimeStr = new Date(appointment.appointmentTime).toISOString();

    // Recalculate atomic daily token number & queue position for the new date
    const newDateStr = locationDateKey(newDateObj, await getLocationTimezone(String(appointment.locationId)));
    const counterKey = `token_${appointment.locationId}_${appointment.doctorId}_${newDateStr}`;
    const originalStatus = appointment.status;
    await withClinicalTransaction(async () => {
    const tokenNumber = await getNextAtomicSequence(counterKey);
    if (rescheduleAssignment.maxDailyTokens && tokenNumber > rescheduleAssignment.maxDailyTokens) {
      throw new AppointmentDomainError("The doctor's daily token limit has been reached", 409);
    }

    const rescheduleUpdate: Record<string, unknown> = {
      appointmentTime: newDateObj,
      tokenNumber,
      queuePosition: tokenNumber,
      status: appointment.status === "pending_payment" ? "pending_payment" : "confirmed",
    };
    if (reason) {
      rescheduleUpdate.notes = appointment.notes
        ? `${appointment.notes}\n[Rescheduled from ${oldTimeStr}: ${reason}]`
        : `[Rescheduled from ${oldTimeStr}: ${reason}]`;
    }

    const rescheduledAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: originalStatus },
      { $set: rescheduleUpdate },
      { returnDocument: "after" },
    );
    if (!rescheduledAppointment) {
      throw new AppointmentDomainError("Appointment was changed by another request. Refresh and try again.", 409);
    }
    appointment = rescheduledAppointment;

    await AuditLog.create({
      userId,
      organizationId: appointment.organizationId || undefined,
      action: "APPOINTMENT_RESCHEDULE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { oldTime: oldTimeStr, newTime, reason }
    });

    });
    appointment.$session(null);
    if (lockValidation.lockKey) {
      forceReleaseSlotLock(lockValidation.lockKey).catch(() => {});
    }

    sendBookingNotification(appointment._id, "rescheduled").catch(() => {});

    return reply.code(200).send(successResponse(appointment, `Appointment successfully rescheduled to ${newDateObj.toISOString()}`));
  } catch (err: any) {
    if (err?.code === 11000) {
      return reply.code(409).send(errorResponse("This consultation time slot has already been booked. Please choose another slot."));
    }
    if (err instanceof AppointmentDomainError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("rescheduleAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Doctor Time Slot Availability ─────────────────────────
export async function getDoctorSlots(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { doctorId } = req.params as { doctorId: string };
    const { locationId, date } = req.query as { locationId: string; date: string };

    if (!doctorId || !locationId || !date) {
      return reply.code(400).send(errorResponse("doctorId, locationId, and date (YYYY-MM-DD) are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(doctorId) || !mongoose.Types.ObjectId.isValid(locationId)) return reply.code(400).send(errorResponse("Invalid doctor or location ID"));
    if (req.user && !(await ensureAppointmentLocationAccess(req, reply, locationId))) return;
    if (!req.user || ["patient", "family_member", "guest"].includes(req.user.role)) {
      const { canCreateLocationBooking } = await import("../services/billing/SubscriptionAccess.ts");
      if (!(await canCreateLocationBooking(locationId, true))) {
        return reply.code(409).send(errorResponse("Online booking is temporarily unavailable. Please contact reception directly."));
      }
    }

    const { getDoctorAvailableSlots } = await import("../services/SlotService.ts");
    const result = await getDoctorAvailableSlots(doctorId, locationId, date, req.user?.id);

    return reply.code(200).send(successResponse(result));
  } catch (err: any) {
    if (err instanceof DoctorBookingUnavailableError) return reply.code(409).send(errorResponse(err.message));
    console.error("getDoctorSlots error:", err);
    if (err instanceof RangeError && err.message.startsWith("Invalid date format")) {
      return reply.code(400).send(errorResponse(err.message));
    }
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── Patient Self-Service Appointment Cancellation ─────────────
export async function cancelAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason?: string };

    let appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));

    if (!(await ensureAppointmentObjectAccess(req, reply, appointment, "patient-self-service"))) return;

    const cancellableStatuses = ["pending_payment", "pending", "confirmed", "checked-in", "standby", "disruption_triage"];
    if (!cancellableStatuses.includes(appointment.status)) {
      return reply.code(409).send(errorResponse(`Cannot cancel appointment already in '${appointment.status}' status`));
    }

    const cancellationUpdate: Record<string, unknown> = { status: "cancelled" };
    if (reason) cancellationUpdate.notes = `Cancelled by patient: ${reason}`;
    const cancelledAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: appointment.status },
      { $set: cancellationUpdate },
      { returnDocument: "after" },
    );
    if (!cancelledAppointment) {
      return reply.code(409).send(errorResponse("Appointment was changed by another request. Refresh and try again."));
    }
    appointment = cancelledAppointment;

    sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification failed:", err));

    await AuditLog.create({
      userId: req.user!.id,
      organizationId: appointment.organizationId || undefined,
      action: "PATIENT_CANCEL_APPOINTMENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { reason: reason || "Self-service cancellation" }
    });

    return reply.code(200).send(successResponse(appointment, "Appointment cancelled successfully"));
  } catch (err) {
    console.error("cancelAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Single Appointment by ID ─────────────────────────────
export async function getAppointmentById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id)
      .populate("locationId", "name city address")
      .populate("doctorId", "name specialization fees email phone")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentObjectAccess(req, reply, appointment, "view"))) return;

    const { appointmentReviewState } = await import("../utilities/appointmentReview.ts");
    return reply.code(200).send(successResponse({ ...appointment.toJSON(), reviewState: appointmentReviewState(appointment) }));
  } catch (err) {
    console.error("getAppointmentById error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Acquire Lock ───────────────────────────────────
export async function lockSlot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { locationId, doctorId, slotTime } = req.body as {
      locationId: string;
      doctorId: string;
      slotTime: string;
    };

    if (!locationId || !doctorId || !slotTime) {
      return reply.code(400).send(errorResponse("locationId, doctorId, and slotTime are required"));
    }

    if (!(await ensureAppointmentLocationAccess(req, reply, locationId))) return;

    const result = await acquireSlotLock(locationId, doctorId, slotTime, userId);

    if (!result.success) {
      return reply.code(409).send(errorResponse(result.message, { heldBy: result.heldBy }));
    }

    return reply.code(200).send(
      successResponse(
        {
          lockId: result.lockId,
          lockKey: result.lockKey,
          expiresInSeconds: result.expiresInSeconds,
        },
        result.message
      )
    );
  } catch (err) {
    console.error("lockSlot error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Release Lock ──────────────────────────────────
export async function unlockSlot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { locationId, doctorId, slotTime, lockId } = req.body as {
      locationId: string;
      doctorId: string;
      slotTime: string;
      lockId: string;
    };

    if (!locationId || !doctorId || !slotTime || !lockId) {
      return reply.code(400).send(errorResponse("locationId, doctorId, slotTime, and lockId are required"));
    }

    if (!(await ensureAppointmentLocationAccess(req, reply, locationId))) return;

    const result = await releaseSlotLock(locationId, doctorId, slotTime, userId, lockId);

    if (!result.success) {
      return reply.code(403).send(errorResponse(result.message));
    }

    return reply.code(200).send(successResponse(null, result.message));
  } catch (err) {
    console.error("unlockSlot error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Check Lock Status ─────────────────────────────
export async function getSlotLockStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, doctorId, slotTime } = req.query as {
      locationId: string;
      doctorId: string;
      slotTime: string;
    };

    if (!locationId || !doctorId || !slotTime) {
      return reply.code(400).send(errorResponse("locationId, doctorId, and slotTime are required"));
    }

    if (!(await ensureAppointmentLocationAccess(req, reply, locationId))) return;

    const info = await checkSlotLock(locationId, doctorId, slotTime);

    return reply.code(200).send(
      successResponse({
        isLocked: info.isLocked,
        heldByUserId: info.heldByUserId || null,
        ttlSeconds: info.ttlSeconds || 0,
      })
    );
  } catch (err) {
    console.error("getSlotLockStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Follow-Up Care-Gap & Patient Recall Register ───────────────
export async function getFollowUpRegister(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, doctorId, timeframe, search } = (req.query || {}) as {
      locationId?: string;
      doctorId?: string;
      timeframe?: "all" | "today" | "upcoming" | "overdue";
      search?: string;
    };

    if (["patient", "family_member", "guest"].includes(req.user!.role)) {
      return reply.code(403).send(errorResponse("Forbidden: Follow-up register is available to organization staff only"));
    }

    const query: any = {
      $or: [
        { followUpRecommended: true },
        { followUpForAppointmentId: { $exists: true, $ne: null } },
      ],
    };

    if (locationId) {
      if (!(await ensureAppointmentLocationAccess(req, reply, locationId))) return;
      query.locationId = locationId;
    } else if (req.user?.organization_id) {
      const { getRequestLocationIds } = await import("../utilities/tenant.ts");
      query.locationId = { $in: await getRequestLocationIds(req) };
    }

    if (req.user!.role === "doctor") {
      if (doctorId && doctorId !== req.user!.id) {
        return reply.code(403).send(errorResponse("Forbidden: You can only view your own follow-up register"));
      }
      query.doctorId = req.user!.id;
    } else if (doctorId) {
      query.doctorId = doctorId;
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const in7Days = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);

    const appointments = await Appointment.find(query)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      })
      .populate("doctorId", "name specialization")
      .populate("locationId", "name city")
      .sort({ appointmentTime: 1 })
      .lean();

    let dueTodayCount = 0;
    let upcomingCount = 0;
    let overdueCount = 0;

    const mapped = appointments.map((appt: any) => {
      const apptDate = new Date(appt.appointmentTime);
      let statusCategory: "due_today" | "upcoming" | "overdue" | "attended" = "upcoming";

      if (appt.status === "completed" || appt.status === "in-consultation") {
        statusCategory = "attended";
      } else if (apptDate >= startOfToday && apptDate <= endOfToday) {
        statusCategory = "due_today";
        dueTodayCount++;
      } else if (apptDate > endOfToday && apptDate <= in7Days) {
        statusCategory = "upcoming";
        upcomingCount++;
      } else if (apptDate < startOfToday && ["confirmed", "pending", "checked-in"].includes(appt.status)) {
        statusCategory = "overdue";
        overdueCount++;
      }

      const patientName = appt.patientId?.userId?.name || appt.patientId?.name || "Patient";
      const patientPhone = (appt.patientId as any)?.phone || appt.patientId?.userId?.phone || "";

      return {
        id: appt._id.toString(),
        appointmentTime: appt.appointmentTime,
        status: appt.status,
        statusCategory,
        tokenNumber: appt.tokenNumber,
        patient: {
          id: appt.patientId?._id?.toString() || appt.patientId?.id,
          name: patientName,
          phone: patientPhone,
          gender: appt.patientId?.gender,
          age: appt.patientId?.age,
        },
        doctor: {
          id: appt.doctorId?._id?.toString() || appt.doctorId?.id,
          name: appt.doctorId?.name || "Doctor",
          specialization: appt.doctorId?.specialization || "General Medicine",
        },
        location: {
          id: appt.locationId?._id?.toString() || appt.locationId?.id,
          name: appt.locationId?.name || "Location",
        },
        diagnosis: appt.diagnosis || "",
        symptoms: appt.symptoms || "",
        notes: appt.notes || "",
        lastRecallSentAt: appt.lastRecallSentAt || null,
        recallCount: appt.recallCount || 0,
      };
    });

    // Filter by timeframe if requested
    let filtered = mapped;
    if (timeframe === "today") {
      filtered = mapped.filter((a: any) => a.statusCategory === "due_today");
    } else if (timeframe === "upcoming") {
      filtered = mapped.filter((a: any) => a.statusCategory === "upcoming");
    } else if (timeframe === "overdue") {
      filtered = mapped.filter((a: any) => a.statusCategory === "overdue");
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(
        (a: any) =>
          a.patient.name.toLowerCase().includes(q) ||
          a.patient.phone.includes(q) ||
          a.diagnosis.toLowerCase().includes(q)
      );
    }

    return reply.code(200).send(
      successResponse(
        {
          items: filtered,
          metrics: {
            dueTodayCount,
            upcomingCount,
            overdueCount,
            totalCount: mapped.length,
          },
        },
        "Follow-up recall register retrieved"
      )
    );
  } catch (err: any) {
    req.log.error(err, "Failed to get follow-up register");
    return reply.code(500).send(errorResponse(err.message || "Failed to retrieve follow-up register"));
  }
}

// ─── Dispatch WhatsApp / SMS Follow-Up Reminder ─────────────────
export async function sendFollowUpReminder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { phone, channel = "whatsapp" } = (req.body || {}) as {
      phone?: string;
      channel?: "whatsapp" | "sms";
    };

    const appointment = await Appointment.findById(id)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      })
      .populate("doctorId", "name specialization")
      .populate("locationId", "name city phone");

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentObjectAccess(req, reply, appointment, "staff-mutation"))) return;

    const targetPhone =
      phone?.trim() ||
      (appointment.patientId as any)?.phone ||
      (appointment.patientId as any)?.userId?.phone;

    const patientName =
      (appointment.patientId as any)?.name ||
      (appointment.patientId as any)?.userId?.name ||
      "Patient";

    if (!targetPhone) {
      return reply.code(400).send(errorResponse("Patient mobile number not available"));
    }

    try {
      const { sendFollowUpRecallNotification } = await import("../utilities/notifications.ts");
      await sendFollowUpRecallNotification({
        appointmentId: appointment._id.toString(),
        phone: targetPhone,
        channel,
      });
    } catch (msgErr) {
      console.warn("Follow-up reminder dispatch warning:", msgErr);
    }

    (appointment as any).lastRecallSentAt = new Date();
    (appointment as any).recallCount = ((appointment as any).recallCount || 0) + 1;
    await appointment.save();

    await AuditLog.create({
      userId: req.user!.id,
      action: "FOLLOW_UP_RECALL_SENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      category: "CLINICAL_WRITE",
      details: {
        channel,
        phone: targetPhone,
        tokenNumber: appointment.tokenNumber,
        recallCount: (appointment as any).recallCount,
      },
    });

    return reply.code(200).send(
      successResponse(
        {
          id: appointment._id.toString(),
          lastRecallSentAt: (appointment as any).lastRecallSentAt,
          recallCount: (appointment as any).recallCount,
          channel,
        },
        `Follow-up review reminder dispatched to ${patientName} via ${channel.toUpperCase()}`
      )
    );
  } catch (err: any) {
    req.log.error(err, "Failed to send follow-up reminder");
    return reply.code(500).send(errorResponse(err.message || "Failed to send follow-up reminder"));
  }
}
