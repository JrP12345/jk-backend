import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Doctor } from "../models/Doctor.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { Role } from "../models/Role.ts";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { Medicine } from "../models/Medicine.ts";
import { Prescription } from "../models/Prescription.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Invoice } from "../models/Invoice.ts";
import { Department } from "../models/Department.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { OnboardingDraft } from "../models/OnboardingDraft.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";
import { validatePasswordStrength } from "../middleware/auth.ts";
import {
  generateAccessToken,
  verifyAccessToken,
  createRefreshToken,
  successResponse,
  errorResponse,
} from "../utilities/helpers.ts";
import { setAuthCookies } from "../utilities/types.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { resolveTargetOrganizationId } from "../utilities/tenant.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { encrypt, decrypt } from "../utilities/encryption.ts";
import { seedModulesForOrg } from "./moduleRegistry.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { getFrontendBaseUrl } from "../utilities/config.ts";
import {
  ADMIN_PERMISSIONS,
  DOCTOR_PERMISSIONS,
  RECEPTIONIST_PERMISSIONS,
  NURSE_PERMISSIONS,
  LAB_TECH_PERMISSIONS,
  PHARMACIST_PERMISSIONS,
  CASHIER_PERMISSIONS,
  CLINIC_MANAGER_PERMISSIONS,
  PATIENT_PERMISSIONS,
  FAMILY_MEMBER_PERMISSIONS,
} from "../utilities/permissions.ts";

export {
  ADMIN_PERMISSIONS,
  DOCTOR_PERMISSIONS,
  RECEPTIONIST_PERMISSIONS,
  NURSE_PERMISSIONS,
  LAB_TECH_PERMISSIONS,
  PHARMACIST_PERMISSIONS,
  CASHIER_PERMISSIONS,
  CLINIC_MANAGER_PERMISSIONS,
  PATIENT_PERMISSIONS,
  FAMILY_MEMBER_PERMISSIONS,
};

/**
 * Upsert all built-in system role documents into the Role collection.
 *
 * This is the single source of truth for default role permissions.
 * It uses $setOnInsert so custom role edits made via the Role admin UI
 * are never overwritten on subsequent calls.
 *
 * Call this:
 *  - During org onboarding (createOrganization)
 *  - On server startup as a one-time migration guard
 */
export async function seedDefaultRoles(session?: any) {
  const defaultRoles = [
    {
      name: "admin",
      description: "Full-access system administrator. Manages all organizational resources.",
      isSystemRole: true,
      permissions: ADMIN_PERMISSIONS,
    },
    {
      name: "clinic_manager",
      description: "Small clinic all-in-one desk operator (OPD Queue, Pharmacy, Cashier).",
      isSystemRole: true,
      permissions: CLINIC_MANAGER_PERMISSIONS,
    },
    {
      name: "doctor",
      description: "Clinical physician with access to EHR, prescriptions, and appointments.",
      isSystemRole: true,
      permissions: DOCTOR_PERMISSIONS,
    },
    {
      name: "receptionist",
      description: "Front-desk staff managing appointments, queue, billing, and admissions.",
      isSystemRole: true,
      permissions: RECEPTIONIST_PERMISSIONS,
    },
    {
      name: "nurse",
      description: "Nursing staff managing patient care, medication administration, and observations.",
      isSystemRole: true,
      permissions: NURSE_PERMISSIONS,
    },
    {
      name: "lab_tech",
      description: "Laboratory technician managing diagnostic orders and results.",
      isSystemRole: true,
      permissions: LAB_TECH_PERMISSIONS,
    },
    {
      name: "pharmacist",
      description: "Pharmacy staff managing medicine inventory and prescriptions.",
      isSystemRole: true,
      permissions: PHARMACIST_PERMISSIONS,
    },
    {
      name: "cashier",
      description: "Billing and cashier staff managing invoices and payments.",
      isSystemRole: true,
      permissions: CASHIER_PERMISSIONS,
    },
    {
      name: "patient",
      description: "Patient with access to their own health records and appointments.",
      isSystemRole: true,
      permissions: PATIENT_PERMISSIONS,
    },
    {
      name: "family_member",
      description: "Family member with limited access to patient records.",
      isSystemRole: true,
      permissions: FAMILY_MEMBER_PERMISSIONS,
    },
  ];

  for (const role of defaultRoles) {
    const opts: any = { upsert: true, returnDocument: "after" };
    if (session) opts.session = session;

    // Use $addToSet so existing custom roles gain any missing built-in permissions
    // without losing permissions the admin may have manually added.
    // $setOnInsert only fires on INSERT — so name/description/isSystemRole are
    // set on first creation but never overwritten on subsequent runs.
    await Role.findOneAndUpdate(
      { name: role.name },
      {
        $setOnInsert: {
          name: role.name,
          description: role.description,
          isSystemRole: role.isSystemRole,
        },
        $addToSet: { permissions: { $each: role.permissions } },
      },
      opts
    );
  }
}

