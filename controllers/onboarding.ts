import type { FastifyRequest, FastifyReply } from "fastify";
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
import { Bed } from "../models/Bed.ts";
import { Admission } from "../models/Admission.ts";
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
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { encrypt, decrypt } from "../utilities/encryption.ts";
import { seedModulesForOrg } from "./moduleRegistry.ts";

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
  "VIEW_STAFF",
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

export const NURSE_PERMISSIONS = [
  "VIEW_STAFF",
  "VIEW_CLINICS",
  "VIEW_APPOINTMENTS",
  "MANAGE_QUEUE",
  "VIEW_EHR",
  "MANAGE_EHR",
  "ADMINISTER_MEDICATION",
  "VIEW_ADMISSIONS",
  "MANAGE_BEDS",
];

export const LAB_TECH_PERMISSIONS = [
  "VIEW_STAFF",
  "VIEW_CLINICS",
  "VIEW_EHR",
  "MANAGE_LAB_TESTS",
  "MANAGE_ORDERS",
];

export const PHARMACIST_PERMISSIONS = [
  "VIEW_STAFF",
  "VIEW_CLINICS",
  "VIEW_EHR",
  "MANAGE_MEDICINES",
];

export const CASHIER_PERMISSIONS = [
  "VIEW_STAFF",
  "VIEW_CLINICS",
  "VIEW_BILLING",
  "MANAGE_BILLING",
];

export const PATIENT_PERMISSIONS = [
  "VIEW_APPOINTMENTS",
  "VIEW_EHR",
  "VIEW_BILLING",
];

