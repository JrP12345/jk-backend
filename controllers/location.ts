import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { publicSlug } from "../utilities/publicLinks.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { isIanaTimezone } from "../utilities/countrySettings.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { isFacilityType } from "../utilities/facility.ts";
import { attachBranding, locationBranding, validateBrandingReferences, BrandingValidationError, retireUnusedBranding, organizationImageReference } from "../services/OrganizationBranding.ts";

export async function createLocation(req: FastifyRequest, reply: FastifyReply) {
  try {
    const {
      name, facilityType, logo, image_url, description, brandColor, phone, email, address, city, timezone, latitude, longitude, timings, amenities, upiVpa, merchantName, isPublished
    } = (req.body || {}) as {
      organizationId?: string; name: string; city: string; logo?: string; image_url?: string; description?: string;
      facilityType?: string;
      isPublished?: boolean;
      brandColor?: "#0F6F66" | "#1D4ED8" | "#6D28D9" | "#9A3412";
      phone?: string; email?: string; address?: string; timezone?: string; latitude?: number;
      longitude?: number; timings?: string; amenities?: string[]; upiVpa?: string; merchantName?: string;
    };

    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;

    if (!orgId) return reply.code(400).send(errorResponse("Select an organization before creating a location"));
    if (facilityType !== undefined && !isFacilityType(facilityType)) return reply.code(400).send(errorResponse("Invalid facility type"));

    // Check SaaS Location Quota Limit
    const org = await Organization.findById(orgId);
    if (!org) return reply.code(404).send(errorResponse("Target organization not found"));

    const allowedLocations = org.maxLocations || 1;

    const existingCount = await Location.countDocuments({ organizationId: orgId, isActive: true });
    if (existingCount >= allowedLocations && req.user?.role !== "root") {
      return reply.code(403).send(errorResponse(`Location quota limit of ${allowedLocations} reached for ${org.name}'s ${org.plan?.toUpperCase() || "current"} plan. Upgrade subscription to add more locations.`));
    }

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Location name and city are required"));
    }
    if (timezone && !isIanaTimezone(timezone)) return reply.code(400).send(errorResponse("A valid IANA timezone is required"));

    const branding = { _id: orgId, logo_url: logo || image_url || null };
    await validateBrandingReferences(req, branding, { _id: orgId });
    await attachBranding(branding);
    const location = await Location.create({
      organizationId: orgId,
      ...(isPublished !== undefined && { isPublished }),
      name,
      facilityType: facilityType || null,
      logo: branding.logo_url,
      description: description || null,
      brandColor: brandColor || "#0F6F66",
      phone: phone || null,
      email: email || null,
      address: address || null,
      city,
      timezone: timezone || null,
      latitude: latitude !== undefined ? latitude : null,
      longitude: longitude !== undefined ? longitude : null,
      timings: timings || null,
      amenities: amenities || [],
      upiVpa: upiVpa?.trim() || "",
      merchantName: merchantName?.trim() || "",
    });

    return reply.code(201).send(successResponse(location, "Location created successfully"));
  } catch (err) {
    if (err instanceof BrandingValidationError) return reply.code(400).send(errorResponse(err.message));
    console.error("createLocation error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getLocations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const withTimezone = async (locations: any[]) => {
      const orgIds = [...new Set(locations.map(location => location.organizationId?.toString()).filter(Boolean))];
      const organizations = await Organization.find({ _id: { $in: orgIds } }).select("_id timezone").lean();
      const timezones = new Map(organizations.map(org => [org._id.toString(), org.timezone]));
      return Promise.all(locations.map(async location => ({
        ...location.toJSON(),
        image_url: organizationImageReference(locationBranding(location), "logo_url"),
        slug: await publicSlug("location", location.id, location.name),
        effectiveTimezone: location.timezone || timezones.get(location.organizationId?.toString()) || "Asia/Kolkata",
      })));
    };
    const { includeInactive, status } = (req.query || {}) as { includeInactive?: string; status?: string };
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;

    const filter: any = {};
    if (status === "inactive") {
      filter.isActive = false;
    } else if (status === "all" || includeInactive === "true") {
      // Do not filter by isActive, return both active and inactive
    } else {
      filter.isActive = { $ne: false };
    }

    if (!orgId) {
      if (req.user?.role === "root") {
        const activeOrgs = await Organization.find().select("_id").lean();
        const activeOrgIds = activeOrgs.map((o) => o._id);
        filter.organizationId = { $in: activeOrgIds };
        const locations = await Location.find(filter).limit(50).sort({ name: 1 });
        return reply.code(200).send(successResponse(await withTimezone(locations)));
      }
      return reply.code(200).send(successResponse([]));
    }

    filter.organizationId = orgId;
    const locations = await Location.find(filter).sort({ name: 1 });
    return reply.code(200).send(successResponse(await withTimezone(locations)));
  } catch (err) {
    console.error("getLocations error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/** Owners must be able to remove public information even after a plan expires. */
export async function setLocationPublication(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { isPublished } = req.body as { isPublished: boolean };
  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
  if (!scope.organizationId) return reply.code(400).send(errorResponse("Select an organization before changing publication"));
  const location = await Location.findOneAndUpdate({ _id: id, isActive: true, organizationId: scope.organizationId }, { $set: { isPublished } }, { returnDocument: "after", runValidators: true });
  if (!location) return reply.code(404).send(errorResponse("Location not found in your organization"));
  return reply.send(successResponse({ id: location.id, isPublished: location.isPublished }));
}

export async function updateLocation(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid location ID"));
    }

    const {
      name, facilityType, logo, image_url, description, brandColor, phone, email, address, city, timezone, latitude, longitude, timings, amenities, upiVpa, merchantName, isPublished
    } = req.body as {
      name: string; city: string; logo?: string; image_url?: string; description?: string; brandColor?: string;
      facilityType?: string;
      isPublished?: boolean;
      phone?: string; email?: string; address?: string; timezone?: string; latitude?: number; longitude?: number;
      timings?: string; amenities?: string[]; upiVpa?: string; merchantName?: string;
    };

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Location name and city are required"));
    }
    if (timezone && !isIanaTimezone(timezone)) return reply.code(400).send(errorResponse("A valid IANA timezone is required"));

    const filter: any = { _id: id, isActive: true };
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    if (scope.organizationId) filter.organizationId = scope.organizationId;
    if (facilityType !== undefined && !isFacilityType(facilityType)) return reply.code(400).send(errorResponse("Invalid facility type"));

    const location = await Location.findOne(filter);
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found in your organization"));
    }

    const branding = locationBranding({ organizationId: location.organizationId, logo: logo || image_url || null });
    await validateBrandingReferences(req, branding, locationBranding(location));
    await attachBranding(branding);
    const updated = await Location.findOneAndUpdate(
      filter,
      {
        name,
        ...(isPublished !== undefined && { isPublished }),
        ...(facilityType !== undefined && { facilityType }),
        logo: logo || image_url || null,
        description: description || null,
        ...(brandColor !== undefined && { brandColor }),
        phone: phone || null,
        email: email || null,
        address: address || null,
        city,
        ...(timezone !== undefined && { timezone: timezone || null }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        timings: timings || null,
        amenities: amenities || [],
        ...(upiVpa !== undefined && { upiVpa: upiVpa.trim() }),
        ...(merchantName !== undefined && { merchantName: merchantName.trim() }),
      },
      { returnDocument: "after", runValidators: true }
    );

    await retireUnusedBranding(locationBranding(location), locationBranding(updated));
    return reply.code(200).send(successResponse(updated, "Location updated successfully"));
  } catch (err) {
    if (err instanceof BrandingValidationError) return reply.code(400).send(errorResponse(err.message));
    console.error("updateLocation error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteLocation(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid location ID"));
    }

    const filter: any = { _id: id, isActive: true };
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    if (scope.organizationId) filter.organizationId = scope.organizationId;

    const location = await Location.findOne(filter);
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found in your organization"));
    }

    const { Appointment } = await import("../models/Appointment.ts");
    const activeApptsCount = await Appointment.countDocuments({
      locationId: id,
      status: { $in: ["pending", "confirmed", "checked-in", "in-consultation"] }
    });

    if (activeApptsCount > 0) {
      return reply.code(400).send(errorResponse(`Cannot deactivate location with ${activeApptsCount} active appointment(s). Please reassign or cancel them first.`));
    }

    await Location.updateOne(filter, { isActive: false });

    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    await DoctorAssignment.updateMany({ locationId: id, organizationId: location.organizationId }, { isActive: false });

    return reply.code(200).send(successResponse(null, "Location deactivated successfully"));
  } catch (err) {
    console.error("deleteLocation error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function reactivateLocation(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid location ID"));
    }

    const filter: any = { _id: id };
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    if (scope.organizationId) filter.organizationId = scope.organizationId;

    const location = await Location.findOne(filter);
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found in your organization"));
    }

    if (location.isActive) {
      return reply.code(200).send(successResponse(location, "Location is already active"));
    }

    // Check SaaS Location Quota Limit
    const org = await Organization.findById(location.organizationId);
    if (!org) {
      return reply.code(404).send(errorResponse("Target organization not found"));
    }

    const allowedLocations = org.maxLocations || 1;

    const existingCount = await Location.countDocuments({
      organizationId: location.organizationId,
      isActive: { $ne: false },
    });

    if (existingCount >= allowedLocations && req.user?.role !== "root") {
      return reply.code(403).send(
        errorResponse(
          `Location quota limit of ${allowedLocations} reached for ${org.name}'s ${org.plan?.toUpperCase() || "current"} plan. Upgrade your subscription plan or deactivate another branch before reactivating this location.`
        )
      );
    }

    location.isActive = true;
    await location.save();

    // Re-enable doctor assignments for active doctors in the organization
    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    const { User } = await import("../models/User.ts");
    const { OrgMember } = await import("../models/OrgMember.ts");
    const { Doctor } = await import("../models/Doctor.ts");
    const memberIds = await OrgMember.find({ organizationId: location.organizationId }).distinct("userId");
    // Older assigned clinicians may not have a profile; an explicitly disabled
    // profile must still prevent reactivation, alongside removed membership.
    const inactiveProfileIds = await Doctor.find({ organizationId: location.organizationId, userId: { $in: memberIds }, isActive: false }).distinct("userId");
    const activeDoctorIds = await User.find({
      _id: { $in: memberIds, $nin: inactiveProfileIds },
      isActive: true,
    }).distinct("_id");

    if (activeDoctorIds.length > 0) {
      await DoctorAssignment.updateMany(
        { locationId: location._id, organizationId: location.organizationId, doctorId: { $in: activeDoctorIds } },
        { isActive: true }
      );
    }

    return reply.code(200).send(successResponse(location, "Location reactivated successfully"));
  } catch (err) {
    console.error("reactivateLocation error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