// ─── Step 1: Create Organization + Admin ────────────────────────
export async function createOrganization(req: FastifyRequest, reply: FastifyReply) {

  try {
    // ── Security Gate: Onboarding Secret / Root Admin ─────────────
    let userRole = (req as any).user?.role;
    if (!userRole) {
      let token =
        req.cookies?.access_token ||
        (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : undefined);

      if (!token && req.headers.cookie) {
        const match = req.headers.cookie.match(/access_token=([^;]+)/);
        if (match) token = decodeURIComponent(match[1]);
      }

      if (token) {
        try {
          const decoded = verifyAccessToken(token);
          (req as any).user = decoded;
          userRole = decoded.role;
        } catch {
          // ignore
        }
      }
    }

    const isRootUser = userRole === "root";
    const providedSecret = (req.headers["x-onboarding-secret"] as string) || "";
    const expectedSecret = process.env.ONBOARDING_SECRET?.trim();

    if (!isRootUser && process.env.NODE_ENV === "production") {
      return reply.code(403).send(errorResponse("Forbidden: public self-service onboarding is disabled in production"));
    }

    if (!isRootUser && expectedSecret && providedSecret !== expectedSecret && process.env.NODE_ENV !== "test") {
      return reply.code(403).send(errorResponse("Forbidden: invalid onboarding key"));
    }

    const {
      org_name, city, address, org_phone, org_email, description, image_url, timings, working_days,
      admin_name, admin_email, admin_password, admin_phone,
      clinic_name, clinic_city, clinic_address, clinic_phone, clinic_email,
      taxId, licenseNumber, currency, timezone, sendWelcomeEmail,
    } = req.body as {
      org_name: string; city: string; address?: string; org_phone?: string; org_email?: string;
      description?: string; image_url?: string; timings?: string; working_days?: string;
      admin_name: string; admin_email: string; admin_password: string; admin_phone?: string;
      clinic_name?: string; clinic_city?: string; clinic_address?: string; clinic_phone?: string; clinic_email?: string;
      taxId?: string; licenseNumber?: string; currency?: string; timezone?: string; sendWelcomeEmail?: boolean;
    };

    if (!org_name || !city || !admin_name || !admin_email) {
      return reply.code(400).send(errorResponse("org_name, city, admin_name, and admin_email are required"));
    }

    const existingOrg = await Organization.findOne({
      name: new RegExp(`^${org_name.trim()}$`, "i"),
      city: new RegExp(`^${city.trim()}$`, "i"),
    });
    if (existingOrg) {
      return reply.code(409).send(errorResponse(`An organization named "${org_name.trim()}" already exists in ${city.trim()}`));
    }

    return await withTransaction(async (session) => {
      const selectedPlan = (req.body as any).plan || "starter";
      let maxClinics = (req.body as any).maxClinics || 10;
      let maxDoctors = (req.body as any).maxDoctors || 50;
      let maxStaff = (req.body as any).maxStaff || 50;

      if (selectedPlan === "pro") {
        maxClinics = (req.body as any).maxClinics || 25;
        maxDoctors = (req.body as any).maxDoctors || 100;
        maxStaff = (req.body as any).maxStaff || 100;
      } else if (selectedPlan === "enterprise") {
        maxClinics = (req.body as any).maxClinics || 999;
        maxDoctors = (req.body as any).maxDoctors || 999;
        maxStaff = (req.body as any).maxStaff || 999;
      }

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
        plan: selectedPlan,
        maxClinics,
        maxDoctors,
        maxStaff,
        taxId: taxId?.trim() || undefined,
        licenseNumber: licenseNumber?.trim() || undefined,
        currency: currency || "INR",
        timezone: timezone || "Asia/Kolkata",
        onboardingStatus: "CLINIC_CREATED",
        isOnboarded: false,
      }, session);

      // A root account is provisioned separately by the deployment/seed flow.
      // Organization onboarding creates the requested organization administrator;
      // it must not silently create a second identity with the same email.
      let rootQuery = User.findOne({ role: "root" });
      if (session) rootQuery = rootQuery.session(session);
      let rootUser = await rootQuery;

      // Reuse the authenticated root account when it is the requested organization administrator;
      // otherwise create a distinct administrator with the supplied identity.
      let emailQuery = User.findOne({ email: admin_email.trim().toLowerCase() });
      if (emailQuery && session) emailQuery = emailQuery.session(session);
      const emailTaken = emailQuery ? await emailQuery : null;

      if (emailTaken) {
        return reply.code(409).send(errorResponse("Administrator email is already registered; provide a unique administrator email for this organization"));
      }

      if (!admin_password) {
        return reply.code(400).send(errorResponse("admin_password is required for a new organization administrator"));
      }
      const strength = validatePasswordStrength(admin_password);
      if (!strength.valid) {
        return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
      }
      const hashedAdminPassword = await bcrypt.hash(admin_password, 10);
      const adminUser = await createWithSession(User, {
        name: admin_name,
        email: admin_email.trim().toLowerCase(),
        password: hashedAdminPassword,
        phone: admin_phone || null,
        role: "admin",
      }, session);

      if (!adminUser) {
        return reply.code(500).send(errorResponse("Failed to initialize administrator user"));
      }

      await createWithSession(OrgMember, {
        userId: adminUser._id,
        organizationId: org._id,
        role: "admin",
      }, session);

      // Automatically create Primary Clinic branch for the Organization
      await createWithSession(Clinic, {
        organizationId: org._id,
        name: clinic_name?.trim() || `${org_name} (Main Clinic)`,
        city: clinic_city?.trim() || city,
        address: clinic_address || address || null,
        phone: clinic_phone || org_phone || null,
        email: clinic_email || org_email || null,
        timings: timings || null,
      }, session);

      // Seed default module toggles for the new organization (P1 = enabled, P2/P3 = disabled)
      await seedModulesForOrg(org._id.toString(), adminUser?._id?.toString(), session);

      // Upsert all system role documents so that permission checks work for every role type.
      await seedDefaultRoles(session);

      const orgIdStr = org._id.toString();

      // Initialize Subscription with custom trial days if specified
      const customTrialDays = Number((req.body as any).trialDays) || 15;
      await subscriptionService.getOrInitializeSubscription(orgIdStr, customTrialDays);

      // Only set auth cookies if this is an initial unauthenticated onboarding flow (not a root admin adding orgs)
      if (!isRootUser) {
        const userIdStr = adminUser._id.toString();
        const payload = { id: userIdStr, email: adminUser.email, role: adminUser.role, organization_id: orgIdStr };
        const accessToken = generateAccessToken(payload);
        const refreshToken = await createRefreshToken(userIdStr, { organizationId: orgIdStr });
        setAuthCookies(reply, accessToken, refreshToken);
      }

      eventBus.publish({
        eventType: EVENT_TYPES.ORG_CREATED,
        category: "organization",
        targetUserId: adminUser._id.toString(),
        title: "Organization Created",
        message: `Welcome to Anant! Organization workspace (${org_name}) is now active.`,
        severity: "success",
        organizationId: orgIdStr,
        actionUrl: "/dashboard",
      });

      if (sendWelcomeEmail !== false && admin_email && admin_password) {
        const portalUrl = `${getFrontendBaseUrl()}/login`;
        emailProvider.sendEmail({
          to: admin_email.trim().toLowerCase(),
          subject: `Welcome to ANANT - ${org_name} Workspace Provisioned`,
          text: `Hello ${admin_name},\n\nYour organization workspace (${org_name}) has been provisioned on ANANT Healthcare OS.\n\nLogin Portal: ${portalUrl}\nEmail: ${admin_email}\nPassword: ${admin_password}\n\nPlease sign in to configure your clinical staff and operational settings.`,
          html: `<p>Hello <strong>${admin_name}</strong>,</p><p>Your organization workspace (<strong>${org_name}</strong>) has been provisioned on ANANT Healthcare OS.</p><ul><li><strong>Login Portal:</strong> <a href="${portalUrl}">${portalUrl}</a></li><li><strong>Email:</strong> ${admin_email}</li><li><strong>Password:</strong> ${admin_password}</li></ul><p>Please sign in to configure your clinical staff and operational settings.</p>`,
        }).catch((e) => console.error("Welcome email send error:", e));
      }

      return reply.code(201).send(
        successResponse(
          {
            organization: { id: orgIdStr, name: org_name, city },
            user: { id: adminUser._id.toString(), name: adminUser.name, email: adminUser.email, role: adminUser.role, organization_id: orgIdStr },
          },
          "Organization created and admin registered"
        )
      );
    });
  } catch (err: any) {
    console.error("createOrganization error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── Get All Organizations (Root Admin / Tenant View) ──────────────
export async function getAllOrganizations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    const orgId = req.user?.organization_id;

    let query = {};
    if (userRole !== "root") {
      if (!orgId) {
        return reply.send(successResponse([], "No organization linked"));
      }
      query = { _id: orgId };
    }

    const orgs = await Organization.find(query).sort({ createdAt: -1 }).lean();
    const formattedOrgs = orgs.map((o: any) => ({
      ...o,
      id: o._id ? o._id.toString() : o.id,
    }));

    return reply.send(successResponse(formattedOrgs, "Organizations fetched successfully"));
  } catch (err: any) {
    console.error("getAllOrganizations error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to fetch organizations"));
  }
}

