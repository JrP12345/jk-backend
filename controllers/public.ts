import type { FastifyRequest, FastifyReply } from "fastify";
import { publicFacilityType } from "../utilities/facility.ts";
import { organizationImageReference, locationBranding, publicBrandingImages } from "../services/OrganizationBranding.ts";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { publicSlug, publicSlugs, resolvePublicId } from "../utilities/publicLinks.ts";
import { isActiveBookingDoctor } from "../utilities/doctorBookingEligibility.ts";
import { Organization } from "../models/Organization.ts";
import { Doctor } from "../models/Doctor.ts";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { getPublicLocationFacets, getSortedPublicLocationPage } from "../utilities/publicLocationCatalog.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Location } from "../models/Location.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { Encounter } from "../models/Encounter.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { SiteVisit } from "../models/SiteVisit.ts";
import { analyticsPath, referrerOrigin } from "../utilities/trafficPrivacy.ts";
import { getAdaptiveConsultationDuration } from "./queue.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { successResponse, errorResponse, escapeRegex, normalizePhone } from "../utilities/helpers.ts";
import {
  createTrackerCapability,
  getCheckInCapability,
  getTrackerCapability,
  hashTrackerCapability,
  hasValidTrackerCapability,
} from "../utilities/publicTracker.ts";
import { toPublicOrganizationSummary, toPublicOrganizationDetail, toPublicLocation } from "../types/publicDtos.ts";
import { canCreateLocationBooking, canCreateOrganizationBooking, getOrganizationBookingAccess } from "../services/billing/SubscriptionAccess.ts";
import { locationClockMinutes, locationDateKey, locationDayRange, getLocationTimezone } from "../utilities/locationTime.ts";
import {
  getCursorPaginationParams,
  decodeCursor,
  buildCursorFilter,
  formatCursorResult,
} from "../utilities/cursorPagination.ts";

export async function getPublicDoctorProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    const doctorId = await resolvePublicId("doctor", (req.params as { doctorId: string }).doctorId);
    const query = req.query as { location?: string };
    const locationLink = query.location;
    const locationId = locationLink ? await resolvePublicId("location", locationLink) : undefined;
    if (!doctorId || (locationLink && !locationId)) return reply.code(404).send(errorResponse("Doctor profile is unavailable"));
    const [user, profile] = await Promise.all([
      User.findOne({ _id: doctorId, isActive: true }).select("name").lean(),
      Doctor.findOne({ userId: doctorId }).lean(),
    ]);
    // Active location assignments establish booking eligibility; profile details are optional.
    if (!user || profile?.isActive === false) return reply.code(404).send(errorResponse("Doctor profile is unavailable"));
    const assignments = await DoctorAssignment.find({ doctorId, isActive: true }).lean();
    if (assignments.length === 0) return reply.code(404).send(errorResponse("Doctor profile is unavailable"));
    const organizations = await Organization.find({ _id: { $in: assignments.map((item) => item.organizationId) }, isActive: { $ne: false }, status: { $ne: "inactive" } })
      .select("name logo_url image_url currency").lean();
    const organizationMap = new Map(organizations.map((item) => [item._id.toString(), item]));
    const locationRecords = await Location.find({ _id: { $in: assignments.map((item) => item.locationId) }, isActive: true, isPublished: { $ne: false } })
      .select("name facilityType city address logo timezone brandColor organizationId").lean();
    const locationMap = new Map(locationRecords.map((location) => [location._id.toString(), location]));
    const publicAssignments = assignments.filter((item) => {
      const organizationId = item.organizationId.toString();
      return organizationMap.has(organizationId) && locationMap.get(item.locationId.toString())?.organizationId?.toString() === organizationId;
    });
    const selectedAssignment = locationId
      ? publicAssignments.find((item) => item.locationId.toString() === locationId)
      : publicAssignments.find((item) => item.organizationId.toString() === profile?.organizationId?.toString()) || publicAssignments[0];
    if (!selectedAssignment) return reply.code(404).send(errorResponse("Doctor profile is unavailable"));
    const organization = organizationMap.get(selectedAssignment.organizationId.toString())!;
    const organizationAssignments = publicAssignments.filter((item) => item.organizationId.toString() === organization._id.toString());
    const bookingAccess = await getOrganizationBookingAccess([organization._id.toString()]).catch((error) => {
      req.log.warn({ error }, "Could not verify online booking availability");
      return new Map<string, boolean>();
    });
    const slugs = await publicSlugs([
      { kind: "doctor", targetId: user._id.toString(), name: user.name },
      ...organizationAssignments.map((assignment) => ({ kind: "location" as const, targetId: assignment.locationId.toString(), name: locationMap.get(assignment.locationId.toString())!.name })),
    ]);
    const locations = organizationAssignments.map((assignment) => {
      const location = locationMap.get(assignment.locationId.toString());
      if (!location) return null;
      const onlineBookingAvailable = bookingAccess.get(organization._id.toString()) === true;
      return {
        id: location._id.toString(), slug: slugs.get(`location:${location._id}`), name: location.name, facilityType: publicFacilityType(location.facilityType), city: location.city, address: location.address || "",
        logo: organizationImageReference(locationBranding(location), "logo_url") || organizationImageReference(organization, "logo_url") || null,
        brandColor: location.brandColor || "#0F6F66",
        fees: assignment.fees, feeType: assignment.feeType, bookingMode: assignment.bookingMode,
        onlineBookingAvailable,
        bookingStatus: onlineBookingAvailable ? "check_availability" : "contact_location",
      };
    });
    const publicLocations = locations.filter((location) => location !== null);
    if (publicLocations.length === 0) return reply.code(404).send(errorResponse("Doctor profile is unavailable"));
    return reply.send(successResponse({
      id: user._id.toString(), slug: slugs.get(`doctor:${user._id}`), name: user.name, specialization: profile?.specialization || "",
      qualification: profile?.qualification || "", experienceYears: profile?.experience_years || 0,
      description: profile?.description || "", imageUrl: organizationImageReference(profile, "image_url"),
      languages: profile?.languages || [], organizationName: organization.name,
      organizationLocationCount: await Location.countDocuments({ organizationId: organization._id, isActive: true, isPublished: { $ne: false } }),
      organizationLogo: organizationImageReference(organization, "logo_url") || organizationImageReference(organization, "image_url") || null,
      currency: organization.currency || "INR", locations: publicLocations,
    }));
  } catch (error) {
    req.log.error({ error }, "Failed to load public doctor profile");
    return reply.code(500).send(errorResponse("Doctor profile could not be loaded"));
  }
}

