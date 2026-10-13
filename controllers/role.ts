import type { FastifyRequest, FastifyReply } from "fastify";
import { Role } from "../models/Role.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, revokeAllRefreshTokens } from "../utilities/helpers.ts";
import { invalidateRoleCache, BUILTIN_ROLE_PERMISSIONS, getEffectivePermissions } from "../utilities/permissions.ts";
import { CRM_PERMISSION_CATALOG } from "../utilities/crmPermissions.ts";
import { isRootRequest, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { broadcastRealtimeNotification } from "../notifications/websocket.ts";
import { withTransaction } from '../utilities/transaction.ts';
import { handoffCrmPermissionLoss } from '../services/CrmRevocationService.ts';
import { assertOtherActiveAdministrator } from '../services/OrganizationGovernanceService.ts';
import { RefreshToken } from '../models/RefreshToken.ts';
import { revokeSession } from '../utilities/sessionResolver.ts';
import { CommandError } from '../services/CommandReceiptService.ts';
import { pinAssignableRole } from '../services/RoleAssignmentService.ts';

// Standard System Permissions Catalog with Human-Readable Labels & Categories
export const SYSTEM_PERMISSIONS_CATALOG = [
  ...CRM_PERMISSION_CATALOG,
  { code: "VIEW_APPOINTMENTS", name: "View appointments", category: "Front Desk & Operations", description: "View permitted appointment information" },
  { code: "VIEW_BILLING", name: "View billing", category: "Billing & Finance", description: "View permitted billing information" },
  { code: "VIEW_STAFF", name: "View staff", category: "Administration", description: "View the permitted staff directory" },
  { code: "VIEW_LOCATIONS", name: "View locations", category: "Administration", description: "View permitted locations" },
  { code: "MANAGE_EHR", name: "Manage EHR", category: "Clinical Care", description: "Manage authorized clinical records" },
  { code: "MANAGE_BEDS", name: "Manage beds", category: "Inpatient & Nursing", description: "Manage permitted bed operations" },
  { code: "MANAGE_ADMISSIONS", name: "Manage admissions", category: "Inpatient & Nursing", description: "Manage permitted admissions" },
  { code: "VIEW_ADMISSIONS", name: "View admissions", category: "Inpatient & Nursing", description: "Read permitted admissions" },
  { code: "MANAGE_MEDICINES", name: "Manage medicines", category: "Pharmacy", description: "Manage authorized pharmacy inventory" },
  { code: "VIEW_PATIENTS", name: "View Patient Directory", category: "Patient Management", description: "Search and inspect basic patient profiles" },
  { code: "MANAGE_PATIENTS", name: "Manage Patient Demographics", category: "Patient Management", description: "Create and edit patient master records" },
  { code: "VIEW_EHR", name: "View EHR & Medical Timeline", category: "Clinical Care", description: "Access longitudinal electronic health records and clinical history" },
  { code: "MANAGE_CLINICAL_NOTES", name: "Manage Clinical SOAP Notes", category: "Clinical Care", description: "Write, edit, and sign clinical consultation notes" },
  { code: "EVALUATE_NEWS2", name: "Record Vitals & NEWS2", category: "Clinical Care", description: "Record vitals signs and calculate early warning scores" },
  { code: "ORDER_LABS", name: "Order Laboratory Tests", category: "Diagnostics", description: "Order pathology and diagnostic laboratory panels" },
  { code: "RECORD_LAB_RESULTS", name: "Enter Lab Results", category: "Diagnostics", description: "Enter and verify laboratory test results" },
  // Standard codes mapped to encounter orders and route guards.
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
  { code: "MANAGE_LOCATIONS", name: "Manage Locations", category: "Administration", description: "Configure location operating hours and facility locations" },
  { code: "MANAGE_ORGANIZATION", name: "Manage Organization Settings", category: "Administration", description: "Update organization metadata and SaaS billing" },
  { code: "VIEW_ANALYTICS", name: "View Executive BI Analytics", category: "Analytics & Governance", description: "Access business intelligence dashboards and reports" },
  { code: "VIEW_AUDIT_LOGS", name: "View System Audit Logs", category: "Analytics & Governance", description: "Inspect compliance audit trails and security logs" },
  { code: "ADMINISTRATIVE_GOVERNANCE", name: "Manage Roles & Permissions", category: "Analytics & Governance", description: "Create roles and configure permission matrices" },
];

const SYSTEM_PERMISSION_CODES = new Set(SYSTEM_PERMISSIONS_CATALOG.map((permission) => permission.code));
const BUILT_IN_ROLE_NAMES = new Set(["root", ...Object.keys(BUILTIN_ROLE_PERMISSIONS)]);

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
].map(role => ({ ...role, permissions: BUILTIN_ROLE_PERMISSIONS[role.name] || [] }));
for (const name of ["location_manager", "family_member"]) DEFAULT_SYSTEM_ROLES.push({ name,
  description: name.replaceAll("_", " "), permissions: BUILTIN_ROLE_PERMISSIONS[name], isSystemRole: true });