// ─── Update Organization By ID (Root / Org Admin) ───────────────
export async function updateOrganizationById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { name, city, address, phone, email, plan, maxClinics, maxDoctors, maxStaff, status } = req.body as any;

    if (req.user?.role !== "root" && req.user?.organization_id !== id) {
      return reply.code(403).send(errorResponse("Unauthorized to modify this organization"));
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (city) updateData.city = city;
    if (address !== undefined) updateData.address = address;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (plan) updateData.plan = plan;
    if (maxClinics) updateData.maxClinics = maxClinics;
    if (maxDoctors) updateData.maxDoctors = maxDoctors;
    if (maxStaff) updateData.maxStaff = maxStaff;
    if (status) {
      updateData.status = status;
      updateData.isActive = status === "active";
    }

    const updatedOrg = await Organization.findByIdAndUpdate(id, updateData, { returnDocument: "after" }).lean();
    if (!updatedOrg) {
      return reply.code(404).send(errorResponse("Organization not found"));
    }

    return reply.send(successResponse({ ...updatedOrg, id: (updatedOrg as any)._id.toString() }, "Organization updated successfully"));
  } catch (err: any) {
    console.error("updateOrganizationById error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to update organization"));
  }
}

// ─── Delete Organization By ID (Cascading Chain Delete) ──────────────────
export async function deleteOrganizationById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (req.user?.role !== "root") {
      return reply.code(403).send(errorResponse("Only platform Root Admin can delete organizations"));
    }

    const org = await Organization.findById(id);
    if (!org) {
      return reply.code(404).send(errorResponse("Organization not found"));
    }

    // 1. Find all Clinics belonging to this Organization (checking both camelCase & snake_case)
    const clinics = await Clinic.find({
      $or: [{ organizationId: id }, { organization_id: id }]
    }).select("_id").lean();
    const clinicIds = clinics.map(c => c._id);

    // 2. Find all OrgMembers belonging to this Organization
    const members = await OrgMember.find({ organizationId: id }).select("userId").lean();
    const memberUserIds = members.map(m => m.userId);

    // 3. Cascading Deletion of Clinical & Operational Records Across All Modules
    await Promise.all([
      // Appointments & Encounters
      Appointment.deleteMany({ $or: [{ clinicId: { $in: clinicIds } }, { organizationId: id }] }),
      Encounter.deleteMany({ clinicId: { $in: clinicIds } }),

      // Pharmacy & Inventory
      Medicine.deleteMany({ clinicId: { $in: clinicIds } }),
      Prescription.deleteMany({ clinicId: { $in: clinicIds } }),

      // Laboratory & Diagnostics
      LabTest.deleteMany({ clinicId: { $in: clinicIds } }),
      LabOrder.deleteMany({ clinicId: { $in: clinicIds } }),

      // Billing & Invoices
      Invoice.deleteMany({ clinicId: { $in: clinicIds } }),

      // Multi-location Doctor Assignments & Staff Profiles
      DoctorAssignment.deleteMany({ organizationId: id }),
      Doctor.deleteMany({ organizationId: id }),
      Receptionist.deleteMany({ organizationId: id }),
      OrgMember.deleteMany({ organizationId: id }),
      PendingTwoFactorSetup.deleteMany({ userId: { $in: memberUserIds } }),
      OnboardingDraft.deleteMany({ organizationId: id }),

      // Commercial SaaS Subscriptions
      Subscription.deleteMany({ organizationId: id }),
      SubscriptionPayment.deleteMany({ organizationId: id }),

      // Clinics belonging to this organization
      Clinic.deleteMany({ $or: [{ organizationId: id }, { organization_id: id }] }),
    ]);

    // 4. Delete linked User accounts (Safely preserve Root Admin users)
    if (memberUserIds.length > 0) {
      await User.deleteMany({
        _id: { $in: memberUserIds },
        role: { $ne: "root" } // Safely preserve Root Super-Admin!
      });
      await RefreshToken.deleteMany({ userId: { $in: memberUserIds } });
    }

    // 5. Delete the Organization record itself
    await Organization.findByIdAndDelete(id);

    // 6. Self-healing cleanup: Delete any orphan clinics & subscriptions whose organization no longer exists
    const activeOrgs = await Organization.find().select("_id").lean();
    const activeOrgIds = activeOrgs.map((o) => o._id);
    await Promise.all([
      Clinic.deleteMany({ organizationId: { $nin: activeOrgIds } }),
      Subscription.deleteMany({ organizationId: { $nin: activeOrgIds } }),
    ]);

    return reply.send(successResponse({ id, name: org.name }, "Organization and all cascading clinic/staff/clinical resources cleanly deleted"));
  } catch (err: any) {
    console.error("deleteOrganizationById error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to delete organization"));
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

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    const emailCheck = await User.findOne({ email });
    if (emailCheck) return reply.code(409).send(errorResponse("Email already registered"));

    // Check SaaS Doctor Quota Limit
    const org = await Organization.findById(orgId);
    if (org && org.maxDoctors) {
      const existingDoctorsCount = await Doctor.countDocuments({ organizationId: orgId });
      if (existingDoctorsCount >= org.maxDoctors && req.user?.role !== "root") {
        return reply.code(403).send(errorResponse(`Doctor count quota limit of ${org.maxDoctors} reached for your ${org.plan?.toUpperCase() || "current"} plan. Upgrade subscription to add more doctors.`));
      }
    }

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
        registrationNumber: (req.body as any).registrationNumber?.trim() || null,
      }, session);

      await createWithSession(OrgMember, {
        userId: newDoctorUser._id,
        organizationId: orgId,
        role: "doctor",
      }, session);

      eventBus.publish({
        eventType: EVENT_TYPES.ORG_MEMBER_INVITED,
        category: "organization",
        targetUserId: newDoctorUser._id.toString(),
        title: "Joined Organization",
        message: `You have been added as a Doctor in Anant.`,
        severity: "info",
        organizationId: orgId,
      });

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

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    const emailCheck = await User.findOne({ email });
    if (emailCheck) return reply.code(409).send(errorResponse("Email already registered"));

    // Check SaaS Staff Quota Limit
    const org = await Organization.findById(orgId);
    if (org && org.maxStaff) {
      const existingStaffCount = await Receptionist.countDocuments({ organizationId: orgId });
      if (existingStaffCount >= org.maxStaff && req.user?.role !== "root") {
        return reply.code(403).send(errorResponse(`Staff quota limit of ${org.maxStaff} reached for your ${org.plan?.toUpperCase() || "current"} plan. Upgrade subscription to add more staff.`));
      }
    }

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

      eventBus.publish({
        eventType: EVENT_TYPES.ORG_MEMBER_INVITED,
        category: "organization",
        targetUserId: newRecUser._id.toString(),
        title: "Joined Organization",
        message: `You have been added as a Receptionist in Anant.`,
        severity: "info",
        organizationId: orgId,
      });

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
    let effectiveOrgId = req.user?.organization_id?.toString();

    const queryClinicId = (req.query as any)?.clinicId || (req.headers as any)["x-clinic-id"];
    const queryOrgId = (req.query as any)?.organizationId || (req.headers as any)["x-organization-id"];

    if (queryClinicId && mongoose.Types.ObjectId.isValid(queryClinicId)) {
      const clinic = await Clinic.findById(queryClinicId).select("organizationId").lean();
      if (clinic?.organizationId) {
        effectiveOrgId = clinic.organizationId.toString();
      }
    } else if (queryOrgId && mongoose.Types.ObjectId.isValid(queryOrgId)) {
      effectiveOrgId = queryOrgId;
    }

    const isRootWithoutOrg = req.user?.role === "root" && !effectiveOrgId;
    const orgFilter = effectiveOrgId ? { organizationId: effectiveOrgId } : isRootWithoutOrg ? {} : null;

    if (orgFilter === null) {
      return reply.code(200).send(successResponse({ doctors: [], receptionists: [], nurses: [], labTechs: [], pharmacists: [], cashiers: [], allStaff: [] }));
    }

    const doctors = await Doctor.find(orgFilter).populate("userId");
    const receptionists = await Receptionist.find(orgFilter)
      .populate("userId")
      .populate("clinicId", "name");

    const formattedDoctors = doctors
      .filter((d: any) => d.userId && d.userId.isActive)
      .map((d: any) => ({
        id: d.userId.id || d.userId._id?.toString(),
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
        id: r.userId.id || r.userId._id?.toString(),
        name: r.userId.name,
        email: r.userId.email,
        phone: r.userId.phone,
        shift: r.shift,
        clinicId: r.clinicId?.id || r.clinicId?._id?.toString() || r.clinicId || null,
        clinicName: r.clinicId?.name || null
      }));

    // Fetch all staff members from OrgMember for Nurse, Lab Tech, Pharmacist, Cashier & Custom Roles
    const orgMembers = await OrgMember.find(orgFilter).populate("userId").populate("organizationId", "name");
    const doctorUserIds = new Set(doctors.map((d: any) => d.userId?._id?.toString() || d.userId?.id?.toString()));
    const receptionistUserIds = new Set(receptionists.map((r: any) => r.userId?._id?.toString() || r.userId?.id?.toString()));

    const otherStaff = orgMembers
      .filter((m: any) => {
        if (!m.userId || !m.userId.isActive) return false;
        const uId = m.userId._id?.toString() || m.userId.id?.toString();
        if (doctorUserIds.has(uId) || receptionistUserIds.has(uId)) return false;
        return !["admin", "root", "patient"].includes(m.role);
      })
      .map((m: any) => ({
        id: m.userId.id || m.userId._id?.toString(),
        name: m.userId.name,
        email: m.userId.email,
        phone: m.userId.phone,
        role: m.role,
        organizationName: m.organizationId?.name || null
      }));

    const nurses = otherStaff.filter((s: any) => s.role === "nurse");
    const labTechs = otherStaff.filter((s: any) => s.role === "lab_tech");
    const pharmacists = otherStaff.filter((s: any) => s.role === "pharmacist");
    const cashiers = otherStaff.filter((s: any) => s.role === "cashier");

    return reply.code(200).send(successResponse({
      doctors: formattedDoctors,
      receptionists: formattedReceptionists,
      nurses,
      labTechs,
      pharmacists,
      cashiers,
      allStaff: [
        ...formattedDoctors.map((d: any) => ({ ...d, role: "doctor" })),
        ...formattedReceptionists.map((r: any) => ({ ...r, role: "receptionist" })),
        ...otherStaff
      ]
    }));
  } catch (err) {
    console.error("getOrgStaff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Step 2c: Admin adds Generic Staff (Nurse, Lab Tech, Pharmacist, Cashier) ─────────
export async function addStaff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { name, email, password, phone, role } = req.body as {
      name: string; email: string; password: string; phone?: string; role: string;
    };

    const BUILT_IN_ROLES = new Set(["doctor", "receptionist", "nurse", "lab_tech", "pharmacist", "cashier", "admin"]);
    const isBuiltIn = BUILT_IN_ROLES.has(role);
    const customRoleDoc = isBuiltIn ? null : await Role.findOne({ name: role }).select("_id").lean();

    if (!isBuiltIn && !customRoleDoc) {
      return reply.code(400).send(errorResponse(`Invalid role '${role}'. Role is not configured in organization RBAC system.`));
    }

    // Delegate to addDoctor if role === 'doctor'
    if (role === "doctor") return addDoctor(req, reply);
    // Delegate to addReceptionist if role === 'receptionist'
    if (role === "receptionist") return addReceptionist(req, reply);

    const cleanEmail = email.trim().toLowerCase();
    const emailCheck = await User.findOne({ email: cleanEmail });
    if (emailCheck) return reply.code(409).send(errorResponse("Email address is already registered across the platform. Multiple accounts with the same email are not permitted."));

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    return await withTransaction(async (session) => {
      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await createWithSession(User, {
        name,
        email: cleanEmail,
        password: hashedPassword,
        phone: phone || null,
        role,
      }, session);

      await createWithSession(OrgMember, {
        userId: newUser._id,
        organizationId: orgId,
        role,
      }, session);

      eventBus.publish({
        eventType: EVENT_TYPES.ORG_MEMBER_INVITED,
        category: "organization",
        targetUserId: newUser._id.toString(),
        title: "Joined Organization",
        message: `You have been added as a ${role.replace("_", " ").toUpperCase()} in Anant.`,
        severity: "info",
        organizationId: orgId,
      });

      return reply.code(201).send(
        successResponse({ id: newUser._id.toString(), name, email, role, organization_id: orgId }, `${role.replace("_", " ").toUpperCase()} registered successfully`)
      );
    });
  } catch (err) {
    console.error("addStaff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Invite Staff via Secure Email Link ─────────────────────────
export async function inviteStaff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { email, role } = req.body as { email: string; role: string };
    if (!email || !role) return reply.code(400).send(errorResponse("Email and role are required"));

    const userExists = await User.findOne({ email });
    if (userExists) return reply.code(409).send(errorResponse("User with this email is already registered"));

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    const { OrgInvite } = await import("../models/OrgInvite.ts");
    await OrgInvite.create({
      organizationId: orgId,
      email,
      role,
      tokenHash,
      invitedBy: req.user!.id,
      expiresAt,
    });

    const inviteUrl = `${getFrontendBaseUrl()}/accept-invite?token=${rawToken}`;
    const sent = await emailProvider.sendEmail({
      to: email,
      subject: "Invitation to join ANANT Healthcare Platform",
      text: `You have been invited to join ANANT as a ${role.toUpperCase()}. Click here to set up your account: ${inviteUrl}`,
      html: `<p>You have been invited to join ANANT as a <strong>${role.toUpperCase()}</strong>.</p><p><a href="${inviteUrl}">Click here to accept invitation</a> (valid for 48 hours).</p>`,
    });
    if (!sent) {
      await OrgInvite.deleteOne({ tokenHash });
      return reply.code(503).send(errorResponse("Invitation email delivery is unavailable; configure SMTP and try again"));
    }

    return reply.code(201).send(successResponse({ email, role, expiresAt }, "Invitation sent successfully"));
  } catch (err: any) {
    console.error("inviteStaff error:", err);
    return reply.code(500).send(errorResponse("Failed to send staff invitation"));
  }
}

// ─── Accept Staff Invitation ────────────────────────────────────
export async function acceptInvitation(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { token, name, password, phone } = req.body as { token: string; name: string; password: string; phone?: string };
    if (!token || !name || !password) {
      return reply.code(400).send(errorResponse("Token, name, and password are required"));
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { OrgInvite } = await import("../models/OrgInvite.ts");

    const invite = await OrgInvite.findOne({
      tokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return reply.code(400).send(errorResponse("Invalid or expired invitation token"));
    }

    return await withTransaction(async (session) => {
      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await createWithSession(User, {
        name,
        email: invite.email,
        password: hashedPassword,
        phone: phone || null,
        role: invite.role,
        isEmailVerified: true,
      }, session);

      await createWithSession(OrgMember, {
        userId: newUser._id,
        organizationId: invite.organizationId,
        role: invite.role,
      }, session);

      if (invite.role === "doctor") {
        await createWithSession(Doctor, {
          userId: newUser._id,
          organizationId: invite.organizationId,
        }, session);
      } else if (invite.role === "receptionist") {
        await createWithSession(Receptionist, {
          userId: newUser._id,
          organizationId: invite.organizationId,
        }, session);
      }

      invite.set("status", "accepted");
      await invite.save({ session: session || undefined });

      const roleConfig = await Role.findOne({ name: invite.role }).lean() as any;
      const permissions = roleConfig ? roleConfig.permissions : [];

      const payload = { id: newUser.id, email: newUser.email, role: invite.role, organization_id: invite.organizationId.toString() };
      const accessToken = generateAccessToken(payload);
      const refreshToken = await createRefreshToken(newUser.id);
      setAuthCookies(reply, accessToken, refreshToken);

      return reply.code(201).send(
        successResponse(
          { user: { id: newUser.id, name, email: newUser.email, role: invite.role, organization_id: invite.organizationId.toString(), permissions } },
          "Invitation accepted and account activated successfully"
        )
      );
    });
  } catch (err: any) {
    console.error("acceptInvitation error:", err);
    return reply.code(500).send(errorResponse("Failed to accept invitation"));
  }
}


// ─── Update Doctor ──────────────────────────────────────────────
export async function updateDoctor(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };
    const { 
      name, email, phone, specialization, qualification, experience_years,
      fees, timings, working_days, description, image_url 
    } = req.body as any;

    if (!name) return reply.code(400).send(errorResponse("name is required"));

    const doctor = await Doctor.findOne({ userId: id, organizationId: orgId });
    if (!doctor) return reply.code(404).send(errorResponse("Doctor not found or not in your organization"));

    if (email && email.trim()) {
      const cleanEmail = email.trim().toLowerCase();
      const existingWithEmail = await User.findOne({ email: cleanEmail, _id: { $ne: id } });
      if (existingWithEmail) {
        return reply.code(409).send(errorResponse("Email address is already in use by another user account."));
      }
      await User.updateOne({ _id: id }, { name, email: cleanEmail, phone: phone || null });
    } else {
      await User.updateOne({ _id: id }, { name, phone: phone || null });
    }

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
        image_url: image_url || null,
        registrationNumber: (req.body as any).registrationNumber !== undefined ? (req.body as any).registrationNumber?.trim() || null : (doctor as any).registrationNumber,
        isActive: (req.body as any).isActive !== undefined ? !!(req.body as any).isActive : (doctor as any).isActive,
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
    const { name, email, phone, shift, clinicId } = req.body as any;

    if (!name) return reply.code(400).send(errorResponse("name is required"));

    const receptionist = await Receptionist.findOne({ userId: id, organizationId: orgId });
    if (!receptionist) return reply.code(404).send(errorResponse("Receptionist not found or not in your organization"));

    if (email && email.trim()) {
      const cleanEmail = email.trim().toLowerCase();
      const existingWithEmail = await User.findOne({ email: cleanEmail, _id: { $ne: id } });
      if (existingWithEmail) {
        return reply.code(409).send(errorResponse("Email address is already in use by another user account."));
      }
      await User.updateOne({ _id: id }, { name, email: cleanEmail, phone: phone || null });
    } else {
      await User.updateOne({ _id: id }, { name, phone: phone || null });
    }

    await Receptionist.updateOne({ userId: id }, { shift: shift || null, clinicId: clinicId || null });

    return reply.code(200).send(successResponse(null, "Receptionist updated successfully"));
  } catch (err) {
    console.error("updateReceptionist error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Update Staff (Generic / Custom Role / Doctor / Receptionist) ────
export async function updateStaff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };
    const { 
      name, email, phone, specialization, qualification, experience_years,
      fees, timings, working_days, description, image_url, shift, clinicId 
    } = req.body as any;

    if (!name) return reply.code(400).send(errorResponse("Name is required"));

    const orgMember = await OrgMember.findOne({ userId: id, organizationId: orgId });
    if (!orgMember) return reply.code(404).send(errorResponse("Staff member not found in your organization"));

    if (email && email.trim()) {
      const cleanEmail = email.trim().toLowerCase();
      const existingWithEmail = await User.findOne({ email: cleanEmail, _id: { $ne: id } });
      if (existingWithEmail) {
        return reply.code(409).send(errorResponse("Email address is already in use by another user account."));
      }
      await User.updateOne({ _id: id }, { name, email: cleanEmail, phone: phone || null });
    } else {
      await User.updateOne({ _id: id }, { name, phone: phone || null });
    }

    // If doctor profile exists, update doctor details
    const doctor = await Doctor.findOne({ userId: id, organizationId: orgId });
    if (doctor) {
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
          image_url: image_url || null,
        }
      );
    }

    // If receptionist profile exists, update receptionist details
    const receptionist = await Receptionist.findOne({ userId: id, organizationId: orgId });
    if (receptionist) {
      await Receptionist.updateOne({ userId: id }, { shift: shift || null, clinicId: clinicId || null });
    }

    return reply.code(200).send(successResponse(null, "Staff member updated successfully"));
  } catch (err) {
    console.error("updateStaff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Enable Clinical Doctor Profile for Admin / Owner Account ──────────
export async function enableAdminDoctorProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { specialization, qualification, experience_years, fees, timings, working_days, description, registrationNumber } = req.body as any;

    if (!specialization) {
      return reply.code(400).send(errorResponse("Specialization is required (e.g. General Physician, Consultant)"));
    }

    const doctor = await Doctor.findOneAndUpdate(
      { userId: req.user!.id, organizationId: orgId },
      {
        organizationId: orgId,
        userId: req.user!.id,
        specialization: specialization.trim(),
        qualification: qualification?.trim() || "MD / MBBS",
        experience_years: experience_years ? Number(experience_years) : 5,
        fees: fees ? Number(fees) : 500,
        timings: timings || null,
        working_days: working_days || null,
        description: description || null,
        registrationNumber: registrationNumber?.trim() || null,
        isActive: true,
      },
      { upsert: true, returnDocument: "after" }
    );

    return reply.code(200).send(successResponse(doctor, "Clinical Doctor Profile linked to Admin Account successfully!"));
  } catch (err: any) {
    console.error("enableAdminDoctorProfile error:", err);
    return reply.code(500).send(errorResponse("Failed to link Doctor Profile to Admin Account"));
  }
}

