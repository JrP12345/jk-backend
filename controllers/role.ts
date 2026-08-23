import type { FastifyRequest, FastifyReply } from "fastify";
import { Role } from "../models/Role.ts";
import { User } from "../models/User.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// Standard System Permissions Catalog with Human-Readable Labels & Categories
export const SYSTEM_PERMISSIONS_CATALOG = [
  { code: "VIEW_PATIENTS", name: "View Patient Directory", category: "Patient Management", description: "Search and inspect basic patient profiles" },
  { code: "MANAGE_PATIENTS", name: "Manage Patient Demographics", category: "Patient Management", description: "Create and edit patient master records" },
  { code: "VIEW_EHR", name: "View EHR & Medical Timeline", category: "Clinical Care", description: "Access longitudinal electronic health records and clinical history" },
  { code: "MANAGE_CLINICAL_NOTES", name: "Manage Clinical SOAP Notes", category: "Clinical Care", description: "Write, edit, and sign clinical consultation notes" },
  { code: "EVALUATE_NEWS2", name: "Record Vitals & NEWS2", category: "Clinical Care", description: "Record vitals signs and calculate early warning scores" },
  { code: "ORDER_LABS", name: "Order Laboratory Tests", category: "Diagnostics", description: "Order pathology and diagnostic laboratory panels" },
  { code: "RECORD_LAB_RESULTS", name: "Enter Lab Results", category: "Diagnostics", description: "Enter and verify laboratory test results" },
  // Compatibility codes already used by the encounter-order and legacy route guards.
  { code: "MANAGE_ORDERS", name: "Manage Diagnostic Orders", category: "Diagnostics", description: "Place, process, result, and cancel diagnostic orders" },
  { code: "MANAGE_LAB_TESTS", name: "Manage Laboratory Catalog", category: "Diagnostics", description: "Manage the laboratory test catalog" },
  { code: "ADMINISTER_MEDICATIONS", name: "Administer MAR Medications", category: "Inpatient & Nursing", description: "Record medication administration on MAR flowsheets" },
  { code: "ADMINISTER_MEDICATION", name: "Administer MAR Medications (Route Code)", category: "Inpatient & Nursing", description: "Use medication administration routes protected by the backend" },
  { code: "FINALIZING_DISCHARGE", name: "Process Inpatient Discharge", category: "Inpatient & Nursing", description: "Prepare and sign discharge summaries" },
  { code: "MANAGE_DISCHARGE_SUMMARY", name: "Manage Discharge Summary (Route Code)", category: "Inpatient & Nursing", description: "Compile, finalize, and countersign discharge summaries" },
  { code: "MANAGE_APPOINTMENTS", name: "Manage Appointments & Slots", category: "Front Desk & Operations", description: "Schedule, reschedule, and cancel appointments" },
  { code: "MANAGE_QUEUE", name: "Manage Patient Queue", category: "Front Desk & Operations", description: "Reorder queue and call patients to consultation rooms" },
  { code: "MANAGE_BILLING", name: "Manage Invoices & Payments", category: "Billing & Finance", description: "Create invoices, record payments, and process receipts" },
  { code: "MANAGE_STAFF", name: "Manage Staff Accounts", category: "Administration", description: "Create and update practitioner and staff profiles" },
  { code: "MANAGE_CLINICS", name: "Manage Clinic Branches", category: "Administration", description: "Configure clinic operating hours and facility locations" },
  { code: "MANAGE_ORGANIZATION", name: "Manage Organization Settings", category: "Administration", description: "Update organization metadata and SaaS billing" },
  { code: "VIEW_ANALYTICS", name: "View Executive BI Analytics", category: "Analytics & Governance", description: "Access business intelligence dashboards and reports" },
  { code: "VIEW_AUDIT_LOGS", name: "View System Audit Logs", category: "Analytics & Governance", description: "Inspect compliance audit trails and security logs" },
  { code: "ADMINISTRATIVE_GOVERNANCE", name: "Manage Roles & Permissions", category: "Analytics & Governance", description: "Create roles and configure permission matrices" },
];

const SYSTEM_PERMISSION_CODES = new Set(SYSTEM_PERMISSIONS_CATALOG.map((permission) => permission.code));
const BUILT_IN_ROLE_NAMES = new Set(["root", "admin", "doctor", "receptionist", "nurse", "lab_tech", "pharmacist", "cashier", "patient"]);