export async function getOrganizations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const query = req.query as { cursor?: string; limit?: string | number };
    const pagination = getCursorPaginationParams(query, 20, 100);
    const decoded = decodeCursor(pagination.cursor);
    const cursorFilter = buildCursorFilter(decoded, { timeField: "createdAt", sortDirection: "desc" });

    const filter: Record<string, any> = {
      isActive: true,
      status: { $ne: "inactive" },
      ...cursorFilter,
    };

    const rawOrgs = await Organization.find(filter)
      .select("_id name address city phone email description image_url logo_url images timings working_days currency timezone isActive createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .limit(pagination.limit + 1)
      .lean();

    const result = formatCursorResult(rawOrgs as any[], pagination.limit, "createdAt");
    const formatted = result.items.map(toPublicOrganizationSummary);

    reply.header("X-Next-Cursor", result.nextCursor || "");
    reply.header("X-Has-Next-Page", String(result.hasNextPage));
    reply.header("X-Page-Limit", String(result.limit));
    reply.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Has-Next-Page, X-Page-Limit");


    return reply.code(200).send(successResponse(formatted));
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

    const org = await Organization.findOne({ _id: id, isActive: true, status: { $ne: "inactive" } })
      .select("_id name address city phone email description image_url logo_url images timings working_days currency timezone isActive")
      .lean();

    if (!org) {
      return reply.code(404).send(errorResponse("Organization not found"));
    }

    const publishedLocationIds = await Location.find({ organizationId: id, isActive: true, isPublished: { $ne: false } }).distinct("_id");
    const publishedDoctorIds = await DoctorAssignment.find({ organizationId: id, locationId: { $in: publishedLocationIds }, isActive: true }).distinct("doctorId");
    const doctors = await Doctor.find({ organizationId: id, userId: { $in: publishedDoctorIds }, isActive: { $ne: false } }).populate({ path: "userId", select: "name isActive" });

    const formattedDoctors = doctors
      .filter((d: any) => d.userId && d.userId.isActive)
      .map((d: any) => ({
        id: d.userId.id,
        name: d.userId.name,
        specialization: d.specialization,
        qualification: d.qualification,
        experience_years: d.experience_years,
        fees: d.fees,
        timings: d.timings,
        working_days: d.working_days,
        description: d.description,
        image_url: organizationImageReference(d, "image_url"),
        rating: d.rating,
        reviewsCount: d.reviewsCount,
        languages: d.languages
      }));

    return reply.code(200).send(successResponse(
      toPublicOrganizationDetail(org, formattedDoctors)
    ));
  } catch (err) {
    console.error("getOrganizationDetails error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPublicLocations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { search, city, specialization, sort, latitude, longitude } = req.query as {
      search?: string; city?: string; specialization?: string; sort?: string; latitude?: string; longitude?: string;
    };
    if (sort && sort !== "rating" && sort !== "fee_low" && sort !== "nearby") return reply.code(400).send(errorResponse("Unsupported location sort"));
    const origin = sort === "nearby" ? { latitude: Number(latitude), longitude: Number(longitude) } : undefined;
    if (origin && (typeof latitude !== "string" || !latitude.trim() || typeof longitude !== "string" || !longitude.trim() ||
      !Number.isFinite(origin.latitude) || Math.abs(origin.latitude) > 90 || !Number.isFinite(origin.longitude) || Math.abs(origin.longitude) > 180)) {
      return reply.code(400).send(errorResponse("Valid latitude and longitude are required for nearby locations"));
    }

    // Filter out orphan locations belonging to deleted organizations
    const activeOrgs = await Organization.find({ isActive: true, status: { $ne: "inactive" } }).select("_id").lean();
    const activeOrgIds = activeOrgs.map((o) => o._id);

    const andConditions: any[] = [
      {
        $or: [
          { organizationId: { $in: activeOrgIds } },
          { organization_id: { $in: activeOrgIds } }
        ]
      },
      { isActive: true, isPublished: { $ne: false } }
    ];
    const visibility = { $and: [...andConditions] };

    if (city) {
      andConditions.push({ city: { $regex: new RegExp(escapeRegex(city), "i") } });
    }

    if (search) {
      const safeSearch = escapeRegex(search);

      // Search matching doctors by user name or doctor profile (specialty / qualification)
      const matchingUsers = await User.find({
        isActive: true,
        name: { $regex: new RegExp(safeSearch, "i") },
      }).select("_id").lean();
      const userDoctorIds = matchingUsers.map((u) => u._id);

      const matchingDocProfiles = await Doctor.find({
        isActive: { $ne: false },
        $or: [
          { specialization: { $regex: new RegExp(safeSearch, "i") } },
          { qualification: { $regex: new RegExp(safeSearch, "i") } },
        ],
      }).select("userId").lean();
      const profileUsers = await User.find({ _id: { $in: matchingDocProfiles.map((doctor) => doctor.userId) }, isActive: true }).select("_id").lean();
      const profileDoctorIds = profileUsers.map((user) => user._id);

      const combinedDoctorUserIds = [...new Set([...userDoctorIds, ...profileDoctorIds])];
      let doctorLocationIds: mongoose.Types.ObjectId[] = [];
      if (combinedDoctorUserIds.length > 0) {
        const docAssignments = await DoctorAssignment.find({
          doctorId: { $in: combinedDoctorUserIds },
          isActive: true,
        }).select("locationId").lean();
        doctorLocationIds = docAssignments.map((a: any) => a.locationId).filter(Boolean);
      }

      const searchOr: any[] = [
        { name: { $regex: new RegExp(safeSearch, "i") } },
        { city: { $regex: new RegExp(safeSearch, "i") } },
        { address: { $regex: new RegExp(safeSearch, "i") } }
      ];
      if (doctorLocationIds.length > 0) {
        searchOr.push({ _id: { $in: doctorLocationIds } });
      }

      andConditions.push({ $or: searchOr });
    }

    // Specialization filtering
    if (specialization) {
      const safeSpecialization = escapeRegex(specialization);
      const doctors = await Doctor.find({ isActive: { $ne: false }, specialization: { $regex: new RegExp(safeSpecialization, "i") } }).select("userId").lean();
      const activeDoctors = await User.find({ _id: { $in: doctors.map((doctor) => doctor.userId) }, isActive: true }).select("_id").lean();
      const doctorUserIds = activeDoctors.map((user) => user._id);

      const assignments = await DoctorAssignment.find({ doctorId: { $in: doctorUserIds }, isActive: true }).select("locationId").lean();
      const locationIds = assignments.map(a => a.locationId).filter(Boolean);

      andConditions.push({ _id: { $in: locationIds } });
    }

    const pagination = getCursorPaginationParams(req.query as any, 20, 100);
    const decoded = decodeCursor(pagination.cursor);
    const cursorFilter = buildCursorFilter(decoded, { timeField: "createdAt", sortDirection: "desc" });
    if (!sort && Object.keys(cursorFilter).length > 0) {
      andConditions.push(cursorFilter);
    }

    const filter: any = andConditions.length > 1 ? { $and: andConditions } : andConditions[0] || {};
    const rawLocations = sort ? [] : await Location.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(pagination.limit + 1);

    let paginatedResult;
    try {
      paginatedResult = sort === "rating" || sort === "fee_low" || sort === "nearby"
        ? await getSortedPublicLocationPage(filter, sort, pagination.limit, pagination.cursor, origin)
        : formatCursorResult(rawLocations as any[], pagination.limit, "createdAt");
    } catch (error) {
      if (pagination.cursor && error instanceof Error && (error.message === "Invalid sorted location cursor" || error instanceof SyntaxError)) {
        return reply.code(400).send(errorResponse("Invalid location cursor"));
      }
      throw error;
    }
    const locations = paginatedResult.items;

    const locationIds = locations.map(c => c._id);
    const allAssignments = locations.length ? await DoctorAssignment.find({ $or: locations.map((location) => ({ locationId: location._id, organizationId: location.organizationId })), isActive: true })
      .populate({ path: "doctorId", select: "name isActive" })
      .lean() : [];

    const allDoctorUserIds = allAssignments.map((a: any) => a.doctorId?._id).filter(Boolean);
    const docProfiles = allDoctorUserIds.length > 0
      ? await Doctor.find({ userId: { $in: allDoctorUserIds } }).lean()
      : [];
    const profileMap = new Map<string, any>();
    for (const p of docProfiles) {
      profileMap.set(String(p.userId), p);
    }

    const locationAssignmentsMap = new Map<string, any[]>();
    for (const a of allAssignments) {
      if (!a.doctorId || !(a.doctorId as any).isActive || profileMap.get(String((a.doctorId as any)._id))?.isActive === false) continue;
      const cid = String(a.locationId);
      if (!locationAssignmentsMap.has(cid)) locationAssignmentsMap.set(cid, []);
      locationAssignmentsMap.get(cid)!.push(a);
    }

    const orgIds = [...new Set(locations.map((c) => (c.organizationId ? String(c.organizationId) : null)).filter((id): id is string => id !== null))];
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select("_id name logo_url image_url images currency countryCode timezone").lean()
      : [];
    const orgMap = new Map<string, any>(orgs.map((o) => [String(o._id), o]));
    const bookingAccess = await getOrganizationBookingAccess(orgIds).catch((error) => {
      req.log.warn({ error }, "Could not verify public booking access");
      return new Map<string, boolean>();
    });

    const ratingStats = await PatientFeedback.aggregate([
      { $match: { locationId: { $in: locationIds }, rating: { $gte: 1, $lte: 5 } } },
      { $group: { _id: "$locationId", rating: { $avg: "$rating" }, reviewsCount: { $sum: 1 } } },
    ]);
    const ratings = new Map(ratingStats.map(item => [String(item._id), item]));
    const facets = !search && !city && !specialization && !pagination.cursor ? await getPublicLocationFacets(visibility) : undefined;
    const locationSlugs = new Map(await Promise.all(locations.map(async c => [c.id, await publicSlug("location", c.id, c.name)] as const)));
    const doctorSlugs = new Map(await Promise.all(allAssignments.filter((a: any) => a.doctorId?.isActive).map(async (a: any) => [String(a.doctorId._id), await publicSlug("doctor", String(a.doctorId._id), a.doctorId.name)] as const)));
    const counts = await Location.aggregate([{ $match: { organizationId: { $in: orgs.map(o => o._id) }, isActive: true, isPublished: { $ne: false } } }, { $group: { _id: "$organizationId", count: { $sum: 1 } } }]);
    const organizationCounts = new Map(counts.map(item => [String(item._id), item.count]));
    const formattedLocations = locations.map((c) => {
      const json = c.toJSON();
      const org = orgMap.get(String(c.organizationId));
      const effectiveLogo = organizationImageReference(locationBranding(c), "logo_url") || organizationImageReference(org, "logo_url") || organizationImageReference(org, "image_url") || null;
      const effectiveImages = publicBrandingImages(c.images?.length ? c.images : org?.images);
      const effectiveCover = organizationImageReference(c, 0) || organizationImageReference(org, "image_url") || effectiveLogo || null;

      const assignments = locationAssignmentsMap.get(String(c._id)) || [];
      const doctorsSummary = assignments.map((a: any) => {
        const profile = profileMap.get(String(a.doctorId._id));
        return {
          id: a.doctorId._id.toString(),
          slug: doctorSlugs.get(String(a.doctorId._id)),
          name: a.doctorId.name,
          specialization: profile?.specialization?.trim() || "",
          fees: a.fees ?? 0,
          feeType: a.feeType || "fixed",
        };
      });

      const feesList = doctorsSummary.map((d: any) => d.fees).filter((fee: number, index: number) => doctorsSummary[index].feeType === "free" || fee > 0);
      const minFee = feesList.length > 0 ? Math.min(...feesList) : null;
      const specialties = [...new Set(doctorsSummary.map((d: any) => d.specialization).filter(Boolean))];
      const onlineBookingAvailable = bookingAccess.get(String(c.organizationId)) === true;
      const bookingStatus = doctorsSummary.length === 0 ? "no_doctors" : onlineBookingAvailable ? "check_availability" : "contact_location";

      return {
        ...toPublicLocation(json),
        slug: locationSlugs.get(c.id),
        organizationLocationCount: organizationCounts.get(String(c.organizationId)) || 1,
        facilityType: publicFacilityType(c.facilityType),
        ...(sort === "nearby" && "distances" in paginatedResult && paginatedResult.distances instanceof Map ? { distanceKm: paginatedResult.distances.get(String(c._id)) ?? null } : {}),
        logo_url: effectiveLogo,
        image_url: effectiveCover,
        images: effectiveImages,
        organizationName: org?.name || null,
        currency: org?.currency || "INR",
        countryCode: org?.countryCode || null,
        timezone: c.timezone || org?.timezone || "Asia/Kolkata",
        doctorCount: doctorsSummary.length,
        onlineBookingAvailable,
        bookingStatus,
        minFee,
        rating: ratings.get(String(c._id))?.rating ?? null,
        reviewsCount: ratings.get(String(c._id))?.reviewsCount ?? 0,
        specialties,
        doctorsSummary,
      };
    });

    reply.header("X-Next-Cursor", paginatedResult.nextCursor || "");
    reply.header("X-Has-Next-Page", String(paginatedResult.hasNextPage));
    reply.header("X-Page-Limit", String(paginatedResult.limit));
    reply.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Has-Next-Page, X-Page-Limit");


    return reply.code(200).send({ ...successResponse(formattedLocations), ...(facets ? { filters: facets } : {}) });
  } catch (err) {
    console.error("getPublicLocations error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPublicLocationDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const id = await resolvePublicId("location", (req.params as { id: string }).id);
    const doctorLink = (req.query as { doctorId?: string }).doctorId;
    const doctorId = doctorLink ? await resolvePublicId("doctor", doctorLink) : undefined;
    if (doctorLink && !doctorId) return reply.code(400).send(errorResponse("Invalid doctor link"));
    if (!id) return reply.code(404).send(errorResponse("Location not found"));

    const location = await Location.findOne({ _id: id, isActive: true, isPublished: { $ne: false } });
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found"));
    }
    const org = location.organizationId
      ? await Organization.findById(location.organizationId)
          .select("_id name logo_url image_url images description currency countryCode timezone phone email address city isActive status")
          .lean()
      : null;
    if (!org || org.isActive === false || org.status === "inactive") {
      return reply.code(404).send(errorResponse("Location not found"));
    }
    const timezone = location.timezone || org?.timezone || "Asia/Kolkata";
    const onlineBookingAvailable = await canCreateLocationBooking(id).catch((err) => {
      req.log.warn({ err }, "Could not verify online booking availability");
      return false;
    });
    const now = new Date();
    const todayDateStr = locationDateKey(now, timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(todayDateStr, timezone);

    const assignments = await DoctorAssignment.find({ locationId: id, organizationId: location.organizationId, isActive: true, ...(doctorId ? { doctorId } : {}) })
      .populate({
        path: "doctorId",
        select: "name isActive"
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

    const formattedDoctors = await Promise.all(
      assignments.map(async (assign: any) => {
        if (!assign.doctorId || !assign.doctorId.isActive) return null;

        const docProfile = docProfileMap.get(String(assign.doctorId._id));
        if (docProfile?.isActive === false) return null;

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
        const override = await DoctorDayOverride.findOne({
          locationId: id,
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
          locationId: id,
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
              assign.workingHours,
              timezone
            );

            if (!effectiveSchedule.isWorkingDay) {
              isOnlineBookingClosed = true;
              onlineBookingClosedReason = "Not scheduled to practice today";
            } else {
              const [endH, endM] = (effectiveSchedule.dayEndTime || "17:00").split(":").map(Number);
              const closingMinutes = (endH || 0) * 60 + (endM || 0);
              const currentMinutes = locationClockMinutes(now, timezone);
              const safetyBuffer = assign.onlineBookingSafetyBuffer ?? 30;
              const allowedOperatingMinutes = closingMinutes - safetyBuffer - currentMinutes;

              const estimatedQueueTime = waitingPatientsCount * estDuration;

              if (estimatedQueueTime + estDuration > allowedOperatingMinutes) {
                isOnlineBookingClosed = true;
                onlineBookingClosedReason = `Online same-day booking closed due to queue backlog (${safetyBuffer}m safety buffer enforced before shift end). Walk-in registration accepted at location.`;
              }
            }
          } catch {
            // fallback gracefully
          }
        }

        // Query upcoming doctor holidays/leaves for the next 30 days
        const futureDate = new Date(`${todayDateStr}T12:00:00Z`);
        futureDate.setUTCDate(futureDate.getUTCDate() + 30);
        const maxFutureDateStr = futureDate.toISOString().slice(0, 10);

        const upcomingOverrides = await DoctorDayOverride.find({
          locationId: id,
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
          slug: await publicSlug("doctor", assign.doctorId._id.toString(), assign.doctorId.name),
          name: assign.doctorId.name,
          specialization: docProfile?.specialization || "",
          qualification: docProfile?.qualification || "",
          experience_years: docProfile?.experience_years ?? 0,
          fees: assign.fees,
          feeType: (assign as any).feeType || (docProfile as any)?.feeType || "fixed",
          timings: assign.workingHours,
          working_days: workingDays,
          description: docProfile?.description || "",
          image_url: organizationImageReference(docProfile, "image_url"),
          rating: docProfile?.rating || 5,
          reviewsCount: docProfile?.reviewsCount || 0,
          languages: docProfile?.languages || ["English"],
          bookingMode: assign.bookingMode || "sequential_queue",
          maxDailyTokens: assign.maxDailyTokens || null,
          isAvailable,
          overrideStatus,
          overrideReason,
          upcomingHolidays,
          appointmentDuration: assign.appointmentDuration || 15,
          waitingPatientsCount,
          estimatedWaitMinutes,
          isOnlineBookingClosed,
          onlineBookingClosedReason,
        };
      })
    );

    const cleanDoctors = formattedDoctors.filter(d => d !== null);

    const effectiveLogo = organizationImageReference(locationBranding(location), "logo_url") || organizationImageReference(org, "logo_url") || organizationImageReference(org, "image_url") || null;
    const effectiveImages = publicBrandingImages(location.images?.length ? location.images : org?.images);
    const effectiveCover = organizationImageReference(location, 0) || organizationImageReference(org, "image_url") || effectiveLogo || null;

    const locationJson = location.toJSON();
    return reply.code(200).send(successResponse({
      ...toPublicLocation(locationJson),
      facilityType: publicFacilityType(location.facilityType),
      slug: await publicSlug("location", location.id, location.name),
      organizationLocationCount: await Location.countDocuments({ organizationId: location.organizationId, isActive: true, isPublished: { $ne: false } }),
      logo_url: effectiveLogo,
      image_url: effectiveCover,
      images: effectiveImages,
      currency: org?.currency || (locationJson as any).currency || "INR",
      countryCode: org?.countryCode || null,
      timezone,
      onlineBookingAvailable,
      bookingStatus: cleanDoctors.length === 0 ? "no_doctors" : onlineBookingAvailable ? "check_availability" : "contact_location",
      organization: org ? {
        id: (org as any)._id.toString(),
        name: org.name,
        logo_url: organizationImageReference(org, "logo_url"),
        image_url: organizationImageReference(org, "image_url"),
        images: publicBrandingImages(org.images),
        description: org.description,
        currency: org.currency || "INR",
        countryCode: org.countryCode || null,
        timezone: org.timezone || "Asia/Kolkata",
        phone: org.phone,
        email: org.email,
        address: org.address,
        city: org.city,
      } : null,
      doctors: cleanDoctors
    }));
  } catch (err) {
    console.error("getPublicLocationDetails error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * POST /api/public/join-queue
 * Fast, unauthenticated mobile walk-in queue join flow triggered via Location QR Poster.
 * Target: Scan → Name/Phone → Doctor → Join Queue → Token → Track.
 */
export async function joinPublicQueue(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, doctorId, name, phone, gender, notes } = req.body as {
      locationId: string;
      doctorId: string;
      name: string;
      phone: string;
      gender?: "male" | "female" | "other";
      notes?: string;
    };

    if (!locationId || !doctorId || !name?.trim() || !phone?.trim()) {
      return reply.code(400).send(errorResponse("Location, doctor, patient name, and mobile number are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(locationId) || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid location or doctor ID format"));
    }

    const cleanPhone = normalizePhone(phone);
    if (!/^\d{10}$/.test(cleanPhone) && !/^\+[1-9]\d{7,14}$/.test(cleanPhone)) {
      return reply.code(400).send(errorResponse("Enter an Indian 10-digit number or an international number with +country code"));
    }

    // 1. Verify Location & Active Organization
    const location = await Location.findOne({ _id: locationId, isActive: true, isPublished: { $ne: false } });
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found or currently inactive"));
    }

    const orgId = location.organizationId || (location as any).organization_id;
    const org = await Organization.findOne({ _id: orgId, isActive: true });
    if (!org) {
      return reply.code(400).send(errorResponse("Healthcare organization is currently inactive"));
    }
    if (!(await canCreateOrganizationBooking(org._id.toString()))) {
      return reply.code(409).send(errorResponse("Online booking is temporarily unavailable. Please contact reception directly."));
    }
    if (org.countryCode && org.countryCode !== "IN" && !phone.trim().startsWith("+")) {
      return reply.code(400).send(errorResponse("Use the international phone format with +country code"));
    }

    // 2. Verify Doctor Assignment
    const assignment = await DoctorAssignment.findOne({ locationId, doctorId, organizationId: org._id, isActive: true });
    if (!assignment || !(await isActiveBookingDoctor(doctorId))) {
      return reply.code(400).send(errorResponse("Doctor is not actively assigned to this location"));
    }

    // 3. Verify Doctor Availability for the location's local day
    const timezone = location.timezone || org.timezone || "Asia/Kolkata";
    const todayStr = locationDateKey(new Date(), timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(todayStr, timezone);

    const override = await DoctorDayOverride.findOne({
      locationId,
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
    const phoneVariants = /^\d{10}$/.test(cleanPhone)
      ? [cleanPhone, `+91${cleanPhone}`, `91${cleanPhone}`]
      : [cleanPhone];
    let patient = await Patient.findOne({
      organizationId: org._id,
      phone: { $in: phoneVariants },
    });

    if (patient) {
      const activeAppt = await Appointment.findOne({
        locationId,
        doctorId,
        patientId: patient._id,
        status: { $in: ["pending", "confirmed", "checked-in", "in-consultation"] },
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      });

      if (activeAppt) {
        return reply.code(409).send(errorResponse("An active token already exists for this contact today. Ask reception for its tracker link."));
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
    const counterKey = `token_${locationId}_${doctorId}_${todayStr}`;
    const tokenNumber = await getNextAtomicSequence(counterKey);

    // 6. Dynamic Queue Wait Duration Calculation
    const queueCount = await Appointment.countDocuments({
      locationId,
      doctorId,
      status: { $in: ["pending", "confirmed", "checked-in"] },
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    });

    const { duration: adaptiveDuration } = await getAdaptiveConsultationDuration(
      locationId,
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
      locationId,
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
      notes: notes?.trim() || "Walk-In self-registered via Location QR Poster",
    });

    // 8. Real-Time Broadcast & WhatsApp notification dispatch
    try {
      broadcastQueueUpdate(locationId.toString(), {
        type: "QUEUE_UPDATED",
        data: {
          appointmentId: appointment._id.toString(),
          status: "checked-in",
          doctorId: doctorId.toString(),
          locationId: locationId.toString(),
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
      trackingUrl: `/track/${appointment._id}#t=${encodeURIComponent(trackerCapability.token)}`,
      trackerToken: trackerCapability.token,
    }, `Token #${appointment.tokenNumber} confirmed! Proceed to waiting lounge.`));
  } catch (err) {
    console.error("joinPublicQueue error:", err);
    return reply.code(500).send(errorResponse("Failed to join queue. Please speak with reception desk."));
  }
}

function publicTrackerAccessAllowed(req: FastifyRequest, appointment: { trackerTokenHash?: string | null; trackerTokenExpiresAt?: Date | null }): boolean {
  return hasValidTrackerCapability(req, appointment);
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
      .select("+trackerTokenHash trackerTokenExpiresAt locationId doctorId patientId tokenNumber queuePosition status paymentStatus appointmentTime appointmentType disruptionResponseDeadline triageAction parkedAt parkedReason patientReturned patientReturnedAt consultationPhase investigationSentAt investigationNotes delayNotifiedAt lastNotifiedDelayMinutes isEmergency vitals investigationResults updatedAt")
      .populate("locationId", "name city address phone upiVpa merchantName")
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name" },
        select: "name userId",
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found or tracking link has expired"));
    }
    if (!publicTrackerAccessAllowed(req, appointment)) {
      return reply.code(401).send(errorResponse("A valid appointment tracker link is required"));
    }

    const locationId = (appointment.locationId as any)?._id || appointment.locationId;
    const doctorId = (appointment.doctorId as any)?._id || appointment.doctorId;
    const timezone = await getLocationTimezone(String(locationId));

    // Doctor details & assignment
    const doctorAssignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true }).select("appointmentDuration").lean();
    const defaultDuration = doctorAssignment?.appointmentDuration || 15;
    const docProfile = await Doctor.findOne({ userId: doctorId }).select("specialization").lean();
    const doctorSpecialization = docProfile?.specialization || (appointment.doctorId as any)?.specialization || "General Physician";

    // Safely establish appointmentTime validity before toISOString()
    const rawApptTime = appointment.appointmentTime;
    const apptDate = rawApptTime ? new Date(rawApptTime) : new Date();
    const isValidApptDate = !isNaN(apptDate.getTime());
    if (!isValidApptDate) {
      console.warn(`[PublicTracker] Corrupt historical appointmentTime detected for appointment ${appointment._id}`);
    }
    const safeDate = isValidApptDate ? apptDate : new Date();
    const dateStr = locationDateKey(safeDate, timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(dateStr, timezone);

    // Check same-day DoctorDayOverride safely
    const dayOverride = await DoctorDayOverride.findOne({
      doctorId,
      locationId,
      date: dateStr,
    }).select("status reason delayMinutes").lean();

    const doctorAvailability = {
      status: dayOverride?.status || "available",
      isAvailable: dayOverride ? dayOverride.status !== "unavailable" : true,
      reason: dayOverride?.reason || null,
      delayMinutes: (dayOverride as any)?.delayMinutes || 0,
    };

    // Calculate adaptive consultation duration based on today's actual completed encounters
    const { duration, isAdaptive, sampleCount } = await getAdaptiveConsultationDuration(
      locationId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );

    // Lightweight status derivation: Query only current active consultation token (Step 5.2)
    const inConsultationAppt = await Appointment.findOne({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: "in-consultation",
    }).select("tokenNumber _id").lean();
    const currentlyServingToken = inConsultationAppt ? inConsultationAppt.tokenNumber : null;

    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const activeEncounter = await Encounter.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).select("startedAt").lean();
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

    const waitingStatuses = ["pending", "confirmed", "checked-in"] as const;
    const myRank = appointment.queuePosition ?? appointment.tokenNumber ?? 999;

    if (appointment.status === "in-consultation") {
      peopleAhead = 0;
      estimatedWaitMinutes = 0;
      estimatedCallTime = new Date().toISOString();
    } else if (appointment.status === "standby") {
      peopleAhead = 0;
      estimatedWaitMinutes = inConsultationRemainingMinutes;
      estimatedCallTime = new Date(Date.now() + estimatedWaitMinutes * 60 * 1000).toISOString();
    } else if (waitingStatuses.some(status => status === appointment.status)) {
      // Indexed count query instead of pulling all appointments into memory
      peopleAhead = await Appointment.countDocuments({
        locationId,
        doctorId,
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
        status: { $in: [...waitingStatuses, "in-consultation"] },
        $or: [
          { queuePosition: { $lt: myRank } },
          { queuePosition: null, tokenNumber: { $lt: myRank } },
        ],
      });

      estimatedWaitMinutes = inConsultationRemainingMinutes + (peopleAhead * duration);
      estimatedCallTime = new Date(Date.now() + estimatedWaitMinutes * 60 * 1000).toISOString();
    }

    // Step 5.2: Generate deterministic ETag & 304 Not Modified check
    const apptUpdatedAt = appointment.updatedAt ? new Date(appointment.updatedAt).getTime() : 0;
    const etagSource = `${appointment._id}:${appointment.status}:${apptUpdatedAt}:${currentlyServingToken ?? ""}:${peopleAhead}:${appointment.paymentStatus || "unpaid"}`;
    const etag = `W/"${crypto.createHash("sha1").update(etagSource).digest("hex")}"`;

    reply.header("ETag", etag);
    reply.header("Cache-Control", "no-store");

    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return reply.code(304).send();
    }

    const patientName =
      (appointment.patientId as any)?.name ||
      (appointment.patientId as any)?.userId?.name ||
      "Patient";

    let consultationSummary: any = null;
    let billing: any = null;

    // Avoid loading full encounters, clinical notes, prescriptions, and invoices unless appointment has actually completed
    if (appointment.status === "completed") {
      const encounter = await Encounter.findOne({ appointmentId: appointment._id }).sort({ createdAt: -1 }).select("endedAt _id").lean();
      if (encounter) {
        const { ClinicalNote } = await import("../models/ClinicalNote.ts");
        const { Prescription } = await import("../models/Prescription.ts");
        const { decryptField } = await import("../utilities/cryptoEnvelope.ts");

        const note = (await ClinicalNote.findOne({ encounterId: encounter._id, isLatest: true })
          .select("subjective assessment plan signature")
          .lean()) as any;
        let prescriptions = (await Prescription.find({ encounterId: encounter._id, deletedAt: null })
          .select("medicineName dosage frequency duration instructions status")
          .lean()) as any[];

        if (prescriptions.length === 0 && note?.plan?.prescriptionIds?.length > 0) {
          prescriptions = (await Prescription.find({ _id: { $in: note.plan.prescriptionIds }, deletedAt: null })
            .select("medicineName dosage frequency duration instructions status")
            .lean()) as any[];
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

      // Check for linked invoice only when completed
      const { Invoice } = await import("../models/Invoice.ts");
      const invoiceFilter: any = {
        deletedAt: null,
        $or: [
          { appointmentId: appointment._id },
          ...(encounter ? [{ encounterId: encounter._id }] : []),
        ],
      };
      const invoice = (await Invoice.findOne(invoiceFilter)
        .select("invoiceNumber currency totalAmount amountPaid balanceDue status paymentMethod paymentDate items")
        .sort({ createdAt: -1 })
        .lean()) as any;
      if (invoice) {
        billing = {
          invoiceId: invoice._id.toString(),
          invoiceNumber: invoice.invoiceNumber,
          currency: invoice.currency || "INR",
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
    if (appointment.status === "completed") {
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
    }

    return reply.code(200).send(
      successResponse({
        appointmentId: appointment._id,
        tokenNumber: appointment.tokenNumber,
        queuePosition: appointment.queuePosition,
        status: appointment.status,
        reviewState: (await import("../utilities/appointmentReview.ts")).appointmentReviewState(appointment),
        paymentStatus: appointment.paymentStatus || (billing ? (billing.balanceDue === 0 ? "paid" : "unpaid") : "unpaid"),
        appointmentTime: appointment.appointmentTime,
        appointmentType: appointment.appointmentType,
        patientName,
        doctor: {
          id: (appointment.doctorId as any)?._id || appointment.doctorId,
          name: (appointment.doctorId as any)?.name || "Doctor",
          specialization: doctorSpecialization,
        },
        location: {
          id: (appointment.locationId as any)?._id || appointment.locationId,
          name: (appointment.locationId as any)?.name || "Location",
          city: (appointment.locationId as any)?.city || "",
          address: (appointment.locationId as any)?.address || "",
          phone: (appointment.locationId as any)?.phone || "",
          upiVpa: (appointment.locationId as any)?.upiVpa || "",
          merchantName: (appointment.locationId as any)?.merchantName || (appointment.locationId as any)?.name || "",
          timezone,
        },
        currentlyServingToken,
        peopleAhead,
        estimatedWaitMinutes,
        estimatedCallTime,
        averageDuration: duration,
        isAdaptiveDuration: isAdaptive,
        adaptiveSampleCount: sampleCount,
        doctorAvailability,
        isToday: dateStr === locationDateKey(new Date(), timezone),
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
      .populate("locationId", "name city")
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
    const todayStr = locationDateKey(new Date(), await getLocationTimezone(String((appointment.locationId as any)?._id || appointment.locationId)));
    const dayOverride = await DoctorDayOverride.findOne({
      doctorId: (appointment.doctorId as any)?._id || appointment.doctorId,
      locationId: (appointment.locationId as any)?._id || appointment.locationId,
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

    const locationIdStr = ((appointment.locationId as any)?._id || appointment.locationId).toString();
    const doctorIdStr = ((appointment.doctorId as any)?._id || appointment.doctorId).toString();
    const patientName = (appointment.patientId as any)?.name || (appointment.patientId as any)?.userId?.name || "Patient";

    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        status: "checked-in",
        locationId: locationIdStr,
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
      details: { tokenNumber: appointment.tokenNumber, locationId: locationIdStr },
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
      .select("+trackerTokenHash")
      .populate("locationId", "name")
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

    const locationIdStr = (appointment.locationId as any)?._id?.toString() || appointment.locationId.toString();

    // Broadcast WebSocket event to location reception desk
    try {
      broadcastQueueUpdate(locationIdStr, {
        type: "PATIENT_RETURNED" as any,
        data: {
          appointmentId: appointment._id,
          tokenNumber: appointment.tokenNumber,
          patientName,
          returnedAt: appointment.patientReturnedAt,
        },
        message: `Token #${appointment.tokenNumber} (${patientName}) has returned to the waiting room.`,
      });
      broadcastQueueUpdate(locationIdStr, {
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
    const locationId = (req.params as any)?.locationId || (req.query as any)?.locationId;
    const { doctorId } = req.query as { doctorId?: string };

    if (!locationId || !mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Invalid location ID"));
    }

    const location = await Location.findById(locationId).select("name city address phone").lean();
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found"));
    }

    const now = new Date();
    const timezone = await getLocationTimezone(locationId);
    const dateStr = locationDateKey(now, timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(dateStr, timezone);

    const query: any = {
      locationId,
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

    // Check if Doctor / Location is currently on an OPD break
    const { OpdSession } = await import("../models/OpdSession.ts");
    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");

    const sessionQuery: any = { locationId, date: dateStr, status: "active" };
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
    const assignments = await DoctorAssignment.find({ locationId, isActive: true })
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

    // Also include any doctors present in today's location appointments
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

    const activeSessions = await OpdSession.find({ locationId, date: dateStr, status: "active" }).lean();
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
        location: {
          id: location._id,
          name: location.name,
          city: location.city,
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
      .select("+trackerTokenHash")
      .populate("locationId", "name address phone city")
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

    const locationDoc = appointment.locationId as any;
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
      locationName: locationDoc?.name || "Healthcare facility",
      locationAddress: locationDoc?.address || locationDoc?.city || "Medical Plaza",
      locationPhone: locationDoc?.phone || "Reception",
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

// ─── Public Site Traffic & Visitor Tracking ────────────────────────
export async function trackSiteVisitController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { path, locationId, organizationId, visitorId, referrer } = (req.body || {}) as {
      path?: string;
      locationId?: string;
      organizationId?: string;
      visitorId?: string;
      referrer?: string;
    };

    const routePath = analyticsPath(path);
    if (!routePath) {
      return reply.code(400).send(errorResponse("Path is required"));
    }

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
      path: routePath,
      locationId: locationId && mongoose.Types.ObjectId.isValid(locationId) ? locationId : undefined,
      organizationId: organizationId && mongoose.Types.ObjectId.isValid(organizationId) ? organizationId : undefined,
      visitorId: visitorId ? String(visitorId).slice(0, 100) : undefined,
      ipAddress: req.ip,
      userAgent: userAgent.slice(0, 300),
      device,
      browser,
      os,
      referrer: referrerOrigin(referrer),
    });

    return reply.code(200).send(successResponse({ recorded: true }));
  } catch (err: any) {
    console.error("trackSiteVisitController error:", err);
    return reply.code(200).send(successResponse({ recorded: false }));
  }
}