// ─── Delete Staff ───────────────────────────────────────────────
export async function deleteStaff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    const verify = await OrgMember.findOne({ userId: id, organizationId: orgId });
    if (!verify) return reply.code(404).send(errorResponse("Staff not found in your organization"));

    if (id === req.user!.id) {
      return reply.code(400).send(errorResponse("Cannot deactivate your own active staff account"));
    }

    await User.updateOne({ _id: id }, { isActive: false });
    await Doctor.updateOne({ userId: id }, { isActive: false });
    await DoctorAssignment.updateMany({ doctorId: id }, { isActive: false });

    return reply.code(200).send(successResponse(null, "Staff member deactivated successfully"));
  } catch (err) {
    console.error("deleteStaff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Organization Settings ───────────────────────────────────────────────
export async function getOrganizationSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = await resolveTargetOrganizationId(req);
    if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
    const org = await Organization.findById(orgId);
    if (!org) return reply.code(404).send(errorResponse("Organization not found"));

    return reply.send(successResponse(org, "Organization fetched successfully"));
  } catch (error) {
    console.error("getOrganizationSettings error:", error);
    return reply.code(500).send(errorResponse("Failed to fetch organization settings"));
  }
}

export async function updateOrganizationSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = await resolveTargetOrganizationId(req);
    const {
      name, city, address, phone, email, description, image_url, timings, working_days
    } = req.body as any;

    if (!name || !city) {
      return reply.code(400).send(errorResponse("Name and city are required"));
    }

    if (!orgId) {
      return reply.code(403).send(errorResponse("Organization context is required"));
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
      { returnDocument: "after" }
    );

    return reply.send(successResponse(result, "Organization updated successfully"));
  } catch (error) {
    console.error("updateOrganizationSettings error:", error);
    return reply.code(500).send(errorResponse("Failed to update organization"));
  }
}

