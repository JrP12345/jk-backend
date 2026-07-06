import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Doctor } from "../models/Doctor.ts";
import { Receptionist } from "../models/Receptionist.ts";
import {
  generateKeyPair,
  generateAccessToken,
  createRefreshToken,
  successResponse,
  errorResponse,
} from "../utilities/helpers.ts";
import { setAuthCookies } from "../utilities/types.ts";

// ─── Step 1: Create Organization + Admin ────────────────────────
export async function createOrganization(req: FastifyRequest, reply: FastifyReply) {
  let createdOrgId: string | null = null;
  let createdUserId: string | null = null;
  let createdMemberId: string | null = null;

  try {
    const {
      org_name, city, address, org_phone, org_email, description, image_url, timings, working_days,
      admin_name, admin_email, admin_password, admin_phone,
    } = req.body as {
      org_name: string; city: string; address?: string; org_phone?: string; org_email?: string;
      description?: string; image_url?: string; timings?: string; working_days?: string;
      admin_name: string; admin_email: string; admin_password: string; admin_phone?: string;
    };

    if (!org_name || !city || !admin_name || !admin_email || !admin_password) {
      return reply.code(400).send(errorResponse("org_name, city, admin_name, admin_email, admin_password are required"));
    }

    const emailCheck = await User.findOne({ email: admin_email });
    if (emailCheck) {
      return reply.code(409).send(errorResponse("Admin email already registered"));
    }

    const org = await Organization.create({
      name: org_name,
      city,
      address: address || null,
      phone: org_phone || null,
      email: org_email || null,
      description: description || null,
      image_url: image_url || null,
      timings: timings || null,
      working_days: working_days || null,
    });
    createdOrgId = org._id.toString();

    const hashedPassword = await bcrypt.hash(admin_password, 10);
    const { publicKey, privateKey } = generateKeyPair();

    const adminUser = await User.create({
      name: admin_name,
      email: admin_email,
      password: hashedPassword,
      phone: admin_phone || null,
      role: "admin",
      publicKey,
      privateKey,
    });
    createdUserId = adminUser._id.toString();

    const member = await OrgMember.create({
      userId: adminUser._id,
      organizationId: org._id,
      role: "admin",
    });
    createdMemberId = member._id.toString();

    // Set httpOnly cookies so admin is immediately logged in
    const payload = { id: adminUser.id, email: admin_email, role: "admin", organization_id: org.id };
    const accessToken = generateAccessToken(payload, privateKey);
    const refreshToken = await createRefreshToken(adminUser.id);
    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(201).send(
      successResponse(
        {
          organization: { id: org.id, name: org_name, city },
          user: { id: adminUser.id, name: admin_name, email: admin_email, role: "admin", organization_id: org.id },
        },
        "Organization created and admin registered"
      )
    );
  } catch (err) {
    console.error("createOrganization error:", err);
    if (createdMemberId) await OrgMember.deleteOne({ _id: createdMemberId }).catch(console.error);
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(console.error);
    if (createdOrgId) await Organization.deleteOne({ _id: createdOrgId }).catch(console.error);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Step 2a: Admin adds a Doctor ───────────────────────────────
export async function addDoctor(req: FastifyRequest, reply: FastifyReply) {
  let createdUserId: string | null = null;
  let createdDoctorId: string | null = null;
  let createdMemberId: string | null = null;

  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { 
      name, email, password, phone, specialization, qualification, experience_years,
      fees, timings, working_days, description, image_url 
    } = req.body as {
      name: string; email: string; password: string; phone?: string;
      specialization?: string; qualification?: string; experience_years?: number;
      fees?: number; timings?: string; working_days?: string; description?: string; image_url?: string;
    };

    if (!name || !email || !password) return reply.code(400).send(errorResponse("name, email and password are required"));

    const emailCheck = await User.findOne({ email });
    if (emailCheck) return reply.code(409).send(errorResponse("Email already registered"));

    const hashedPassword = await bcrypt.hash(password, 10);
    const { publicKey, privateKey } = generateKeyPair();

    const newDoctorUser = await User.create({
      name,
      email,
      password: hashedPassword,
      phone: phone || null,
      role: "doctor",
      publicKey,
      privateKey,
    });
    createdUserId = newDoctorUser._id.toString();

    const doctorProfile = await Doctor.create({
      userId: newDoctorUser._id,
      organizationId: orgId,
      specialization: specialization || null,
      qualification: qualification || null,
      experience_years: experience_years || null,
      fees: fees || null,
      timings: timings || null,
      working_days: working_days || null,
      description: description || null,
      image_url: image_url || null,
    });
    createdDoctorId = doctorProfile._id.toString();

    const member = await OrgMember.create({
      userId: newDoctorUser._id,
      organizationId: orgId,
      role: "doctor",
    });
    createdMemberId = member._id.toString();

    return reply.code(201).send(
      successResponse({ id: newDoctorUser.id, name, email, role: "doctor", organization_id: orgId, specialization }, "Doctor registered successfully")
    );
  } catch (err) {
    console.error("addDoctor error:", err);
    if (createdMemberId) await OrgMember.deleteOne({ _id: createdMemberId }).catch(console.error);
    if (createdDoctorId) await Doctor.deleteOne({ _id: createdDoctorId }).catch(console.error);
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(console.error);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Step 2b: Admin adds a Receptionist ─────────────────────────
export async function addReceptionist(req: FastifyRequest, reply: FastifyReply) {
  let createdUserId: string | null = null;
  let createdRecId: string | null = null;
  let createdMemberId: string | null = null;

  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { name, email, password, phone, shift, clinicId } = req.body as {
      name: string; email: string; password: string; phone?: string; shift?: string; clinicId?: string;
    };

    if (!name || !email || !password) return reply.code(400).send(errorResponse("name, email and password are required"));

    const emailCheck = await User.findOne({ email });
    if (emailCheck) return reply.code(409).send(errorResponse("Email already registered"));

    const hashedPassword = await bcrypt.hash(password, 10);
    const { publicKey, privateKey } = generateKeyPair();

    const newRecUser = await User.create({
      name,
      email,
      password: hashedPassword,
      phone: phone || null,
      role: "receptionist",
      publicKey,
      privateKey,
    });
    createdUserId = newRecUser._id.toString();

    const receptionistProfile = await Receptionist.create({
      userId: newRecUser._id,
      organizationId: orgId,
      clinicId: clinicId || null,
      shift: shift || null,
    });
    createdRecId = receptionistProfile._id.toString();

    const member = await OrgMember.create({
      userId: newRecUser._id,
      organizationId: orgId,
      role: "receptionist",
    });
    createdMemberId = member._id.toString();

    return reply.code(201).send(
      successResponse({ id: newRecUser.id, name, email, role: "receptionist", organization_id: orgId, shift, clinicId }, "Receptionist registered successfully")
    );
  } catch (err) {
    console.error("addReceptionist error:", err);
    if (createdMemberId) await OrgMember.deleteOne({ _id: createdMemberId }).catch(console.error);
    if (createdRecId) await Receptionist.deleteOne({ _id: createdRecId }).catch(console.error);
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(console.error);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Get Org Staff ──────────────────────────────────────────────
export async function getOrgStaff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const doctors = await Doctor.find({ organizationId: orgId }).populate("userId");
    const receptionists = await Receptionist.find({ organizationId: orgId })
      .populate("userId")
      .populate("clinicId", "name");

    const formattedDoctors = doctors
      .filter((d: any) => d.userId && d.userId.isActive)
      .map((d: any) => ({
        id: d.userId.id,
        name: d.userId.name,
        email: d.userId.email,
        phone: d.userId.phone,
        specialization: d.specialization,
        qualification: d.qualification,
        experience_years: d.experience_years,
        fees: d.fees,
        timings: d.timings,
        working_days: d.working_days,
        description: d.description,
        image_url: d.image_url
      }));

    const formattedReceptionists = receptionists
      .filter((r: any) => r.userId && r.userId.isActive)
      .map((r: any) => ({
        id: r.userId.id,
        name: r.userId.name,
        email: r.userId.email,
        phone: r.userId.phone,
        shift: r.shift,
        clinicId: r.clinicId?.id || r.clinicId || null,
        clinicName: r.clinicId?.name || null
      }));

    return reply.code(200).send(successResponse({ doctors: formattedDoctors, receptionists: formattedReceptionists }));
  } catch (err) {
    console.error("getOrgStaff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Update Doctor ──────────────────────────────────────────────
export async function updateDoctor(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };
    const { 
      name, phone, specialization, qualification, experience_years,
      fees, timings, working_days, description, image_url 
    } = req.body as any;

    if (!name) return reply.code(400).send(errorResponse("name is required"));

    const doctor = await Doctor.findOne({ userId: id, organizationId: orgId });
    if (!doctor) return reply.code(404).send(errorResponse("Doctor not found or not in your organization"));

    await User.updateOne({ _id: id }, { name, phone: phone || null });
    await Doctor.updateOne(
      { userId: id },
      {
        specialization: specialization || null,
        qualification: qualification || null,
        experience_years: experience_years || null,
        fees: fees || null,
        timings: timings || null,
        working_days: working_days || null,
        description: description || null,
        image_url: image_url || null
      }
    );

    return reply.code(200).send(successResponse(null, "Doctor updated successfully"));
  } catch (err) {
    console.error("updateDoctor error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Update Receptionist ────────────────────────────────────────
export async function updateReceptionist(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };
    const { name, phone, shift, clinicId } = req.body as any;

    if (!name) return reply.code(400).send(errorResponse("name is required"));

    const receptionist = await Receptionist.findOne({ userId: id, organizationId: orgId });
    if (!receptionist) return reply.code(404).send(errorResponse("Receptionist not found or not in your organization"));

    await User.updateOne({ _id: id }, { name, phone: phone || null });
    await Receptionist.updateOne({ userId: id }, { shift: shift || null, clinicId: clinicId || null });

    return reply.code(200).send(successResponse(null, "Receptionist updated successfully"));
  } catch (err) {
    console.error("updateReceptionist error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Delete Staff ───────────────────────────────────────────────
export async function deleteStaff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    const verify = await OrgMember.findOne({ userId: id, organizationId: orgId });
    if (!verify) return reply.code(404).send(errorResponse("Staff not found in your organization"));

    await User.updateOne({ _id: id }, { isActive: false });
    return reply.code(200).send(successResponse(null, "Staff deactivated successfully"));
  } catch (err) {
    console.error("deleteStaff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Organization Settings ───────────────────────────────────────────────
export async function getOrganizationSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const org = await Organization.findById(orgId);
    if (!org) {
      return reply.code(404).send(errorResponse("Organization not found"));
    }
    return reply.send(successResponse(org, "Organization fetched successfully"));
  } catch (error) {
    console.error(error);
    return reply.code(500).send(errorResponse("Failed to fetch organization settings"));
  }
}

export async function updateOrganizationSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const {
      name, city, address, phone, email, description, image_url, timings, working_days
    } = req.body as any;

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Name and city are required"));
    }

    const result = await Organization.findByIdAndUpdate(
      orgId,
      {
        name,
        city,
        address: address || null,
        phone: phone || null,
        email: email || null,
        description: description || null,
        image_url: image_url || null,
        timings: timings || null,
        working_days: working_days || null,
      },
      { new: true }
    );

    return reply.send(successResponse(result, "Organization updated successfully"));
  } catch (error) {
    console.error(error);
    return reply.code(500).send(errorResponse("Failed to update organization"));
  }
}