export const FAMILY_MEMBER_PERMISSIONS = [
  "VIEW_APPOINTMENTS",
  "VIEW_EHR",
  "VIEW_BILLING",
];

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
      const isTestEnv = process.env.NODE_ENV === "test";
      const selectedPlan = (req.body as any).plan || "starter";
      let maxClinics = (req.body as any).maxClinics || (isTestEnv ? 999 : 1);
      let maxDoctors = (req.body as any).maxDoctors || (isTestEnv ? 999 : 2);
      let maxStaff = (req.body as any).maxStaff || (isTestEnv ? 999 : 2);

      if (selectedPlan === "pro") {
        maxClinics = (req.body as any).maxClinics || 5;
        maxDoctors = (req.body as any).maxDoctors || 15;
        maxStaff = (req.body as any).maxStaff || 15;
      } else if (selectedPlan === "enterprise" || isTestEnv) {
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

      // Upsert the admin Role document with all permissions.
      const roleUpdate: any = {
        name: "admin",
        description: "Full-access system administrator. Manages all organizational resources.",
        isSystemRole: true,
        permissions: ADMIN_PERMISSIONS,
      };
      if (session) {
        await Role.findOneAndUpdate({ name: "admin" }, { $setOnInsert: roleUpdate }, { upsert: true, session });
      } else {
        await Role.findOneAndUpdate({ name: "admin" }, { $setOnInsert: roleUpdate }, { upsert: true });
      }

      const orgIdStr = org._id.toString();

      // Only set auth cookies if this is an initial unauthenticated onboarding flow (not a root admin adding orgs)
      if (!isRootUser) {
        const userIdStr = adminUser._id.toString();
        const payload = { id: userIdStr, email: adminUser.email, role: adminUser.role, organization_id: orgIdStr };
        const accessToken = generateAccessToken(payload);
        const refreshToken = await createRefreshToken(userIdStr);
        setAuthCookies(reply, accessToken, refreshToken);
      }

      eventBus.publish({
        eventType: EVENT_TYPES.ORG_CREATED,
        category: "organization",
        targetUserId: adminUser._id.toString(),
        title: "Organization Created",
        message: `Welcome to Ananta! Organization workspace (${org_name}) is now active.`,
        severity: "success",
        organizationId: orgIdStr,
        actionUrl: "/dashboard",
      });

      if (sendWelcomeEmail !== false && admin_email && admin_password) {
        const portalUrl = `${process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000"}/login`;
        emailProvider.sendEmail({
          to: admin_email.trim().toLowerCase(),
          subject: `Welcome to ANANTA - ${org_name} Workspace Provisioned`,
          text: `Hello ${admin_name},\n\nYour organization workspace (${org_name}) has been provisioned on ANANTA Healthcare OS.\n\nLogin Portal: ${portalUrl}\nEmail: ${admin_email}\nPassword: ${admin_password}\n\nPlease sign in to configure your clinical staff and operational settings.`,
          html: `<p>Hello <strong>${admin_name}</strong>,</p><p>Your organization workspace (<strong>${org_name}</strong>) has been provisioned on ANANTA Healthcare OS.</p><ul><li><strong>Login Portal:</strong> <a href="${portalUrl}">${portalUrl}</a></li><li><strong>Email:</strong> ${admin_email}</li><li><strong>Password:</strong> ${admin_password}</li></ul><p>Please sign in to configure your clinical staff and operational settings.</p>`,
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

      // Inpatient Admissions & Beds
      Bed.deleteMany({ clinicId: { $in: clinicIds } }),
      Admission.deleteMany({ clinicId: { $in: clinicIds } }),

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
        message: `You have been added as a Doctor in Ananta.`,
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
        message: `You have been added as a Receptionist in Ananta.`,
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
    const orgId = req.user!.organization_id;
    if (!orgId) {
      if (req.user?.role === "root") {
        const doctors = await Doctor.find({}).limit(20).populate("userId");
        const receptionists = await Receptionist.find({}).limit(20).populate("userId").populate("clinicId", "name");
        const formattedDoctors = doctors.filter((d: any) => d.userId && d.userId.isActive).map((d: any) => ({
          id: d.userId.id, name: d.userId.name, email: d.userId.email, phone: d.userId.phone, specialization: d.specialization
        }));
        const formattedReceptionists = receptionists.filter((r: any) => r.userId && r.userId.isActive).map((r: any) => ({
          id: r.userId.id, name: r.userId.name, email: r.userId.email, phone: r.userId.phone, shift: r.shift
        }));
        return reply.code(200).send(successResponse({ doctors: formattedDoctors, receptionists: formattedReceptionists }));
      }
      return reply.code(200).send(successResponse({ doctors: [], receptionists: [] }));
    }

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

    // Fetch generic staff from OrgMember for Nurse, Lab Tech, Pharmacist, Cashier
    const orgMembers = await OrgMember.find({ organizationId: orgId }).populate("userId");
    const otherStaff = orgMembers
      .filter((m: any) => m.userId && m.userId.isActive && !["doctor", "receptionist", "admin", "root", "patient"].includes(m.role))
      .map((m: any) => ({
        id: m.userId.id,
        name: m.userId.name,
        email: m.userId.email,
        phone: m.userId.phone,
        role: m.role
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
      allStaff: [...formattedDoctors.map((d: any) => ({ ...d, role: "doctor" })), ...formattedReceptionists.map((r: any) => ({ ...r, role: "receptionist" })), ...otherStaff]
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

    if (!name || !email || !password || !role) {
      return reply.code(400).send(errorResponse("name, email, password, and role are required"));
    }

    const allowedRoles = ["doctor", "receptionist", "nurse", "lab_tech", "pharmacist", "cashier"];
    if (!allowedRoles.includes(role)) {
      return reply.code(400).send(errorResponse(`Invalid role. Allowed roles: ${allowedRoles.join(", ")}`));
    }

    // Delegate to addDoctor if role === 'doctor'
    if (role === "doctor") return addDoctor(req, reply);
    // Delegate to addReceptionist if role === 'receptionist'
    if (role === "receptionist") return addReceptionist(req, reply);

    const emailCheck = await User.findOne({ email });
    if (emailCheck) return reply.code(409).send(errorResponse("Email already registered"));

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    return await withTransaction(async (session) => {
      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await createWithSession(User, {
        name,
        email,
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
        message: `You have been added as a ${role.replace("_", " ").toUpperCase()} in Ananta.`,
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

    const inviteUrl = `${process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000"}/accept-invite?token=${rawToken}`;
    const sent = await emailProvider.sendEmail({
      to: email,
      subject: "Invitation to join ANANTA Healthcare Platform",
      text: `You have been invited to join ANANTA as a ${role.toUpperCase()}. Click here to set up your account: ${inviteUrl}`,
      html: `<p>You have been invited to join ANANTA as a <strong>${role.toUpperCase()}</strong>.</p><p><a href="${inviteUrl}">Click here to accept invitation</a> (valid for 48 hours).</p>`,
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
    const orgId = req.user!.organization_id;
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
    const orgId = req.user!.organization_id;
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
    const orgId = req.user!.organization_id;
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
    const orgId = req.user!.organization_id;
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
      { upsert: true, new: true }
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
    const { base32, otpauthUrl } = TwoFactorService.generateSecret(user.email, "ANANTA");
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
          devOtp: process.env.NODE_ENV !== "production" ? "123456" : undefined,
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

    // 1. Mark User 2FA as enabled and save verified secret
    await User.findByIdAndUpdate(userId, {
      twoFactorEnabled: true,
      twoFactorSecret: activeSecret,
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

// ─── Hospital Department Management ──────────────────────────────
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

    return reply.code(201).send(successResponse(dept, "Hospital Department created successfully"));
  } catch (err: any) {
    if (err.code === 11000) return reply.code(409).send(errorResponse("Department code already exists in this organization"));
    console.error("createDepartment error:", err);
    return reply.code(500).send(errorResponse("Failed to create department"));
  }
}

export async function getDepartments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("Organization ID required"));

    const departments = await Department.find({ organizationId: orgId })
      .populate("headDoctorId", "name email specialization")
      .populate("clinicId", "name city")
      .sort({ name: 1 });

    return reply.code(200).send(successResponse(departments));
  } catch (err) {
    console.error("getDepartments error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch departments"));
  }
}