// ─── SMTP / Email Gateway Config ─────────────────────────────────
export async function getOrganizationSmtp(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = await resolveTargetOrganizationId(req);
    if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
    const org = await Organization.findById(orgId);

    if (!org) {
      return reply.send(successResponse({ smtp: null }, "No organization found"));
    }

    const smtp = (org as any).smtp || {};
    // Return config but mask the password (send back whether it's set, not the value)
    return reply.send(successResponse({
      host: smtp.host || "",
      port: smtp.port || 587,
      secure: smtp.secure || false,
      user: smtp.user || "",
      pass: smtp.pass ? "••••••••" : "", // masked
      passIsSet: !!smtp.pass,
      fromEmail: smtp.fromEmail || "",
      fromName: smtp.fromName || "",
    }, "SMTP config fetched"));
  } catch (error) {
    console.error("getOrganizationSmtp error:", error);
    return reply.code(500).send(errorResponse("Failed to fetch SMTP configuration"));
  }
}

export async function updateOrganizationSmtp(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = await resolveTargetOrganizationId(req);
    const { host, port, secure, user, pass, fromEmail, fromName } = req.body as any;

    if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));

    // Build the update — only overwrite password if a new non-masked value is provided
    const smtpUpdate: Record<string, any> = {
      "smtp.host": host || null,
      "smtp.port": port || 587,
      "smtp.secure": secure || false,
      "smtp.user": user || null,
      "smtp.fromEmail": fromEmail || null,
      "smtp.fromName": fromName || null,
    };

    // Only update password if user typed a real new value (not the masked placeholder)
    // Encrypt the password before storing in MongoDB (AES-256-GCM)
    if (pass && pass !== "••••••••" && !pass.startsWith("•")) {
      smtpUpdate["smtp.pass"] = encrypt(pass);
    }

    const result = await Organization.findByIdAndUpdate(
      orgId,
      { $set: smtpUpdate },
      { returnDocument: "after" }
    );

    return reply.send(successResponse({
      host: (result as any)?.smtp?.host || "",
      port: (result as any)?.smtp?.port || 587,
      secure: (result as any)?.smtp?.secure || false,
      user: (result as any)?.smtp?.user || "",
      pass: (result as any)?.smtp?.pass ? "••••••••" : "",
      passIsSet: !!((result as any)?.smtp?.pass),
      fromEmail: (result as any)?.smtp?.fromEmail || "",
      fromName: (result as any)?.smtp?.fromName || "",
    }, "SMTP configuration updated successfully"));
  } catch (error) {
    console.error("updateOrganizationSmtp error:", error);
    return reply.code(500).send(errorResponse("Failed to update SMTP configuration"));
  }
}