const DEFAULT_SYSTEM_ROLES = [
  {
    name: "admin",
    description: "Full organizational governance and system administration",
    permissions: SYSTEM_PERMISSIONS_CATALOG.map((p) => p.code),
    isSystemRole: true,
  },
  {
    name: "doctor",
    description: "Attending clinical practitioner with EHR, notes, orders, and MAR access",
    permissions: ["VIEW_PATIENTS", "VIEW_EHR", "MANAGE_CLINICAL_NOTES", "EVALUATE_NEWS2", "ORDER_LABS", "RECORD_LAB_RESULTS", "MANAGE_ORDERS", "MANAGE_LAB_TESTS", "ADMINISTER_MEDICATIONS", "ADMINISTER_MEDICATION", "FINALIZING_DISCHARGE", "MANAGE_DISCHARGE_SUMMARY"],
    isSystemRole: true,
  },
  {
    name: "receptionist",
    description: "Front desk staff handling intake, appointments, queue, and basic billing",
    permissions: ["VIEW_PATIENTS", "MANAGE_PATIENTS", "MANAGE_APPOINTMENTS", "MANAGE_QUEUE", "MANAGE_BILLING"],
    isSystemRole: true,
  },
  {
    name: "nurse",
    description: "Clinical nursing staff recording vitals, MAR administration, and patient care",
    permissions: ["VIEW_PATIENTS", "VIEW_EHR", "EVALUATE_NEWS2", "ADMINISTER_MEDICATIONS", "ADMINISTER_MEDICATION"],
    isSystemRole: true,
  },
  {
    name: "lab_tech",
    description: "Laboratory technician processing orders and entering diagnostic results",
    permissions: ["VIEW_PATIENTS", "ORDER_LABS", "RECORD_LAB_RESULTS", "MANAGE_ORDERS", "MANAGE_LAB_TESTS"],
    isSystemRole: true,
  },
  {
    name: "pharmacist",
    description: "Pharmacy dispenser managing prescriptions and medicine inventory",
    permissions: ["VIEW_PATIENTS", "ADMINISTER_MEDICATIONS", "ADMINISTER_MEDICATION"],
    isSystemRole: true,
  },
  {
    name: "cashier",
    description: "Billing desk cashier processing payments and issuing receipts",
    permissions: ["VIEW_PATIENTS", "MANAGE_BILLING"],
    isSystemRole: true,
  },
  {
    name: "patient",
    description: "Patient personal health record access",
    permissions: ["VIEW_EHR"],
    isSystemRole: true,
  },
];