export async function getRoles(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!req.user || !["admin", "root"].includes(req.user.role)) {
      return reply.code(403).send(errorResponse("Only administrators can view role configuration"));
    }
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    // Seed any missing default system roles
    for (const sysRole of DEFAULT_SYSTEM_ROLES) {
      await Role.findOneAndUpdate(
        { name: sysRole.name, organizationId: null },
        { $setOnInsert: { ...sysRole, permissions: BUILTIN_ROLE_PERMISSIONS[sysRole.name] || sysRole.permissions, organizationId: null } },
        { upsert: true, returnDocument: "after" }
      );
    }

    const orgId = scope.organizationId;
    const roleQuery = req.user?.role === "root" && !orgId
      ? {}
      : { $or: [{ organizationId: orgId }, { organizationId: null }] };
    const roles = await Role.find(roleQuery).sort({ isSystemRole: -1, name: 1 });
    const effectiveRoles = orgId
      ? Array.from(roles.reduce((result, role) => {
          if (!result.has(role.name) || role.organizationId) result.set(role.name, role);
          return result;
        }, new Map<string, (typeof roles)[number]>()).values())
      : roles;
    return reply.code(200).send(successResponse(effectiveRoles));
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

    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const existing = await Role.findOne({
      name: formattedName,
      $or: [{ organizationId: orgId || null }, { organizationId: null }]
    });
    if (existing) {
      return reply.code(400).send(errorResponse(`Role '${formattedName}' already exists`));
    }

    const role = await Role.create({
      name: formattedName,
      organizationId: orgId || null,
      description: description || `Custom role: ${name}`,
      permissions: Array.isArray(permissions) ? permissions : [],
      isSystemRole: false,
    });
    await invalidateRoleCache(formattedName, orgId);

    return reply.code(201).send(successResponse(role, "Role created successfully"));
  } catch (err) {
    console.error("createRole error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

const MANDATORY_ADMIN_PERMISSIONS = new Set([
  "ADMINISTRATIVE_GOVERNANCE",
  "MANAGE_STAFF",
  "MANAGE_LOCATIONS",
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

    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const role = await withTransaction(async () => {
      if (!orgId && await OrgMember.exists({ role: name })) {
        throw new CommandError(409, 'Select an organization before changing a staff role permission set');
      }
      let role = await Role.findOne({ name, organizationId: orgId || null });
    if (!role) {
      // Tenant edits create an override rather than changing the shared role.
      const globalRole = orgId ? await Role.findOne({ name, organizationId: null }).lean() : null;
      const defaultRole = globalRole || DEFAULT_SYSTEM_ROLES.find((r) => r.name === name);
      if (defaultRole) {
        role = await Role.create({
          name,
          organizationId: orgId || null,
          isSystemRole: defaultRole.isSystemRole,
          description: description || defaultRole.description,
          permissions: finalPermissions,
        });
      } else {
        throw new CommandError(404, "Role is not configured");
      }
    } else {
      if (description !== undefined) role.description = description;
      role.permissions = finalPermissions;
      (role as any).version = ((role as any).version || 1) + 1;
      await role.save();
    }


      const members = orgId ? await OrgMember.find({ organizationId: orgId, role: name }).select('userId').limit(1001).lean() : [];
      if (members.length > 1000) throw new Error('This role change requires a staged organization review');
      const crmHandoff = { inquiries: 0, tasks: 0, relationships: 0 };
      for (const member of members) {
        const counts = await handoffCrmPermissionLoss(orgId!, String(member.userId), new Set(finalPermissions));
        crmHandoff.inquiries += counts.inquiries; crmHandoff.tasks += counts.tasks; crmHandoff.relationships += counts.relationships;
      }
      await AuditLog.create({ userId: req.user!.id, organizationId: orgId || null, action: 'ROLE_PERMISSIONS_CHANGED', targetId: role!._id, targetModel: 'Role', category: 'ADMIN', details: { roleName: name, crmHandoff } });
      return role;
    });

    await invalidateRoleCache(name, orgId);
    return reply.code(200).send(successResponse(role, `Permissions updated for role '${name}'`));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
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
    if (BUILT_IN_ROLE_NAMES.has(name)) {
      return reply.code(400).send(errorResponse(`System role '${name}' cannot be deleted`));
    }
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const role = await Role.findOne({ name, organizationId: scope.organizationId || null });

    if (!role) {
      return reply.code(404).send(errorResponse("Role not found"));
    }

    if (role.isSystemRole) {
      return reply.code(400).send(errorResponse(`System role '${name}' cannot be deleted`));
    }

    await withTransaction(async () => {
      const current = await Role.findOneAndUpdate({ _id: role._id, isSystemRole: false },
        { $inc: { assignmentRevision: 1 } }, { returnDocument: 'after' });
      if (!current) throw new CommandError(409, 'Role changed; reload before deleting');
      const organizationId = scope.organizationId;
      if (await OrgMember.exists({ role: name, ...(organizationId ? { organizationId } : {}) }) ||
          (!organizationId && await User.exists({ role: name }))) {
        throw new CommandError(409, 'Reassign staff before deleting an assigned role');
      }
      await Role.deleteOne({ _id: current._id });
      await AuditLog.create({ userId: req.user!.id, organizationId: organizationId || null,
        action: 'ROLE_DELETED', targetId: current._id, targetModel: 'Role', category: 'ADMIN', details: { roleName: name } });
    });
    await invalidateRoleCache(name, scope.organizationId);
    return reply.code(200).send(successResponse(null, `Role '${name}' deleted successfully`));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const requesterOrgId = scope.organizationId;
    const isRoot = isRootRequest(req);

    if (!newRole) {
      return reply.code(400).send(errorResponse("Target role is required"));
    }
    if (newRole === "root" && !isRoot) {
      return reply.code(403).send(errorResponse("Forbidden: Only Root Super-Admin can assign the Root role"));
    }

    // Validate role is either a built-in system role or custom role belonging to this org
    if (!BUILT_IN_ROLE_NAMES.has(newRole)) {
      const roleFilter: any = { name: newRole };
      if (requesterOrgId) {
        roleFilter.$or = [{ organizationId: requesterOrgId }, { organizationId: null }];
      }
      const configuredRole = await Role.findOne(roleFilter).select("_id").lean();
      if (!configuredRole) return reply.code(400).send(errorResponse("Target role is not configured for your organization"));
    }

    // Tenant isolation: verify target user belongs to requester's organization (unless root)
    if (!isRoot || requesterOrgId) {
      if (!requesterOrgId) {
        return reply.code(403).send(errorResponse("Organization context is required to assign roles"));
      }
      const membership = await OrgMember.findOne({ userId: id, organizationId: requesterOrgId });
      if (!membership) {
        return reply.code(404).send(errorResponse("User not found in your organization"));
      }
    }

    const user = await User.findById(id);
    if (!user) {
      return reply.code(404).send(errorResponse("User not found"));
    }
    if (user.role === "root" && !isRoot) {
      return reply.code(403).send(errorResponse("Forbidden: Only Root Super-Admin can modify accounts with the Root role"));
    }
    if (requesterOrgId && (newRole === "root" || user.role === "root")) return reply.code(403).send(errorResponse("Root identities are managed at platform level"));
    if (id === req.user!.id && newRole !== req.user!.role) return reply.code(400).send(errorResponse("Cannot change your own active role"));
    let previousRole = user.role;
    let auditTargetId = user._id;
    let sessions: { _id: unknown }[] = [];
    await withTransaction(async () => {
      await pinAssignableRole(newRole, requesterOrgId);
      let crmHandoff;
      if (requesterOrgId) {
        const member = await OrgMember.findOne({ userId: id, organizationId: requesterOrgId });
        if (!member) throw new CommandError(404, 'User not found in your organization');
        previousRole = member.role;
        auditTargetId = member._id;
        if (member.role === 'admin' && newRole !== 'admin') await assertOtherActiveAdministrator(requesterOrgId, id);
        const changed = await OrgMember.updateOne({ _id: member._id, organizationId: requesterOrgId, role: member.role, ...((member.accessRevision || 0) === 0 ? { $or: [{ accessRevision: 0 }, { accessRevision: { $exists: false } }] } : { accessRevision: member.accessRevision }) }, { $set: { role: newRole }, $inc: { accessRevision: 1 } });
        if (changed.modifiedCount !== 1) throw new CommandError(409, 'Membership changed; reload before saving');
        crmHandoff = await handoffCrmPermissionLoss(requesterOrgId, id, await getEffectivePermissions(newRole, requesterOrgId, 1, true));
        sessions = await RefreshToken.find({ userId: id, organizationId: requesterOrgId, revoked: false }).select('_id').lean();
        await RefreshToken.updateMany({ userId: id, organizationId: requesterOrgId, revoked: false }, { $set: { revoked: true, revocationReason: 'terminated' } });
      } else {
        if (await OrgMember.exists({ userId: id })) throw new CommandError(409, 'Select an organization before changing a staff membership role');
        user.role = newRole;
        user.authVersion = (user.authVersion || 1) + 1;
        await user.save();
      }
      await AuditLog.create({ userId: req.user!.id, organizationId: requesterOrgId || null, action: 'ROLE_ASSIGNED', targetId: auditTargetId, targetModel: requesterOrgId ? 'OrgMember' : 'User', category: 'ADMIN', ipAddress: req.ip, userAgent: req.headers['user-agent'], details: { previousRole, newRole, targetUserId: id, crmHandoff } });
    });
    if (requesterOrgId) for (const session of sessions) await revokeSession(String(session._id), 'terminated');
    else await revokeAllRefreshTokens(id);
    broadcastRealtimeNotification(id, { type: 'NOTIFICATION_RECEIVED', message: 'Your workspace role changed. Sign in to that workspace again.', data: { newRole, previousRole, organizationId: requesterOrgId } });
    return reply.code(200).send(successResponse({ id: user.id, name: user.name, role: newRole, organizationId: requesterOrgId || null }, `Role updated successfully`));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("updateUserRole error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