// ─── Draft Persistence Endpoints ─────────────────────────────────
export async function saveDraft(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { token, step, formData } = (req.body as any) || {};
    if (!token) return reply.code(400).send(errorResponse("Draft token is required"));

    const draft = await OnboardingDraft.findOneAndUpdate(
      { token },
      { step: step || 0, formData: formData || {}, updatedAt: new Date() },
      { upsert: true, returnDocument: "after" }
    );

    return reply.send(successResponse(draft, "Draft saved successfully"));
  } catch (err) {
    console.error("saveDraft error:", err);
    return reply.code(500).send(errorResponse("Failed to save onboarding draft"));
  }
}

export async function getDraft(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { token } = (req.query as any) || {};
    if (!token) return reply.code(400).send(errorResponse("Draft token is required"));

    const draft = await OnboardingDraft.findOne({ token }).lean();
    if (!draft) return reply.code(404).send(errorResponse("Draft not found"));

    return reply.send(successResponse(draft, "Draft retrieved successfully"));
  } catch (err) {
    console.error("getDraft error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch onboarding draft"));
  }
}

// ─── 2FA Google Authenticator OTP Onboarding Endpoints ──────────
export async function setupOnboardingTOTP(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const user = await User.findById(userId);
    if (!user) return reply.code(404).send(errorResponse("User not found"));

    // Generate fresh TOTP secret for Google Authenticator using TwoFactorService
    const { base32, otpauthUrl } = TwoFactorService.generateSecret(user.email || user.name || "user", "ANANTA");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes TTL

    await PendingTwoFactorSetup.deleteMany({ userId: user._id }); // Clear previous pending
    await PendingTwoFactorSetup.create({
      userId: user._id,
      secret: base32,
      expiresAt,
    });

    // Update Organization onboarding status
    if (req.user!.organization_id) {
      await Organization.findByIdAndUpdate(req.user!.organization_id, {
        onboardingStatus: "TWO_FACTOR_PENDING",
      });
    }

    return reply.send(
      successResponse(
        {
          secret: base32,
          expiresAt,
          devOtp: process.env.NODE_ENV === "development" ? "123456" : undefined,
        },
        "Google Authenticator 2FA setup initialized"
      )
    );
  } catch (err) {
    console.error("setupOnboardingTOTP error:", err);
    return reply.code(500).send(errorResponse("Failed to initialize 2FA Google Authenticator setup"));
  }
}

