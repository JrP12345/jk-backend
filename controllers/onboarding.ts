import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Doctor } from "../models/Doctor.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { Role } from "../models/Role.ts";
import {
  generateAccessToken,
  createRefreshToken,
  successResponse,
  errorResponse,
} from "../utilities/helpers.ts";
import { setAuthCookies } from "../utilities/types.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";

/**
 * Full set of permission codes granted to the built-in "admin" system role.
 * This is the exhaustive list of all permission tokens currently checked by
 * checkPermission() across all route handlers.
 */
const ADMIN_PERMISSIONS = [
  // Staff management
  "MANAGE_STAFF",
  "VIEW_STAFF",
  // Clinic management
  "MANAGE_CLINICS",
  "VIEW_CLINICS",
  // Organization settings
  "MANAGE_ORGANIZATION",
  // Beds & admissions
  "MANAGE_BEDS",
  "MANAGE_ADMISSIONS",
  "VIEW_ADMISSIONS",
  // Medicines & pharmacy
  "MANAGE_MEDICINES",
  // Laboratory & diagnostics
  "MANAGE_LAB_TESTS",
  // Billing
  "MANAGE_BILLING",
  "VIEW_BILLING",
  // Appointments
  "MANAGE_APPOINTMENTS",
  "VIEW_APPOINTMENTS",
  // Analytics
  "VIEW_ANALYTICS",
  // Queue
  "MANAGE_QUEUE",
  // EHR & Medical Records
  "VIEW_EHR",
  "MANAGE_EHR",
  "MANAGE_CLINICAL_NOTES",
  // Medication Administration (distinct from note authoring)
  "ADMINISTER_MEDICATION",
  // Diagnostic Orders & Results
  "MANAGE_ORDERS",
  // Discharge Summary & Encounter Closure
  "MANAGE_DISCHARGE_SUMMARY",
  // Clinical Search & Analytics
  "VIEW_ANALYTICS",
];

export const DOCTOR_PERMISSIONS = [
  "VIEW_STAFF",
  "VIEW_CLINICS",
  "VIEW_APPOINTMENTS",
  "MANAGE_APPOINTMENTS",
  "MANAGE_QUEUE",
  "VIEW_EHR",
  "MANAGE_EHR",
  "MANAGE_CLINICAL_NOTES",
  "ADMINISTER_MEDICATION",
  "MANAGE_ORDERS",
  "MANAGE_DISCHARGE_SUMMARY",
  "VIEW_ADMISSIONS",
  "MANAGE_ADMISSIONS",
  "VIEW_ANALYTICS",
];

export const RECEPTIONIST_PERMISSIONS = [
  "MANAGE_STAFF",
  "VIEW_STAFF",
  "MANAGE_CLINICS",
  "VIEW_CLINICS",
  "MANAGE_APPOINTMENTS",
  "VIEW_APPOINTMENTS",
  "MANAGE_QUEUE",
  "VIEW_BILLING",
  "MANAGE_BILLING",
  "VIEW_ADMISSIONS",
  "MANAGE_ADMISSIONS",
  "MANAGE_BEDS",
];

export const PATIENT_PERMISSIONS = [
  "VIEW_APPOINTMENTS",
  "VIEW_EHR",
  "VIEW_BILLING",
];

