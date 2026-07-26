import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Organization } from "../models/Organization.ts";
import { Doctor } from "../models/Doctor.ts";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { successResponse, errorResponse, escapeRegex } from "../utilities/helpers.ts";

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

    const filter: any = { isActive: true };

    if (city) {
      filter.city = { $regex: new RegExp(escapeRegex(city), "i") };
    }

    if (search) {
      const safeSearch = escapeRegex(search);
      filter.$or = [
        { name: { $regex: new RegExp(safeSearch, "i") } },
        { city: { $regex: new RegExp(safeSearch, "i") } },
        { address: { $regex: new RegExp(safeSearch, "i") } }
      ];
    }

    // Specialization filtering
    if (specialization) {
      const safeSpecialization = escapeRegex(specialization);
      const doctors = await Doctor.find({ specialization: { $regex: new RegExp(safeSpecialization, "i") } });
      const doctorUserIds = doctors.map(d => d.userId);

      const assignments = await DoctorAssignment.find({ doctorId: { $in: doctorUserIds }, isActive: true });
      const clinicIds = assignments.map(a => a.clinicId);

      filter._id = { $in: clinicIds };
    }

    const clinics = await Clinic.find(filter).sort({ name: 1 });

    const formattedClinics = clinics.map(c => {
      const json = c.toJSON();
      return {
        ...json,
        image_url: json.logo || null
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
      });

    const formattedDoctors = await Promise.all(assignments.map(async (assign: any) => {
      if (!assign.doctorId) return null;
      
      const docProfile = await Doctor.findOne({ userId: assign.doctorId._id });

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

      return {
        id: assign.doctorId._id.toString(),
        name: assign.doctorId.name,
        email: assign.doctorId.email,
        phone: assign.doctorId.phone,
        specialization: docProfile?.specialization || "General Medicine",
        qualification: docProfile?.qualification || "MBBS",
        experience_years: docProfile?.experience_years || 1,
        fees: assign.fees,
        timings: assign.workingHours,
        working_days: workingDays,
        description: docProfile?.description || "",
        image_url: docProfile?.image_url || null,
        rating: docProfile?.rating || 5,
        reviewsCount: docProfile?.reviewsCount || 0,
        languages: docProfile?.languages || ["English"]
      };
    }));

    const cleanDoctors = formattedDoctors.filter(d => d !== null);

    const clinicJson = clinic.toJSON();
    return reply.code(200).send(successResponse({
      ...clinicJson,
      image_url: clinicJson.logo || null,
      doctors: cleanDoctors
    }));
  } catch (err) {
    console.error("getPublicClinicDetails error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
