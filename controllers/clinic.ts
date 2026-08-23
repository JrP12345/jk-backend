import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
import { Organization } from "../models/Organization.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function createClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const {
      organizationId: reqOrgId, name, logo, description, phone, email, address, city, latitude, longitude, timings, facilities
    } = (req.body || {}) as {
      organizationId?: string; name: string; city: string; logo?: string; description?: string;
      phone?: string; email?: string; address?: string; latitude?: number;
      longitude?: number; timings?: string; facilities?: string[];
    };

    let orgId = reqOrgId || req.user!.organization_id;
    if (!orgId && req.user?.role === "root") {
      const firstOrg = await Organization.findOne().select("_id").lean();
      if (firstOrg) orgId = firstOrg._id.toString();
    }

    if (!orgId) return reply.code(400).send(errorResponse("Organization context is required to create a clinic branch"));

    // Check SaaS Clinic Quota Limit
    const org = await Organization.findById(orgId);
    if (!org) return reply.code(404).send(errorResponse("Target organization not found"));

    if (org.maxClinics) {
      const existingCount = await Clinic.countDocuments({ organizationId: orgId, isActive: true });
      if (existingCount >= org.maxClinics && req.user?.role !== "root") {
        return reply.code(403).send(errorResponse(`Clinic branch quota limit of ${org.maxClinics} reached for ${org.name}'s ${org.plan?.toUpperCase() || "current"} plan. Upgrade subscription to add more clinic branches.`));
      }
    }

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Clinic name and city are required"));
    }

    const clinic = await Clinic.create({
      organizationId: orgId,
      name,
      logo: logo || null,
      description: description || null,
      phone: phone || null,
      email: email || null,
      address: address || null,
      city,
      latitude: latitude !== undefined ? latitude : null,
      longitude: longitude !== undefined ? longitude : null,
      timings: timings || null,
      facilities: facilities || [],
    });

    return reply.code(201).send(successResponse(clinic, "Clinic created successfully"));
  } catch (err) {
    console.error("createClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getClinics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) {
      if (req.user?.role === "root") {
        const activeOrgs = await Organization.find().select("_id").lean();
        const activeOrgIds = activeOrgs.map((o) => o._id);
        const clinics = await Clinic.find({ organizationId: { $in: activeOrgIds }, isActive: true }).limit(20).sort({ name: 1 });
        return reply.code(200).send(successResponse(clinics));
      }
      return reply.code(200).send(successResponse([]));
    }

    const clinics = await Clinic.find({ organizationId: orgId, isActive: true }).sort({ name: 1 });
    return reply.code(200).send(successResponse(clinics));
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
      name, logo, image_url, description, phone, email, address, city, latitude, longitude, timings, facilities
    } = req.body as {
      name: string; city: string; logo?: string; image_url?: string; description?: string;
      phone?: string; email?: string; address?: string; latitude?: number; longitude?: number;
      timings?: string; facilities?: string[];
    };

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Clinic name and city are required"));
    }

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
        phone: phone || null,
        email: email || null,
        address: address || null,
        city,
        latitude: latitude !== undefined ? latitude : null,
        longitude: longitude !== undefined ? longitude : null,
        timings: timings || null,
        facilities: facilities || [],
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
