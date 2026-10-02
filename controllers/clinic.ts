import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
import { Organization } from "../models/Organization.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { isIanaTimezone } from "../utilities/countrySettings.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

export async function createClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const {
      organizationId: reqOrgId, name, logo, description, brandColor, phone, email, address, city, timezone, latitude, longitude, timings, facilities, upiVpa, merchantName
    } = (req.body || {}) as {
      organizationId?: string; name: string; city: string; logo?: string; description?: string;
      brandColor?: "#0F6F66" | "#1D4ED8" | "#6D28D9" | "#9A3412";
      phone?: string; email?: string; address?: string; timezone?: string; latitude?: number;
      longitude?: number; timings?: string; facilities?: string[]; upiVpa?: string; merchantName?: string;
    };

    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    let orgId = scope.organizationId;
    if (!orgId && req.user?.role === "root") {
      const firstOrg = await Organization.findOne().select("_id").lean();
      if (firstOrg) orgId = firstOrg._id.toString();
    }

    if (!orgId) return reply.code(400).send(errorResponse("Organization context is required to create a clinic branch"));

    // Check SaaS Clinic Quota Limit
    const org = await Organization.findById(orgId);
    if (!org) return reply.code(404).send(errorResponse("Target organization not found"));

    const allowedClinics = org.maxClinics || 1;

    const existingCount = await Clinic.countDocuments({ organizationId: orgId, isActive: true });
    if (existingCount >= allowedClinics && req.user?.role !== "root") {
      return reply.code(403).send(errorResponse(`Clinic branch quota limit of ${allowedClinics} reached for ${org.name}'s ${org.plan?.toUpperCase() || "current"} plan. Upgrade subscription to add more clinic branches.`));
    }

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Clinic name and city are required"));
    }
    if (timezone && !isIanaTimezone(timezone)) return reply.code(400).send(errorResponse("A valid IANA timezone is required"));

    const clinic = await Clinic.create({
      organizationId: orgId,
      name,
      logo: logo || null,
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
      facilities: facilities || [],
      upiVpa: upiVpa?.trim() || "",
      merchantName: merchantName?.trim() || "",
    });

    return reply.code(201).send(successResponse(clinic, "Clinic created successfully"));
  } catch (err) {
    console.error("createClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getClinics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const withTimezone = async (clinics: any[]) => {
      const orgIds = [...new Set(clinics.map(clinic => clinic.organizationId?.toString()).filter(Boolean))];
      const organizations = await Organization.find({ _id: { $in: orgIds } }).select("_id timezone").lean();
      const timezones = new Map(organizations.map(org => [org._id.toString(), org.timezone]));
      return clinics.map(clinic => ({
        ...clinic.toJSON(),
        effectiveTimezone: clinic.timezone || timezones.get(clinic.organizationId?.toString()) || "Asia/Kolkata",
      }));
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
        const clinics = await Clinic.find(filter).limit(50).sort({ name: 1 });
        return reply.code(200).send(successResponse(await withTimezone(clinics)));
      }
      return reply.code(200).send(successResponse([]));
    }

    filter.organizationId = orgId;
    const clinics = await Clinic.find(filter).sort({ name: 1 });
    return reply.code(200).send(successResponse(await withTimezone(clinics)));
  } catch (err) {
    console.error("getClinics error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const {
      name, logo, image_url, description, brandColor, phone, email, address, city, timezone, latitude, longitude, timings, facilities, upiVpa, merchantName
    } = req.body as {
      name: string; city: string; logo?: string; image_url?: string; description?: string; brandColor?: string;
      phone?: string; email?: string; address?: string; timezone?: string; latitude?: number; longitude?: number;
      timings?: string; facilities?: string[]; upiVpa?: string; merchantName?: string;
    };

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Clinic name and city are required"));
    }
    if (timezone && !isIanaTimezone(timezone)) return reply.code(400).send(errorResponse("A valid IANA timezone is required"));

    const filter: any = { _id: id, isActive: true };
    if (req.user?.role !== "root") {
      filter.organizationId = req.user!.organization_id;
    }

    const clinic = await Clinic.findOne(filter);
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found in your organization"));
    }

    const updated = await Clinic.findByIdAndUpdate(
      id,
      {
        name,
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
        facilities: facilities || [],
        ...(upiVpa !== undefined && { upiVpa: upiVpa.trim() }),
        ...(merchantName !== undefined && { merchantName: merchantName.trim() }),
      },
      { returnDocument: "after" }
    );

    return reply.code(200).send(successResponse(updated, "Clinic updated successfully"));
  } catch (err) {
    console.error("updateClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const filter: any = { _id: id, isActive: true };
    if (req.user?.role !== "root") {
      filter.organizationId = req.user!.organization_id;
    }

    const clinic = await Clinic.findOne(filter);
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found in your organization"));
    }

    const { Appointment } = await import("../models/Appointment.ts");
    const activeApptsCount = await Appointment.countDocuments({
      clinicId: id,
      status: { $in: ["pending", "confirmed", "checked-in", "in-consultation"] }
    });

    if (activeApptsCount > 0) {
      return reply.code(400).send(errorResponse(`Cannot deactivate clinic branch with ${activeApptsCount} active appointment(s). Please reassign or cancel them first.`));
    }

    await Clinic.updateOne({ _id: id }, { isActive: false });

    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    await DoctorAssignment.updateMany({ clinicId: id }, { isActive: false });

    return reply.code(200).send(successResponse(null, "Clinic branch deactivated successfully"));
  } catch (err) {
    console.error("deleteClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function reactivateClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const filter: any = { _id: id };
    if (req.user?.role !== "root") {
      filter.organizationId = req.user!.organization_id;
    }

    const clinic = await Clinic.findOne(filter);
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found in your organization"));
    }

    if (clinic.isActive) {
      return reply.code(200).send(successResponse(clinic, "Clinic branch is already active"));
    }

    // Check SaaS Clinic Quota Limit
    const org = await Organization.findById(clinic.organizationId);
    if (!org) {
      return reply.code(404).send(errorResponse("Target organization not found"));
    }

    const allowedClinics = org.maxClinics || 1;

    const existingCount = await Clinic.countDocuments({
      organizationId: clinic.organizationId,
      isActive: { $ne: false },
    });

    if (existingCount >= allowedClinics && req.user?.role !== "root") {
      return reply.code(403).send(
        errorResponse(
          `Clinic branch quota limit of ${allowedClinics} reached for ${org.name}'s ${org.plan?.toUpperCase() || "current"} plan. Upgrade your subscription plan or deactivate another branch before reactivating this clinic.`
        )
      );
    }

    clinic.isActive = true;
    await clinic.save();

    // Re-enable doctor assignments for active doctors in the organization
    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    const { User } = await import("../models/User.ts");
    const activeDoctorIds = await User.find({
      organization_id: clinic.organizationId,
      role: "doctor",
      status: { $ne: "inactive" },
    }).distinct("_id");

    if (activeDoctorIds.length > 0) {
      await DoctorAssignment.updateMany(
        { clinicId: clinic._id, doctorId: { $in: activeDoctorIds } },
        { isActive: true }
      );
    }

    return reply.code(200).send(successResponse(clinic, "Clinic branch reactivated successfully"));
  } catch (err) {
    console.error("reactivateClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