export async function verifyOnboardingTOTP(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const orgId = req.user!.organization_id;
    const { token, secret } = (req.body as any) || {};

    if (!token) {
      return reply.code(400).send(errorResponse("6-digit authenticator code is required"));
    }

    const cleanToken = token.toString().trim().replace(/\s+/g, "");

    // Look up pending 2FA setup record
    const pendingSetup = await PendingTwoFactorSetup.findOne({ userId });
    const activeSecret = secret || pendingSetup?.secret;
    if (!activeSecret) {
      return reply.code(400).send(errorResponse("No active 2FA secret found. Please scan the QR code first."));
    }

    // Verify token strictly using TwoFactorService
    const isValid = TwoFactorService.verifyToken(activeSecret, cleanToken);

    if (!isValid) {
      return reply.code(400).send(errorResponse("Invalid 6-digit Google Authenticator code. Please check your app."));
    }

    // 1. Mark User 2FA as enabled and save verified secret (encrypted at rest)
    await User.findByIdAndUpdate(userId, {
      twoFactorEnabled: true,
      twoFactorSecret: encrypt(activeSecret),
    });

    // 2. Delete temporary pending setup record
    await PendingTwoFactorSetup.deleteMany({ userId });

    // 3. Mark Organization onboardingStatus as COMPLETED and isOnboarded as true
    if (orgId) {
      await Organization.findByIdAndUpdate(orgId, {
        onboardingStatus: "COMPLETED",
        isOnboarded: true,
      });
    }

    // 4. Emit domain event ORG_CREATED
    eventBus.publish({
      eventType: EVENT_TYPES.ORG_CREATED,
      category: "organization",
      targetUserId: userId,
      title: "Organization Onboarding Complete",
      message: "ANANTA Workspace onboarding and 2FA Google Authenticator verification completed!",
      severity: "success",
      organizationId: orgId,
      actionUrl: "/dashboard",
    });

    return reply.send(
      successResponse(
        {
          twoFactorEnabled: true,
          isOnboarded: true,
          onboardingStatus: "COMPLETED",
        },
        "Google Authenticator 2FA code verified successfully! Organization authorized."
      )
    );
  } catch (err) {
    console.error("verifyOnboardingTOTP error:", err);
    return reply.code(500).send(errorResponse("Failed to verify 2FA authenticator token"));
  }
}

