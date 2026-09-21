import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { Organization } from "../models/Organization.ts";
import { Doctor } from "../models/Doctor.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { Encounter } from "../models/Encounter.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { SiteVisit } from "../models/SiteVisit.ts";
import { getAdaptiveConsultationDuration, autoDetectNoShows } from "./queue.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { successResponse, errorResponse, escapeRegex } from "../utilities/helpers.ts";
import {
  createTrackerCapability,
  getCheckInCapability,
  getTrackerCapability,
  hashTrackerCapability,
  isTrackerCapabilityEnforced,
} from "../utilities/publicTracker.ts";

export async function getOrganizations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgs = await Organization.find({ isActive: true }).sort({ name: 1 });
    return reply.code(200).send(successResponse(orgs));
  } catch (err) {
    console.error("getOrganizations error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getOrganizationDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid organization ID"));
    }

    const org = await Organization.findOne({ _id: id, isActive: true });

    if (!org) {
      return reply.code(404).send(errorResponse("Organization not found"));
    }

    const doctors = await Doctor.find({ organizationId: id }).populate("userId");

    const formattedDoctors = doctors
      .filter((d: any) => d.userId && d.userId.isActive)
      .map((d: any) => ({
        id: d.userId.id,
        name: d.userId.name,
        email: d.userId.email,
        specialization: d.specialization,
        qualification: d.qualification,
        experience_years: d.experience_years,
        fees: d.fees,
        timings: d.timings,
        working_days: d.working_days,
        description: d.description,
        image_url: d.image_url,
        rating: d.rating,
        reviewsCount: d.reviewsCount,
        languages: d.languages
      }));

    return reply.code(200).send(successResponse({
      ...org.toJSON(),
      doctors: formattedDoctors
    }));
  } catch (err) {
    console.error("getOrganizationDetails error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPublicClinics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { search, city, specialization } = req.query as {
      search?: string; city?: string; specialization?: string;
    };

    // Filter out orphan clinics belonging to deleted organizations
    const activeOrgs = await Organization.find({ isActive: true }).select("_id").lean();
    const activeOrgIds = activeOrgs.map((o) => o._id);

    const andConditions: any[] = [
      {
        $or: [
          { organizationId: { $in: activeOrgIds } },
          { organization_id: { $in: activeOrgIds } }
        ]
      },
      { isActive: true }
    ];

    if (city) {
      andConditions.push({ city: { $regex: new RegExp(escapeRegex(city), "i") } });
    }

    if (search) {
      const safeSearch = escapeRegex(search);

      // Search matching doctors by user name or doctor profile (specialty / qualification)
      const matchingUsers = await User.find({
        role: "doctor",
        isActive: true,
        name: { $regex: new RegExp(safeSearch, "i") },
      }).select("_id").lean();
      const userDoctorIds = matchingUsers.map((u) => u._id);

      const matchingDocProfiles = await Doctor.find({
        $or: [
          { specialization: { $regex: new RegExp(safeSearch, "i") } },
          { qualification: { $regex: new RegExp(safeSearch, "i") } },
        ],
      }).select("userId").lean();
      const profileDoctorIds = matchingDocProfiles.map((d) => d.userId);

      const combinedDoctorUserIds = [...new Set([...userDoctorIds, ...profileDoctorIds])];
      let doctorClinicIds: mongoose.Types.ObjectId[] = [];
      if (combinedDoctorUserIds.length > 0) {
        const docAssignments = await DoctorAssignment.find({
          doctorId: { $in: combinedDoctorUserIds },
          isActive: true,
        }).select("clinicId").lean();
        doctorClinicIds = docAssignments.map((a: any) => a.clinicId).filter(Boolean);
      }

      const searchOr: any[] = [
        { name: { $regex: new RegExp(safeSearch, "i") } },
        { city: { $regex: new RegExp(safeSearch, "i") } },
        { address: { $regex: new RegExp(safeSearch, "i") } }
      ];
      if (doctorClinicIds.length > 0) {
        searchOr.push({ _id: { $in: doctorClinicIds } });
      }

      andConditions.push({ $or: searchOr });
    }

    // Specialization filtering
    if (specialization) {
      const safeSpecialization = escapeRegex(specialization);
      const doctors = await Doctor.find({ specialization: { $regex: new RegExp(safeSpecialization, "i") } }).select("userId").lean();
      const doctorUserIds = doctors.map(d => d.userId);

      const assignments = await DoctorAssignment.find({ doctorId: { $in: doctorUserIds }, isActive: true }).select("clinicId").lean();
      const clinicIds = assignments.map(a => a.clinicId).filter(Boolean);

      andConditions.push({ _id: { $in: clinicIds } });
    }

    const filter: any = andConditions.length > 1 ? { $and: andConditions } : andConditions[0] || {};
    const clinics = await Clinic.find(filter).sort({ name: 1 });

    const clinicIds = clinics.map(c => c._id);
    const allAssignments = await DoctorAssignment.find({ clinicId: { $in: clinicIds }, isActive: true })
      .populate({ path: "doctorId", select: "name email phone isActive" })
      .lean();

    const allDoctorUserIds = allAssignments.map((a: any) => a.doctorId?._id).filter(Boolean);
    const docProfiles = allDoctorUserIds.length > 0
      ? await Doctor.find({ userId: { $in: allDoctorUserIds } }).lean()
      : [];
    const profileMap = new Map<string, any>();
    for (const p of docProfiles) {
      profileMap.set(String(p.userId), p);
    }

    const clinicAssignmentsMap = new Map<string, any[]>();
    for (const a of allAssignments) {
      if (!a.doctorId || !(a.doctorId as any).isActive) continue;
      const cid = String(a.clinicId);
      if (!clinicAssignmentsMap.has(cid)) clinicAssignmentsMap.set(cid, []);
      clinicAssignmentsMap.get(cid)!.push(a);
    }

    const orgIds = [...new Set(clinics.map((c) => (c.organizationId ? String(c.organizationId) : null)).filter(Boolean))];
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select("_id name logo_url image_url images").lean()
      : [];
    const orgMap = new Map<string, any>(orgs.map((o) => [String(o._id), o]));

    const formattedClinics = clinics.map((c) => {
      const json = c.toJSON();
      const org = orgMap.get(String(c.organizationId));
      const effectiveLogo = c.logo || org?.logo_url || org?.image_url || null;
      const effectiveImages = (Array.isArray(c.images) && c.images.length > 0) ? c.images : (org?.images || []);
      const effectiveCover = c.images?.[0] || org?.image_url || effectiveLogo || null;

      const assignments = clinicAssignmentsMap.get(String(c._id)) || [];
      const doctorsSummary = assignments.map((a: any) => {
        const profile = profileMap.get(String(a.doctorId._id));
        return {
          id: a.doctorId._id.toString(),
          name: a.doctorId.name,
          specialization: profile?.specialization || "General Medicine",
          fees: a.fees || 0,
        };
      });

      const feesList = doctorsSummary.map((d: any) => d.fees).filter((f: number) => f !== undefined && f !== null);
      const minFee = feesList.length > 0 ? Math.min(...feesList) : null;
      const specialties = [...new Set(doctorsSummary.map((d: any) => d.specialization).filter(Boolean))];

      return {
        ...json,
        logo_url: effectiveLogo,
        image_url: effectiveCover,
        images: effectiveImages,
        organizationName: org?.name || null,
        currency: org?.currency || "INR",
        doctorCount: doctorsSummary.length,
        minFee,
        specialties,
        doctorsSummary,
      };
    });

    return reply.code(200).send(successResponse(formattedClinics));
  } catch (err) {
    console.error("getPublicClinics error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPublicClinicDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const clinic = await Clinic.findOne({ _id: id, isActive: true });
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found"));
    }

    const assignments = await DoctorAssignment.find({ clinicId: id, isActive: true })
      .populate({
        path: "doctorId",
        select: "name email phone"
      })
      .lean();

    const doctorUserIds = assignments
      .map((a: any) => a.doctorId?._id)
      .filter(Boolean);

    const docProfiles = doctorUserIds.length > 0
      ? await Doctor.find({ userId: { $in: doctorUserIds } }).lean()
      : [];
    const docProfileMap = new Map<string, any>();
    for (const doc of docProfiles) {
      docProfileMap.set(String(doc.userId), doc);
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const formattedDoctors = await Promise.all(
      assignments.map(async (assign: any) => {
        if (!assign.doctorId) return null;
        
        const docProfile = docProfileMap.get(String(assign.doctorId._id));

        let workingDays = "Not specified";
        if (assign.workingHours) {
          if (typeof assign.workingHours === "object") {
            workingDays = Object.keys(assign.workingHours).join(", ");
          } else if (typeof assign.workingHours === "string") {
            try {
              const parsed = JSON.parse(assign.workingHours);
              if (typeof parsed === "object" && parsed !== null) {
                workingDays = Object.keys(parsed).join(", ");
              } else {
                workingDays = assign.workingHours;
              }
            } catch {
              workingDays = assign.workingHours;
            }
          }
        }

        // Check today's doctor availability override
        const todayDateStr = new Date().toISOString().slice(0, 10);
        const override = await DoctorDayOverride.findOne({
          clinicId: id,
          doctorId: assign.doctorId._id,
          date: todayDateStr,
        }).lean();

        let isAvailable = true;
        let overrideStatus = "available";
        let overrideReason: string | null = null;
        if (override) {
          overrideStatus = (override as any).status;
          overrideReason = (override as any).reason || null;
          if (overrideStatus === "unavailable" || overrideStatus === "on_leave" || overrideStatus === "emergency_unavailable") {
            isAvailable = false;
          }
        }

        // Live waiting patient count for this doctor today
        const waitingPatientsCount = await Appointment.countDocuments({
          clinicId: id,
          doctorId: assign.doctorId._id,
          status: { $in: ["pending", "confirmed", "checked-in"] },
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
        });

        const estDuration = assign.appointmentDuration || 15;
        const estimatedWaitMinutes = waitingPatientsCount * estDuration;

        // Check today's online booking cutoff vs safety buffer
        let isOnlineBookingClosed = false;
        let onlineBookingClosedReason: string | null = null;
        if (!isAvailable) {
          isOnlineBookingClosed = true;
          onlineBookingClosedReason = overrideReason ? `Doctor unavailable: ${overrideReason}` : "Doctor unavailable today";
        } else {
          try {
            const { getEffectiveDoctorSchedule } = await import("../services/SlotService.ts");
            const effectiveSchedule = await getEffectiveDoctorSchedule(
              assign.doctorId._id.toString(),
              id,
              new Date(),
              assign.workingHours
            );

            if (!effectiveSchedule.isWorkingDay) {
              isOnlineBookingClosed = true;
              onlineBookingClosedReason = "Not scheduled to practice today";
            } else {
              const [endH, endM] = (effectiveSchedule.dayEndTime || "17:00").split(":").map(Number);
              const closingMinutes = (endH || 0) * 60 + (endM || 0);
              const now = new Date();
              const currentMinutes = now.getHours() * 60 + now.getMinutes();
              const safetyBuffer = assign.onlineBookingSafetyBuffer ?? 30;
              const allowedOperatingMinutes = closingMinutes - safetyBuffer - currentMinutes;

              const estimatedQueueTime = waitingPatientsCount * estDuration;

              if (estimatedQueueTime + estDuration > allowedOperatingMinutes) {
                isOnlineBookingClosed = true;
                onlineBookingClosedReason = `Online same-day booking closed due to queue backlog (${safetyBuffer}m safety buffer enforced before shift end). Walk-in registration accepted at clinic.`;
              }
            }
          } catch {
            // fallback gracefully
          }
        }

        // Query upcoming doctor holidays/leaves for the next 30 days
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        const maxFutureDateStr = futureDate.toISOString().slice(0, 10);

        const upcomingOverrides = await DoctorDayOverride.find({
          clinicId: id,
          doctorId: assign.doctorId._id,
          date: { $gte: todayDateStr, $lte: maxFutureDateStr },
          status: "unavailable",
        }).select("date reason status").lean();

        const upcomingHolidays = upcomingOverrides.map((o: any) => ({
          date: o.date,
          reason: o.reason || "Doctor Holiday / Leave",
          status: o.status,
        }));

        return {
          id: assign.doctorId._id.toString(),
          doctorId: assign.doctorId._id.toString(),
          name: assign.doctorId.name,
          email: assign.doctorId.email,
          phone: assign.doctorId.phone,
          specialization: docProfile?.specialization || "General Medicine",
          qualification: docProfile?.qualification || "MBBS",
          experience_years: docProfile?.experience_years || 1,
          fees: assign.fees,
          feeType: (assign as any).feeType || (docProfile as any)?.feeType || "fixed",
          timings: assign.workingHours,
          working_days: workingDays,
          description: docProfile?.description || "",
          image_url: docProfile?.image_url || null,
          rating: docProfile?.rating || 5,
          reviewsCount: docProfile?.reviewsCount || 0,
          languages: docProfile?.languages || ["English"],
          bookingMode: assign.bookingMode || "sequential_queue",
          maxDailyTokens: assign.maxDailyTokens || null,
          isAvailable,
          overrideStatus,
          availabilityOverrideStatus: overrideStatus,
          overrideReason,
          upcomingHolidays,
          consultationDuration: assign.appointmentDuration || 15,
          waitingPatientsCount,
          estimatedWaitMinutes,
          isOnlineBookingClosed,
          onlineBookingClosedReason,
        };
      })
    );

    const cleanDoctors = formattedDoctors.filter(d => d !== null);

    const org = clinic.organizationId ? await Organization.findById(clinic.organizationId).lean() : null;
    const effectiveLogo = clinic.logo || org?.logo_url || org?.image_url || null;
    const effectiveImages = (Array.isArray(clinic.images) && clinic.images.length > 0) ? clinic.images : (org?.images || []);
    const effectiveCover = org?.image_url || clinic.images?.[0] || effectiveLogo || null;

    const clinicJson = clinic.toJSON();
    return reply.code(200).send(successResponse({
      ...clinicJson,
      logo_url: effectiveLogo,
      image_url: effectiveCover,
      images: effectiveImages,
      currency: org?.currency || (clinicJson as any).currency || "INR",
      organization: org ? {
        id: (org as any)._id.toString(),
        name: org.name,
        logo_url: org.logo_url,
        image_url: org.image_url,
        images: org.images || [],
        description: org.description,
        currency: org.currency || "INR",
        phone: org.phone,
        email: org.email,
        address: org.address,
        city: org.city,
      } : null,
      doctors: cleanDoctors
    }));
  } catch (err) {
    console.error("getPublicClinicDetails error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * POST /api/public/join-queue
 * Fast, unauthenticated mobile walk-in queue join flow triggered via Clinic QR Poster.
 * Target: Scan → Name/Phone → Doctor → Join Queue → Token → Track.
 */
export async function joinPublicQueue(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, name, phone, gender, notes } = req.body as {
      clinicId: string;
      doctorId: string;
      name: string;
      phone: string;
      gender?: "male" | "female" | "other";
      notes?: string;
    };

    if (!clinicId || !doctorId || !name?.trim() || !phone?.trim()) {
      return reply.code(400).send(errorResponse("Clinic, doctor, patient name, and mobile number are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId) || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid clinic or doctor ID format"));
    }

    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      return reply.code(400).send(errorResponse("Please enter a valid 10-digit mobile number"));
    }

    // 1. Verify Clinic & Active Organization
    const clinic = await Clinic.findOne({ _id: clinicId, isActive: true });
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic facility not found or currently inactive"));
    }

    const orgId = clinic.organizationId || (clinic as any).organization_id;
    const org = await Organization.findOne({ _id: orgId, isActive: true });
    if (!org) {
      return reply.code(400).send(errorResponse("Healthcare organization is currently inactive"));
    }

    // 2. Verify Doctor Assignment
    const assignment = await DoctorAssignment.findOne({ clinicId, doctorId, isActive: true });
    if (!assignment) {
      return reply.code(400).send(errorResponse("Doctor is not actively assigned to this clinic facility"));
    }

    // 3. Verify Doctor Availability for Today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const todayStr = new Date().toISOString().slice(0, 10);

    const override = await DoctorDayOverride.findOne({
      clinicId,
      doctorId,
      date: todayStr,
    });

    if (
      override &&
      (override.status === "unavailable" ||
        (override.status as string) === "on_leave" ||
        (override.status as string) === "emergency_unavailable")
    ) {
      const reason = override.reason ? `: ${override.reason}` : "";
      return reply.code(400).send(errorResponse(`Doctor is unavailable today${reason}. Please select another doctor.`));
    }

    // 4. Duplicate Active Token Guard
    const cleanPhoneLast10 = cleanPhone.slice(-10);
    let patient = await Patient.findOne({
      organizationId: org._id,
      phone: { $regex: cleanPhoneLast10 },
    });

    if (patient) {
      const activeAppt = await Appointment.findOne({
        clinicId,
        doctorId,
        patientId: patient._id,
        status: { $in: ["pending", "confirmed", "checked-in", "in-consultation"] },
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      });

      if (activeAppt) {
        const trackerCapability = createTrackerCapability();
        activeAppt.trackerTokenHash = trackerCapability.hash;
        activeAppt.trackerTokenExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        await activeAppt.save();

        return reply.code(200).send(successResponse({
          appointmentId: activeAppt._id.toString(),
          tokenNumber: activeAppt.tokenNumber,
          queuePosition: activeAppt.queuePosition || activeAppt.tokenNumber,
          isExisting: true,
          trackingUrl: `/track/${activeAppt._id}?t=${encodeURIComponent(trackerCapability.token)}`,
          trackerToken: trackerCapability.token,
        }, `You already hold active Token #${activeAppt.tokenNumber} for today! Opening your live tracker.`));
      }
    } else {
      patient = await Patient.create({
        organizationId: org._id,
        name: name.trim(),
        phone: cleanPhone,
        gender: gender || "other",
        dob: "2000-01-01",
      });
    }

    // 5. Atomic Token Generation
    const { getNextAtomicSequence } = await import("../models/Counter.ts");
    const counterKey = `token_${clinicId}_${doctorId}_${todayStr}`;
    const tokenNumber = await getNextAtomicSequence(counterKey);

    // 6. Dynamic Queue Wait Duration Calculation
    const queueCount = await Appointment.countDocuments({
      clinicId,
      doctorId,
      status: { $in: ["pending", "confirmed", "checked-in"] },
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    });

    const { duration: adaptiveDuration } = await getAdaptiveConsultationDuration(
      clinicId,
      doctorId,
      startOfDay,
      endOfDay,
      assignment.appointmentDuration || 15
    );

    const estWaitMinutes = queueCount * (adaptiveDuration || 15);
    const estCallTime = new Date(Date.now() + estWaitMinutes * 60000);

    // 7. Create Appointment with checked-in status for physical arrival
    const trackerCapability = createTrackerCapability();
    const appointment = await Appointment.create({
      organizationId: org._id,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber,
      trackerTokenHash: trackerCapability.hash,
      trackerTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      queuePosition: tokenNumber,
      duration: adaptiveDuration || 15,
      notes: notes?.trim() || "Walk-In self-registered via Clinic QR Poster",
    });

    // 8. Real-Time Broadcast & WhatsApp notification dispatch
    try {
      broadcastQueueUpdate(clinicId.toString(), {
        type: "QUEUE_UPDATED",
        data: {
          appointmentId: appointment._id.toString(),
          status: "checked-in",
          doctorId: doctorId.toString(),
          clinicId: clinicId.toString(),
          tokenNumber,
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-blocking broadcast
    }

    // Send WhatsApp confirmation (with tracking URL) asynchronously
    const { sendBookingNotification } = await import("../utilities/notifications.ts");
    sendBookingNotification(appointment._id, "booked", trackerCapability.token).catch((err) =>
      console.warn("[WhatsApp Notice] Walk-in notification dispatch skipped:", err?.message || err)
    );

    return reply.code(201).send(successResponse({
      appointmentId: appointment._id.toString(),
      tokenNumber: appointment.tokenNumber,
      queuePosition: appointment.queuePosition,
      estimatedWaitMinutes: estWaitMinutes,
      estimatedCallTime: estCallTime.toISOString(),
      isExisting: false,
      trackingUrl: `/track/${appointment._id}?t=${encodeURIComponent(trackerCapability.token)}`,
      trackerToken: trackerCapability.token,
    }, `Token #${appointment.tokenNumber} confirmed! Proceed to waiting lounge.`));
  } catch (err) {
    console.error("joinPublicQueue error:", err);
    return reply.code(500).send(errorResponse("Failed to join queue. Please speak with reception desk."));
  }
}

function publicTrackerAccessAllowed(req: FastifyRequest, appointment: { trackerTokenHash?: string | null; trackerTokenExpiresAt?: Date | null }): boolean {
  if (!isTrackerCapabilityEnforced()) return true;
  const token = getTrackerCapability(req);
  if (!token || !appointment.trackerTokenHash || !appointment.trackerTokenExpiresAt || appointment.trackerTokenExpiresAt.getTime() <= Date.now()) return false;
  const suppliedHash = hashTrackerCapability(token);
  return suppliedHash.length === appointment.trackerTokenHash.length && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(appointment.trackerTokenHash));
}

function publicCheckInCapabilityAllowed(
  req: FastifyRequest,
  appointment: { checkInTokenHash?: string | null; checkInTokenExpiresAt?: Date | null; checkInTokenUsedAt?: Date | null },
): boolean {
  const token = getCheckInCapability(req);
  if (!token || !appointment.checkInTokenHash || !appointment.checkInTokenExpiresAt || appointment.checkInTokenUsedAt) return false;
  if (appointment.checkInTokenExpiresAt.getTime() <= Date.now()) return false;
  const suppliedHash = hashTrackerCapability(token);
  return suppliedHash.length === appointment.checkInTokenHash.length && crypto.timingSafeEqual(
    Buffer.from(suppliedHash),
    Buffer.from(appointment.checkInTokenHash),
  );
}

/**
 * Issue a ten-minute, single-use mutation capability only after the caller has
 * presented the longer-lived private tracker capability. The token is never
 * derivable from an appointment ID and is consumed atomically by check-in.
 */
export async function issuePublicTrackerCheckInCapability(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment tracking ID"));
    }
    const appointment = await Appointment.findById(appointmentId).select("+trackerTokenHash");
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    if (!publicTrackerAccessAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid appointment tracker link is required"));
    }
    if (!["pending", "confirmed"].includes(appointment.status)) {
      return reply.code(409).send(errorResponse("This appointment is not eligible for self check-in"));
    }

    const capability = createTrackerCapability();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const issued = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: { $in: ["pending", "confirmed"] } },
      {
        $set: {
          checkInTokenHash: capability.hash,
          checkInTokenExpiresAt: expiresAt,
          checkInTokenUsedAt: null,
        },
      },
      { returnDocument: "after" },
    );
    if (!issued) {
      return reply.code(409).send(errorResponse("This appointment is no longer eligible for self check-in"));
    }

    return reply.code(200).send(successResponse({
      checkInToken: capability.token,
      expiresAt: expiresAt.toISOString(),
    }));
  } catch (err) {
    console.error("issuePublicTrackerCheckInCapability error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPublicAppointmentTracker(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment tracking ID"));
    }

    const appointment = await Appointment.findById(appointmentId)
      .select("+trackerTokenHash trackerTokenExpiresAt")
      .populate("clinicId", "name city address phone upiVpa merchantName")
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name" },
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found or tracking link has expired"));
    }
    if (!publicTrackerAccessAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid appointment tracker link is required"));
    }

    const clinicId = (appointment.clinicId as any)?._id || appointment.clinicId;
    const doctorId = (appointment.doctorId as any)?._id || appointment.doctorId;

    // Doctor details & assignment
    const doctorAssignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
    const defaultDuration = doctorAssignment?.appointmentDuration || 15;
    const docProfile = await Doctor.findOne({ userId: doctorId }).lean();
    const doctorSpecialization = docProfile?.specialization || (appointment.doctorId as any)?.specialization || "General Physician";

    const apptDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(apptDate.getFullYear(), apptDate.getMonth(), apptDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(apptDate.getFullYear(), apptDate.getMonth(), apptDate.getDate(), 23, 59, 59, 999);

    // Check same-day DoctorDayOverride
    const dateStr = apptDate.toISOString().slice(0, 10);
    const dayOverride = await DoctorDayOverride.findOne({
      doctorId,
      clinicId,
      date: dateStr,
    });

    const doctorAvailability = {
      status: dayOverride?.status || "available",
      isAvailable: dayOverride ? dayOverride.status !== "unavailable" : true,
      reason: dayOverride?.reason || null,
      delayMinutes: (dayOverride as any)?.delayMinutes || 0,
    };

    // Calculate adaptive consultation duration based on today's actual completed encounters
    const { duration, isAdaptive, sampleCount } = await getAdaptiveConsultationDuration(
      clinicId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );

    // Auto sweep no shows for today
    await autoDetectNoShows(clinicId, doctorId, startOfDay, endOfDay);

    // Fetch all active appointments for this doctor & clinic on this day
    const appointmentsToday = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $nin: ["cancelled"] },
    }).sort({ queuePosition: 1, tokenNumber: 1 });

    const inConsultationAppt = appointmentsToday.find((a) => a.status === "in-consultation");
    const currentlyServingToken = inConsultationAppt ? inConsultationAppt.tokenNumber : null;

    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const activeEncounter = await Encounter.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1000));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }

    let peopleAhead = 0;
    let estimatedWaitMinutes = 0;
    let estimatedCallTime: string | null = null;

    const waitingStatuses = ["pending", "confirmed", "checked-in"];
    const myRank = appointment.queuePosition ?? appointment.tokenNumber ?? 999;

    if (appointment.status === "in-consultation") {
      peopleAhead = 0;
      estimatedWaitMinutes = 0;
      estimatedCallTime = new Date().toISOString();
    } else if (appointment.status === "standby") {
      peopleAhead = 0; // Next Up priority upon resuming!
      estimatedWaitMinutes = inConsultationRemainingMinutes;
      estimatedCallTime = new Date(Date.now() + estimatedWaitMinutes * 60 * 1000).toISOString();
    } else if (waitingStatuses.includes(appointment.status)) {
      peopleAhead = appointmentsToday.filter((a) => {
        const aRank = a.queuePosition ?? a.tokenNumber ?? 999;
        const isAhead = aRank < myRank;
        const isWaitingOrInConsultation = [...waitingStatuses, "in-consultation"].includes(a.status);
        return isAhead && isWaitingOrInConsultation;
      }).length;

      estimatedWaitMinutes = inConsultationRemainingMinutes + (peopleAhead * duration);
      estimatedCallTime = new Date(Date.now() + estimatedWaitMinutes * 60 * 1000).toISOString();
    }

    const patientName =
      (appointment.patientId as any)?.name ||
      (appointment.patientId as any)?.userId?.name ||
      "Patient";

    let consultationSummary: any = null;
    let billing: any = null;

    if (appointment.status === "completed" || appointment.status === "in-consultation") {
      const encounter = await Encounter.findOne({ appointmentId: appointment._id }).sort({ createdAt: -1 });
      if (encounter) {
        const { ClinicalNote } = await import("../models/ClinicalNote.ts");
        const { Prescription } = await import("../models/Prescription.ts");
        const { decryptField } = await import("../utilities/cryptoEnvelope.ts");

        const note = (await ClinicalNote.findOne({ encounterId: encounter._id, isLatest: true }).lean()) as any;
        let prescriptions = (await Prescription.find({ encounterId: encounter._id, deletedAt: null }).lean()) as any[];

        if (prescriptions.length === 0 && note?.plan?.prescriptionIds?.length > 0) {
          prescriptions = (await Prescription.find({ _id: { $in: note.plan.prescriptionIds }, deletedAt: null }).lean()) as any[];
        }

        if (note || prescriptions.length > 0) {
          const rawDoctorAdvice = note?.plan?.treatmentPlan || note?.subjective?.historyOfPresentIllness;
          const doctorAdvice = (rawDoctorAdvice ? decryptField(rawDoctorAdvice) : null) || "Follow all prescribed medicines and maintain adequate hydration.";

          consultationSummary = {
            completedAt: encounter.endedAt || (appointment as any).updatedAt || new Date().toISOString(),
            chiefComplaint: note?.subjective?.chiefComplaint || null,
            diagnoses:
              note?.assessment?.diagnoses?.map((d: any) => ({
                code: d.code,
                description: d.description,
              })) || [],
            doctorAdvice,
            followUp: note?.plan?.followUpDate
              ? {
                  date: note.plan.followUpDate,
                  instructions: note.plan.followUpInstructions || "Follow up with attending physician as scheduled.",
                }
              : null,
            prescriptions: prescriptions.map((p: any) => ({
              id: p._id.toString(),
              medicineName: p.medicineName,
              dosage: p.dosage,
              frequency: p.frequency,
              duration: p.duration,
              instructions: p.instructions || "As instructed",
              status: p.status,
            })),
            signedBy: note?.signature?.signerName || (appointment.doctorId as any)?.name || null,
            signedAt: note?.signature?.signedAt || encounter.endedAt || null,
          };
        }
      }

      // Check for linked invoice
      const { Invoice } = await import("../models/Invoice.ts");
      const invoiceFilter: any = {
        deletedAt: null,
        $or: [
          { appointmentId: appointment._id },
          ...(encounter ? [{ encounterId: encounter._id }] : []),
        ],
      };
      const invoice = (await Invoice.findOne(invoiceFilter).sort({ createdAt: -1 }).lean()) as any;
      if (invoice) {
        billing = {
          invoiceId: invoice._id.toString(),
          invoiceNumber: invoice.invoiceNumber,
          totalAmount: invoice.totalAmount || 0,
          amountPaid: invoice.amountPaid || 0,
          balanceDue:
            invoice.balanceDue !== undefined
              ? invoice.balanceDue
              : Math.max(0, (invoice.totalAmount || 0) - (invoice.amountPaid || 0)),
          status: invoice.status,
          paymentMethod: invoice.paymentMethod || null,
          paymentDate: invoice.paymentDate || null,
          items: (invoice.items || []).map((it: any) => ({
            description: it.description,
            quantity: it.quantity,
            amount: it.amount,
            total: it.totalItemAmount || it.amount * it.quantity,
          })),
        };
      }
    }

    const rxList = consultationSummary?.prescriptions || [];
    const pharmacyStatus = rxList.length === 0
      ? "none"
      : rxList.every((p: any) => p.status === "dispensed")
        ? "dispensed"
        : "sent_to_pharmacy";

    // Check if an auto-booked follow-up review appointment exists
    let followUpAppointment: any = null;
    const followUpDoc = (await Appointment.findOne({
      followUpForAppointmentId: appointment._id,
      status: { $ne: "cancelled" },
    })
      .select("tokenNumber appointmentTime status")
      .lean()) as any;

    if (followUpDoc) {
      followUpAppointment = {
        id: followUpDoc._id.toString(),
        tokenNumber: followUpDoc.tokenNumber,
        appointmentTime: followUpDoc.appointmentTime,
        status: followUpDoc.status,
      };
    }

    return reply.code(200).send(
      successResponse({
        appointmentId: appointment._id,
        tokenNumber: appointment.tokenNumber,
        queuePosition: appointment.queuePosition,
        status: appointment.status,
        paymentStatus: appointment.paymentStatus || (billing ? (billing.balanceDue === 0 ? "paid" : "unpaid") : "unpaid"),
        appointmentTime: appointment.appointmentTime,
        appointmentType: appointment.appointmentType,
        patientName,
        doctor: {
          id: (appointment.doctorId as any)?._id || appointment.doctorId,
          name: (appointment.doctorId as any)?.name || "Doctor",
          specialization: doctorSpecialization,
        },
        clinic: {
          id: (appointment.clinicId as any)?._id || appointment.clinicId,
          name: (appointment.clinicId as any)?.name || "Clinic",
          city: (appointment.clinicId as any)?.city || "",
          address: (appointment.clinicId as any)?.address || "",
          phone: (appointment.clinicId as any)?.phone || "",
          upiVpa: (appointment.clinicId as any)?.upiVpa || "",
          merchantName: (appointment.clinicId as any)?.merchantName || (appointment.clinicId as any)?.name || "",
        },
        currentlyServingToken,
        peopleAhead,
        estimatedWaitMinutes,
        estimatedCallTime,
        averageDuration: duration,
        isAdaptiveDuration: isAdaptive,
        adaptiveSampleCount: sampleCount,
        doctorAvailability,
        isToday: dateStr === new Date().toISOString().slice(0, 10),
        disruptionResponseDeadline: appointment.disruptionResponseDeadline || null,
        triageAction: appointment.triageAction || "pending",
        parkedAt: appointment.parkedAt || null,
        parkedReason: appointment.parkedReason || null,
        patientReturned: appointment.patientReturned || false,
        patientReturnedAt: appointment.patientReturnedAt || null,
        consultationPhase: appointment.consultationPhase || "single",
        investigationSentAt: appointment.investigationSentAt || null,
        investigationNotes: appointment.investigationNotes || null,
        delayNotifiedAt: appointment.delayNotifiedAt || null,
        lastNotifiedDelayMinutes: appointment.lastNotifiedDelayMinutes || null,
        consultationSummary,
        pharmacyStatus,
        followUpAppointment,
        billing,
        vitals: (appointment as any).vitals || null,
        isEmergency: (appointment as any).isEmergency || false,
        investigationResults: (appointment as any).investigationResults || [],
      })
    );
  } catch (err) {
    console.error("getPublicAppointmentTracker error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function processPublicTrackerCheckIn(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment tracking ID"));
    }

    const appointment = await Appointment.findById(appointmentId)
      .select("+trackerTokenHash +checkInTokenHash")
      .populate("clinicId", "name city")
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    if (!publicTrackerAccessAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid appointment tracker link is required"));
    }
    if (!publicCheckInCapabilityAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid, unexpired self check-in capability is required"));
    }

    if (appointment.status === "cancelled" || appointment.status === "completed" || appointment.status === "no-show") {
      return reply.code(400).send(errorResponse(`Cannot check in for an appointment that is ${appointment.status}`));
    }

    // Check doctor day override for today
    const todayStr = new Date().toISOString().slice(0, 10);
    const dayOverride = await DoctorDayOverride.findOne({
      doctorId: (appointment.doctorId as any)?._id || appointment.doctorId,
      clinicId: (appointment.clinicId as any)?._id || appointment.clinicId,
      date: todayStr,
      status: "unavailable",
    });

    if (dayOverride) {
      return reply.code(400).send(
        errorResponse(
          `Doctor is currently unavailable today (${dayOverride.reason || "Doctor away"}). Please speak with the front desk.`
        )
      );
    }

    // The same capability can win this guarded transition only once. A replay
    // cannot move another appointment or create a second check-in event.
    const checkedIn = await Appointment.findOneAndUpdate(
      {
        _id: appointment._id,
        status: { $in: ["pending", "confirmed"] },
        checkInTokenHash: appointment.checkInTokenHash,
        checkInTokenExpiresAt: { $gt: new Date() },
        checkInTokenUsedAt: null,
      },
      {
        $set: {
          status: "checked-in",
          checkInTokenUsedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!checkedIn) {
      return reply.code(409).send(errorResponse("Self check-in capability has already been used or expired"));
    }

    const clinicIdStr = ((appointment.clinicId as any)?._id || appointment.clinicId).toString();
    const doctorIdStr = ((appointment.doctorId as any)?._id || appointment.doctorId).toString();
    const patientName = (appointment.patientId as any)?.name || (appointment.patientId as any)?.userId?.name || "Patient";

    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        status: "checked-in",
        clinicId: clinicIdStr,
      },
      timestamp: new Date().toISOString(),
    });

    await eventBus.publishDurable({
      eventType: EVENT_TYPES.PATIENT_APPOINTMENT_CHECKED_IN,
      category: "patient",
      targetUserId: doctorIdStr,
      title: "Patient Self-Arrived ✅",
      message: `${patientName} (Token #${appointment.tokenNumber}) checked in via Live Tracker.`,
      severity: "info",
      actionUrl: "/dashboard/queue",
      metadata: { appointmentId: appointment._id, tokenNumber: appointment.tokenNumber },
    });

    await AuditLog.create({
      userId: (appointment.patientId as any)?.userId?._id || new mongoose.Types.ObjectId(),
      action: "PATIENT_SELF_CHECKIN_TRACKER",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { tokenNumber: appointment.tokenNumber, clinicId: clinicIdStr },
    });

    return reply.code(200).send(
      successResponse(
        {
          appointmentId: appointment._id,
          status: "checked-in",
          tokenNumber: appointment.tokenNumber,
          alreadyCheckedIn: false,
        },
        `Checked in successfully! You are now in the active queue with Token #${appointment.tokenNumber}`
      )
    );
  } catch (err) {
    console.error("processPublicTrackerCheckIn error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function processPublicTrackerReturn(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment tracking ID"));
    }

    const appointment = await Appointment.findById(appointmentId)
      .select("+trackerTokenHash trackerTokenExpiresAt")
      .populate("clinicId", "name")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone" },
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    if (!publicTrackerAccessAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid appointment tracker link is required"));
    }

    if (appointment.status !== "standby") {
      return reply.code(400).send(errorResponse(`Cannot mark returned: Appointment status is ${appointment.status}, not standby`));
    }

    appointment.patientReturned = true;
    appointment.patientReturnedAt = new Date();
    await appointment.save();

    const patientName =
      (appointment.patientId as any)?.name ||
      (appointment.patientId as any)?.userId?.name ||
      "Patient";

    const clinicIdStr = (appointment.clinicId as any)?._id?.toString() || appointment.clinicId.toString();

    // Broadcast WebSocket event to clinic reception desk
    try {
      broadcastQueueUpdate(clinicIdStr, {
        type: "PATIENT_RETURNED" as any,
        data: {
          appointmentId: appointment._id,
          tokenNumber: appointment.tokenNumber,
          patientName,
          returnedAt: appointment.patientReturnedAt,
        },
        message: `Token #${appointment.tokenNumber} (${patientName}) has returned to the waiting room.`,
      });
      broadcastQueueUpdate(clinicIdStr, {
        type: "QUEUE_UPDATED",
      });
    } catch (wsErr) {
      console.warn("WebSocket PATIENT_RETURNED broadcast failed:", wsErr);
    }

    return reply.code(200).send(
      successResponse(
        {
          appointmentId: appointment._id,
          tokenNumber: appointment.tokenNumber,
          status: appointment.status,
          patientReturned: true,
          patientReturnedAt: appointment.patientReturnedAt,
        },
        "Reception notified. You are marked in the waiting room and will be called Next Up."
      )
    );
  } catch (err) {
    console.error("processPublicTrackerReturn error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

function maskName(name: string): string {
  if (!name || name === "Patient") return "Patient";
  const parts = name.trim().split(" ");
  if (parts.length === 1) {
    return parts[0].length <= 3 ? parts[0] : parts[0].slice(0, 2) + "***";
  }
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export async function getPublicQueueTv(req: FastifyRequest, reply: FastifyReply) {
  try {
    const clinicId = (req.params as any)?.clinicId || (req.query as any)?.clinicId;
    const { doctorId } = req.query as { doctorId?: string };

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const clinic = await Clinic.findById(clinicId).select("name city address phone").lean();
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found"));
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const query: any = {
      clinicId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $nin: ["cancelled"] },
    };

    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
      query.doctorId = doctorId;
    }

    const appointments = await Appointment.find(query)
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name" },
      })
      .sort({ queuePosition: 1, tokenNumber: 1 })
      .lean();

    const inConsult = appointments.find((a) => a.status === "in-consultation");
    const activeToken = inConsult
      ? {
          id: inConsult._id,
          tokenNumber: inConsult.tokenNumber,
          status: inConsult.status,
          consultationPhase: inConsult.consultationPhase,
          patientName: maskName((inConsult.patientId as any)?.name || (inConsult.patientId as any)?.userId?.name || "Patient"),
          doctorName: (inConsult.doctorId as any)?.name || "Doctor",
          specialization: (inConsult.doctorId as any)?.specialization || "General Medicine",
          room: "OPD Room 1",
          isEmergency: (inConsult as any).isEmergency || false,
        }
      : null;

    // Filter waiting queue
    const waiting = appointments
      .filter((a) => a._id.toString() !== inConsult?._id?.toString() && ["checked-in", "standby", "confirmed", "pending"].includes(a.status))
      .slice(0, 8)
      .map((item, idx) => ({
        id: item._id,
        tokenNumber: item.tokenNumber,
        queuePosition: item.queuePosition !== undefined ? item.queuePosition : idx + 1,
        status: item.status,
        consultationPhase: item.consultationPhase,
        patientName: maskName((item.patientId as any)?.name || (item.patientId as any)?.userId?.name || "Patient"),
        doctorName: (item.doctorId as any)?.name || "Doctor",
        isReportReview: item.consultationPhase === "report_review" || item.reasonForVisit === "report_review",
        isStandby: item.status === "standby",
        patientReturned: item.patientReturned || false,
        isEmergency: (item as any).isEmergency || false,
      }));

    // Check if Doctor / Clinic is currently on an OPD break
    const { OpdSession } = await import("../models/OpdSession.ts");
    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");

    const dateStr = now.toISOString().slice(0, 10);
    const sessionQuery: any = { clinicId, date: dateStr, status: "active" };
    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
      sessionQuery.doctorId = doctorId;
    }
    const opdSession = await OpdSession.findOne(sessionQuery).sort({ updatedAt: -1 }).lean();

    const doctorBreak = opdSession && opdSession.isOnBreak
      ? {
          isOnBreak: true,
          reason: opdSession.breakReason || "Short Intermission",
          expectedMinutes: opdSession.breakExpectedMinutes || 15,
          startedAt: opdSession.breakStartedAt,
        }
      : {
          isOnBreak: false,
        };

    // Construct Multi-Cabin Polyclinic Grid Matrix
    const assignments = await DoctorAssignment.find({ clinicId, isActive: true })
      .populate("doctorId", "name")
      .lean();

    const doctorUserIds = assignments.map((a: any) => a.doctorId?._id || a.doctorId).filter(Boolean);
    const doctorProfiles = await Doctor.find({
      $or: [
        { userId: { $in: doctorUserIds } },
        { _id: { $in: doctorUserIds } },
      ],
    }).lean();
    const docProfileMap = new Map();
    for (const dp of doctorProfiles) {
      if (dp.userId) docProfileMap.set(dp.userId.toString(), dp);
      docProfileMap.set(dp._id.toString(), dp);
    }

    const doctorMap = new Map<string, any>();
    for (const a of assignments) {
      if (a.doctorId) {
        const dId = (a.doctorId as any)._id?.toString() || (a.doctorId as any).id?.toString();
        const profile = docProfileMap.get(dId);
        const spec = profile?.specialization || (a.doctorId as any).specialization || "General Medicine";
        doctorMap.set(dId, {
          doctorId: dId,
          doctorName: (a.doctorId as any).name || "Doctor",
          specialization: spec,
          specialty: spec,
          cabinNumber: a.cabinNumber || profile?.cabinNumber || `Cabin ${doctorMap.size + 1}`,
        });
      }
    }

    // Also include any doctors present in today's clinic appointments
    for (const appt of appointments) {
      const dId = (appt.doctorId as any)?._id?.toString() || (appt.doctorId as any)?.id?.toString() || (appt.doctorId as any)?.toString();
      if (dId && !doctorMap.has(dId)) {
        const profile = docProfileMap.get(dId);
        const spec = profile?.specialization || (appt.doctorId as any)?.specialization || "General OPD";
        doctorMap.set(dId, {
          doctorId: dId,
          doctorName: (appt.doctorId as any)?.name || "Doctor",
          specialization: spec,
          specialty: spec,
          cabinNumber: profile?.cabinNumber || `Cabin ${doctorMap.size + 1}`,
        });
      }
    }

    const activeSessions = await OpdSession.find({ clinicId, date: dateStr, status: "active" }).lean();
    const sessionMap = new Map<string, any>();
    for (const s of activeSessions) {
      if (s.doctorId) sessionMap.set(s.doctorId.toString(), s);
    }

    const cabins = Array.from(doctorMap.values()).map((docInfo) => {
      const docAppts = appointments.filter((a) => {
        const aDocId = (a.doctorId as any)?._id?.toString() || (a.doctorId as any)?.id?.toString() || (a.doctorId as any)?.toString();
        return aDocId === docInfo.doctorId;
      });

      const docInConsult = docAppts.find((a) => a.status === "in-consultation");
      const docWaiting = docAppts
        .filter((a) => a._id.toString() !== docInConsult?._id?.toString() && ["checked-in", "standby", "confirmed", "pending"].includes(a.status))
        .slice(0, 3)
        .map((item, idx) => ({
          id: item._id,
          tokenNumber: item.tokenNumber,
          queuePosition: item.queuePosition !== undefined ? item.queuePosition : idx + 1,
          status: item.status,
          consultationPhase: item.consultationPhase,
          patientName: maskName((item.patientId as any)?.name || (item.patientId as any)?.userId?.name || "Patient"),
          isReportReview: item.consultationPhase === "report_review" || item.reasonForVisit === "report_review",
          isEmergency: (item as any).isEmergency || false,
        }));

      const docBreakSession = sessionMap.get(docInfo.doctorId);
      const isOnBreak = Boolean(docBreakSession && docBreakSession.isOnBreak);

      return {
        doctorId: docInfo.doctorId,
        doctorName: docInfo.doctorName,
        specialization: docInfo.specialization,
        specialty: docInfo.specialty || docInfo.specialization,
        cabinNumber: docInfo.cabinNumber,
        activeToken: docInConsult
          ? {
              id: docInConsult._id,
              tokenNumber: docInConsult.tokenNumber,
              status: docInConsult.status,
              consultationPhase: docInConsult.consultationPhase,
              patientName: maskName((docInConsult.patientId as any)?.name || (docInConsult.patientId as any)?.userId?.name || "Patient"),
              isEmergency: (docInConsult as any).isEmergency || false,
            }
          : null,
        upcomingQueue: docWaiting,
        isOnBreak,
        breakReason: docBreakSession?.breakReason || "Short Intermission",
        breakExpectedMinutes: docBreakSession?.breakExpectedMinutes || 15,
      };
    });

    return reply.code(200).send(
      successResponse({
        clinic: {
          id: clinic._id,
          name: clinic.name,
          city: clinic.city,
        },
        activeToken,
        waitingQueue: waiting,
        totalWaiting: waiting.length,
        doctorBreak,
        cabins,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    console.error("getPublicQueueTv error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function printPublicTrackerPrescription(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };
    const { autoPrint } = req.query as { autoPrint?: string };

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment tracking ID"));
    }

    const appointment = await Appointment.findById(appointmentId)
      .select("+trackerTokenHash trackerTokenExpiresAt")
      .populate("clinicId", "name address phone city")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone dob gender" },
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    if (!publicTrackerAccessAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid appointment tracker link is required"));
    }

    const encounter = await Encounter.findOne({ appointmentId: appointment._id }).sort({ createdAt: -1 });
    const { ClinicalNote } = await import("../models/ClinicalNote.ts");
    const { Prescription } = await import("../models/Prescription.ts");
    const { Doctor } = await import("../models/Doctor.ts");
    const { decryptField } = await import("../utilities/cryptoEnvelope.ts");

    const note = encounter
      ? (((await ClinicalNote.findOne({ encounterId: encounter._id, isLatest: true }).lean()) as any) || null)
      : null;
    let prescriptions = encounter
      ? (((await Prescription.find({ encounterId: encounter._id, deletedAt: null }).lean()) as any[]) || [])
      : [];

    if (prescriptions.length === 0 && note?.plan?.prescriptionIds?.length > 0) {
      prescriptions = (await Prescription.find({ _id: { $in: note.plan.prescriptionIds }, deletedAt: null }).lean()) as any[];
    }

    const doctorUserId = (appointment.doctorId as any)?._id || appointment.doctorId;
    const doctorProfile = (await Doctor.findOne({ userId: doctorUserId }).lean()) as any;

    const patientDoc = appointment.patientId as any;
    const patientUser = patientDoc?.userId || {};
    const patientName = patientDoc?.name || patientUser?.name || "Patient";
    const patientGender = patientDoc?.gender || patientUser?.gender || "N/A";
    let patientAge: number | undefined = undefined;
    const dob = patientDoc?.dob || patientUser?.dob;
    if (dob) {
      patientAge = new Date().getFullYear() - new Date(dob).getFullYear();
    }

    const clinicDoc = appointment.clinicId as any;
    const { generatePrintablePrescriptionHtml } = await import("../utilities/prescriptionFormatter.ts");

    const docRawName = (appointment.doctorId as any)?.name || "Attending Physician";
    const formattedDoctorName = docRawName.startsWith("Dr.") ? docRawName : `Dr. ${docRawName}`;

    const apptPrescriptions = (prescriptions.length > 0
      ? prescriptions.map((p: any) => ({
          medicineName: p.medicineName,
          dosage: p.dosage,
          frequency: p.frequency,
          duration: p.duration,
          instructions: p.instructions,
        }))
      : (appointment.prescriptions || []).map((p: any) => ({
          medicineName: p.name,
          dosage: p.dosage,
          frequency: "1-0-1",
          duration: p.duration,
          instructions: "Follow prescribed meal instructions",
        })));

    const investigations = appointment.investigationResults && appointment.investigationResults.length > 0
      ? appointment.investigationResults.map((inv: any) => ({
          testName: inv.testName,
          value: inv.value,
          unit: inv.unit,
          isAbnormal: inv.isAbnormal,
        }))
      : undefined;

    const diagnoses = (note?.assessment?.diagnoses?.map((d: any) => d.description || d.code) || [])
      .concat(appointment.diagnosis ? [appointment.diagnosis] : []);

    const rawDoctorAdvice = note?.plan?.treatmentPlan || note?.subjective?.historyOfPresentIllness || appointment.notes;
    const doctorAdvice = rawDoctorAdvice ? decryptField(rawDoctorAdvice) : undefined;

    const html = generatePrintablePrescriptionHtml({
      clinicName: clinicDoc?.name || "Healthcare Clinic",
      clinicAddress: clinicDoc?.address || clinicDoc?.city || "Medical Plaza",
      clinicPhone: clinicDoc?.phone || "Reception",
      doctorName: formattedDoctorName,
      doctorSpecialty: doctorProfile?.specialization || "General Medicine & Primary Care",
      doctorLicenseNumber: doctorProfile?.licenseNumber,
      patientName,
      patientAge,
      patientGender,
      encounterDate: encounter?.endedAt ? new Date(encounter.endedAt).toLocaleDateString() : new Date().toLocaleDateString(),
      chiefComplaint: note?.subjective?.chiefComplaint || appointment.symptoms,
      diagnoses,
      doctorAdvice,
      followUpDate: note?.plan?.followUpDate ? new Date(note.plan.followUpDate).toLocaleDateString() : undefined,
      followUpInstructions: note?.plan?.followUpInstructions,
      medications: apptPrescriptions,
      investigations,
      autoPrint: autoPrint === "true" || autoPrint === "1",
    });

    return reply.type("text/html").send(html);
  } catch (err) {
    console.error("printPublicTrackerPrescription error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function processPublicTrackerPayment(_req: FastifyRequest, reply: FastifyReply) {
  return reply.code(410).send(
    errorResponse("Direct public payment settlement has been retired. Create a verified payment order or pay at the clinic.")
  );
}

// ─── Public Site Traffic & Visitor Tracking ────────────────────────
export async function trackSiteVisitController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { path, clinicId, organizationId, visitorId, referrer } = (req.body || {}) as {
      path?: string;
      clinicId?: string;
      organizationId?: string;
      visitorId?: string;
      referrer?: string;
    };

    if (!path) {
      return reply.code(400).send(errorResponse("Path is required"));
    }

    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const cleanIp = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress.split(",")[0].trim();
    const userAgent = (req.headers["user-agent"] as string) || "";

    let device: "Desktop" | "Mobile" | "Tablet" | "Other" = "Desktop";
    if (/tablet|ipad/i.test(userAgent)) device = "Tablet";
    else if (/mobile|iphone|android/i.test(userAgent)) device = "Mobile";

    let browser = "Other";
    if (/edg/i.test(userAgent)) browser = "Edge";
    else if (/chrome/i.test(userAgent)) browser = "Chrome";
    else if (/safari/i.test(userAgent)) browser = "Safari";
    else if (/firefox/i.test(userAgent)) browser = "Firefox";

    let os = "Other";
    if (/windows/i.test(userAgent)) os = "Windows";
    else if (/macintosh|mac os/i.test(userAgent)) os = "macOS";
    else if (/iphone|ipad|ios/i.test(userAgent)) os = "iOS";
    else if (/android/i.test(userAgent)) os = "Android";
    else if (/linux/i.test(userAgent)) os = "Linux";

    const todayStr = new Date().toISOString().slice(0, 10);

    await SiteVisit.create({
      date: todayStr,
      path: path.slice(0, 200),
      clinicId: clinicId && mongoose.Types.ObjectId.isValid(clinicId) ? clinicId : undefined,
      organizationId: organizationId && mongoose.Types.ObjectId.isValid(organizationId) ? organizationId : undefined,
      visitorId: visitorId ? String(visitorId).slice(0, 100) : undefined,
      ipAddress: cleanIp,
      userAgent: userAgent.slice(0, 300),
      device,
      browser,
      os,
      referrer: referrer ? String(referrer).slice(0, 300) : "",
    });

    return reply.code(200).send(successResponse({ recorded: true }));
  } catch (err: any) {
    console.error("trackSiteVisitController error:", err);
    return reply.code(200).send(successResponse({ recorded: false }));
  }
}