export async function getRoles(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!req.user || !["admin", "root"].includes(req.user.role)) {
      return reply.code(403).send(errorResponse("Only administrators can view role configuration"));
    }
    // Seed any missing default system roles
    for (const sysRole of DEFAULT_SYSTEM_ROLES) {
      await Role.findOneAndUpdate(
        { name: sysRole.name },
        { $setOnInsert: sysRole },
        { upsert: true, new: true }
      );
    }

    const roles = await Role.find({}).sort({ isSystemRole: -1, name: 1 });
    const allCatalogCodes = SYSTEM_PERMISSIONS_CATALOG.map((p) => p.code);
    const sanitizedRoles = roles.map((r) => {
      if (r.name === "admin" || r.name === "root") {
        // Admin and Root system roles possess full entitlement across all catalog permissions by default
        const mergedPerms = Array.from(new Set([...allCatalogCodes, ...(r.permissions || [])]));
        return { ...r.toObject(), permissions: mergedPerms };
      }
      return r;
    });
    return reply.code(200).send(successResponse(sanitizedRoles));
  } catch (err) {
    console.error("getRoles error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPermissionCatalog(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!req.user || !["admin", "root"].includes(req.user.role)) {
      return reply.code(403).send(errorResponse("Only administrators can view permission configuration"));
    }
    return reply.code(200).send(successResponse(SYSTEM_PERMISSIONS_CATALOG));
  } catch (err) {
    console.error("getPermissionCatalog error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function createRole(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    if (userRole !== "admin" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only administrators can create roles"));
    }

    const { name, description, permissions } = req.body as {
      name: string;
      description?: string;
      permissions?: string[];
    };

    if (!name || !name.trim()) {
      return reply.code(400).send(errorResponse("Role name is required"));
    }

    const formattedName = name.trim().toLowerCase().replace(/\s+/g, "_");
    if (BUILT_IN_ROLE_NAMES.has(formattedName)) {
      return reply.code(400).send(errorResponse(`Role '${formattedName}' is reserved`));
    }
    if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((permission) => !SYSTEM_PERMISSION_CODES.has(permission)))) {
      return reply.code(400).send(errorResponse("Permissions must contain only catalog permission codes"));
    }

    const existing = await Role.findOne({ name: formattedName });
    if (existing) {
      return reply.code(400).send(errorResponse(`Role '${formattedName}' already exists`));
    }

    const role = await Role.create({
      name: formattedName,
      description: description || `Custom role: ${name}`,
      permissions: Array.isArray(permissions) ? permissions : [],
      isSystemRole: false,
    });

    return reply.code(201).send(successResponse(role, "Role created successfully"));
  } catch (err) {
    console.error("createRole error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

const MANDATORY_ADMIN_PERMISSIONS = new Set([
  "ADMINISTRATIVE_GOVERNANCE",
  "MANAGE_STAFF",
  "MANAGE_CLINICS",
  "MANAGE_ORGANIZATION",
  "MANAGE_BILLING",
  "VIEW_PATIENTS",
  "MANAGE_PATIENTS",
]);

export async function updateRolePermissions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    if (userRole !== "admin" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only administrators can update role permissions"));
    }

    const { name } = req.params as { name: string };
    if (name === "root" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only Root Super-Admin can modify permissions of the Root role"));
    }
    const { description, permissions } = req.body as {
      description?: string;
      permissions: string[];
    };

    if (!Array.isArray(permissions)) {
      return reply.code(400).send(errorResponse("Permissions must be an array of permission codes"));
    }
    if (permissions.some((permission) => !SYSTEM_PERMISSION_CODES.has(permission))) {
      return reply.code(400).send(errorResponse("Permissions must contain only catalog permission codes"));
    }

    // Protection: ADMIN and ROOT roles MUST retain mandatory core governance permissions
    let finalPermissions = [...permissions];
    if (name === "admin" || name === "root") {
      finalPermissions = Array.from(new Set([...finalPermissions, ...MANDATORY_ADMIN_PERMISSIONS]));
    }

    let role = await Role.findOne({ name });
    if (!role) {
      // If system role missing in DB, create it
      const defaultRole = DEFAULT_SYSTEM_ROLES.find((r) => r.name === name);
      if (defaultRole) {
        role = await Role.create({
          ...defaultRole,
          description: description || defaultRole.description,
          permissions: finalPermissions,
        });
      } else {
        return reply.code(404).send(errorResponse(`Role '${name}' not found`));
      }
    } else {
      if (description !== undefined) role.description = description;
      role.permissions = finalPermissions;
      await role.save();
    }

    return reply.code(200).send(successResponse(role, `Permissions updated for role '${name}'`));
  } catch (err) {
    console.error("updateRolePermissions error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteRole(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    if (userRole !== "admin" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only administrators can delete custom roles"));
    }

    const { name } = req.params as { name: string };
    const role = await Role.findOne({ name });

    if (!role) {
      return reply.code(404).send(errorResponse("Role not found"));
    }

    if (role.isSystemRole) {
      return reply.code(400).send(errorResponse(`System role '${name}' cannot be deleted`));
    }

    await Role.deleteOne({ _id: role._id });
    return reply.code(200).send(successResponse(null, `Role '${name}' deleted successfully`));
  } catch (err) {
    console.error("deleteRole error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateUserRole(req: FastifyRequest, reply: FastifyReply) {
  try {
    const requesterRole = req.user?.role;
    if (requesterRole !== "admin" && requesterRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only administrators can update user roles"));
    }

    const { id } = req.params as { id: string };
    const { role: newRole } = req.body as { role: string };

    if (!newRole) {
      return reply.code(400).send(errorResponse("Target role is required"));
    }
    if (newRole === "root" && requesterRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only Root Super-Admin can assign the Root role"));
    }
    if (!BUILT_IN_ROLE_NAMES.has(newRole)) {
      const configuredRole = await Role.findOne({ name: newRole }).select("_id").lean();
      if (!configuredRole) return reply.code(400).send(errorResponse("Target role is not configured"));
    }

    const user = await User.findById(id);
    if (!user) {
      return reply.code(404).send(errorResponse("User not found"));
    }
    if (user.role === "root" && requesterRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: Only Root Super-Admin can modify accounts with the Root role"));
    }

    user.role = newRole;
    await user.save();

    return reply.code(200).send(successResponse(user, `User '${user.name}' assigned role '${newRole}' successfully`));
  } catch (err) {
    console.error("updateUserRole error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
