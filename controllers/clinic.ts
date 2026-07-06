import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function createClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const {
      name, logo, description, phone, email, address, city, latitude, longitude, timings, facilities
    } = req.body as {
      name: string; city: string; logo?: string; description?: string;
      phone?: string; email?: string; address?: string; latitude?: number;
      longitude?: number; timings?: string; facilities?: string[];
    };

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
      latitude: latitude || null,
      longitude: longitude || null,
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
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const clinics = await Clinic.find({ organizationId: orgId, isActive: true }).sort({ name: 1 });
    return reply.code(200).send(successResponse(clinics));
  } catch (err) {
    console.error("getClinics error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const {
      name, logo, description, phone, email, address, city, latitude, longitude, timings, facilities
    } = req.body as any;

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Clinic name and city are required"));
    }

    const clinic = await Clinic.findOne({ _id: id, organizationId: orgId, isActive: true });
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found in your organization"));
    }

    const updated = await Clinic.findByIdAndUpdate(
      id,
      {
        name,
        logo: logo || null,
        description: description || null,
        phone: phone || null,
        email: email || null,
        address: address || null,
        city,
        latitude: latitude || null,
        longitude: longitude || null,
        timings: timings || null,
        facilities: facilities || [],
      },
      { new: true }
    );

    return reply.code(200).send(successResponse(updated, "Clinic updated successfully"));
  } catch (err) {
    console.error("updateClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid clinic ID"));
    }

    const clinic = await Clinic.findOne({ _id: id, organizationId: orgId, isActive: true });
    if (!clinic) {
      return reply.code(404).send(errorResponse("Clinic not found in your organization"));
    }

    await Clinic.updateOne({ _id: id }, { isActive: false });

    return reply.code(200).send(successResponse(null, "Clinic deactivated successfully"));
  } catch (err) {
    console.error("deleteClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