// ─── Department Management ───────────────────────────────────────
export async function createDepartment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("Organization ID required"));

    const { name, code, description, headDoctorId, clinicId } = req.body as {
      name: string; code: string; description?: string; headDoctorId?: string; clinicId?: string;
    };

    if (!name || !code) return reply.code(400).send(errorResponse("name and code are required"));

    const dept = await Department.create({
      organizationId: orgId,
      clinicId,
      name,
      code: code.toUpperCase(),
      description,
      headDoctorId,
    });

    return reply.code(201).send(successResponse(dept, "Department created successfully"));
  } catch (err: any) {
    if (err.code === 11000) return reply.code(409).send(errorResponse("Department code already exists in this organization"));
    console.error("createDepartment error:", err);
    return reply.code(500).send(errorResponse("Failed to create department"));
  }
}

export async function getDepartments(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId = req.user?.organization_id;
    const query = req.query as any;

    if (req.user?.role === "root" && query?.organizationId) {
      orgId = query.organizationId;
    }

    const filter: any = {};
    if (orgId) {
      filter.organizationId = orgId;
    }

    const departments = await Department.find(filter)
      .populate("headDoctorId", "name email specialization")
      .populate("clinicId", "name city")
      .sort({ name: 1 });

    return reply.code(200).send(successResponse(departments));
  } catch (err) {
    console.error("getDepartments error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch departments"));
  }
}