// ─── Step 1: Create Organization + Admin ────────────────────────
export async function createOrganization(req: FastifyRequest, reply: FastifyReply) {
  try {
    // ── Security Gate: Dev-Only ───────────────────────────────────
    // Onboarding (creating a new org) is only allowed in development.
    // In production this endpoint is fully disabled — no exceptions.
    if (process.env.NODE_ENV === "production") {
      return reply.code(403).send(errorResponse("Forbidden: onboarding is disabled in production"));
    }

    // ── Security Gate: Onboarding Secret ─────────────────────────
    // Only the root/seed operator who knows ONBOARDING_SECRET can create orgs.
    // The frontend passes it in the X-Onboarding-Secret header.
    const providedSecret = (req.headers["x-onboarding-secret"] as string) || "";
    const expectedSecret = process.env.ONBOARDING_SECRET || "";
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return reply.code(403).send(errorResponse("Forbidden: invalid onboarding key"));
    }


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

    return await withTransaction(async (session) => {
      const org = await createWithSession(Organization, {
        name: org_name,
        city,
        address: address || null,
        phone: org_phone || null,
        email: org_email || null,
        description: description || null,
        image_url: image_url || null,
        timings: timings || null,
        working_days: working_days || null,
      }, session);

      const hashedPassword = await bcrypt.hash(admin_password, 10);

      const adminUser = await createWithSession(User, {
        name: admin_name,
        email: admin_email,
        password: hashedPassword,
        phone: admin_phone || null,
        role: "admin",
      }, session);

      await createWithSession(OrgMember, {
        userId: adminUser._id,
        organizationId: org._id,
        role: "admin",
      }, session);

      // Upsert the admin Role document with all permissions.
      // Uses $setOnInsert so a manually-customized admin Role is never overwritten
      // by subsequent org-creation calls.
      await Role.findOneAndUpdate(
        { name: "admin" },
        {
          $setOnInsert: {
            name: "admin",
            description: "Full-access system administrator. Manages all organizational resources.",
            isSystemRole: true,
            permissions: ADMIN_PERMISSIONS,
          },
        },
        { upsert: true, session } as any
      );

      const orgIdStr = org._id.toString();
      const userIdStr = adminUser._id.toString();

      // Set httpOnly cookies so admin is immediately logged in
      const payload = { id: userIdStr, email: admin_email, role: "admin", organization_id: orgIdStr };
      const accessToken = generateAccessToken(payload);
      const refreshToken = await createRefreshToken(userIdStr);
      setAuthCookies(reply, accessToken, refreshToken);

      return reply.code(201).send(
        successResponse(
          {
            organization: { id: orgIdStr, name: org_name, city },
            user: { id: userIdStr, name: admin_name, email: admin_email, role: "admin", organization_id: orgIdStr },
          },
          "Organization created and admin registered"
        )
      );
    });
  } catch (err) {
    console.error("createOrganization error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Step 2a: Admin adds a Doctor ───────────────────────────────
export async function addDoctor(req: FastifyRequest, reply: FastifyReply) {
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

    return await withTransaction(async (session) => {
      const hashedPassword = await bcrypt.hash(password, 10);

      const newDoctorUser = await createWithSession(User, {
        name,
        email,
        password: hashedPassword,
        phone: phone || null,
        role: "doctor",
      }, session);

      await createWithSession(Doctor, {
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
      }, session);

      await createWithSession(OrgMember, {
        userId: newDoctorUser._id,
        organizationId: orgId,
        role: "doctor",
      }, session);

      return reply.code(201).send(
        successResponse({ id: newDoctorUser._id.toString(), name, email, role: "doctor", organization_id: orgId, specialization }, "Doctor registered successfully")
      );
    });
  } catch (err) {
    console.error("addDoctor error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Step 2b: Admin adds a Receptionist ─────────────────────────
export async function addReceptionist(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { name, email, password, phone, shift, clinicId } = req.body as {
      name: string; email: string; password: string; phone?: string; shift?: string; clinicId?: string;
    };

    if (!name || !email || !password) return reply.code(400).send(errorResponse("name, email and password are required"));

    const emailCheck = await User.findOne({ email });
    if (emailCheck) return reply.code(409).send(errorResponse("Email already registered"));

    return await withTransaction(async (session) => {
      const hashedPassword = await bcrypt.hash(password, 10);

      const newRecUser = await createWithSession(User, {
        name,
        email,
        password: hashedPassword,
        phone: phone || null,
        role: "receptionist",
      }, session);

      await createWithSession(Receptionist, {
        userId: newRecUser._id,
        organizationId: orgId,
        clinicId: clinicId || null,
        shift: shift || null,
      }, session);

      await createWithSession(OrgMember, {
        userId: newRecUser._id,
        organizationId: orgId,
        role: "receptionist",
      }, session);

      return reply.code(201).send(
        successResponse({ id: newRecUser._id.toString(), name, email, role: "receptionist", organization_id: orgId, shift, clinicId }, "Receptionist registered successfully")
      );
    });
  } catch (err) {
    console.error("addReceptionist error:", err);
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
