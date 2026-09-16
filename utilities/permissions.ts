import type { FastifyRequest } from "fastify";
import { Role } from "../models/Role.ts";

export const ADMIN_PERMISSIONS = [
  "MANAGE_STAFF",
  "VIEW_STAFF",
  "MANAGE_CLINICS",
  "VIEW_CLINICS",
  "MANAGE_ORGANIZATION",
  "MANAGE_BEDS",
  "MANAGE_ADMISSIONS",
  "VIEW_ADMISSIONS",
  "MANAGE_MEDICINES",
  "MANAGE_LAB_TESTS",
  "MANAGE_BILLING",
  "VIEW_BILLING",
  "MANAGE_APPOINTMENTS",
  "VIEW_APPOINTMENTS",
  "VIEW_ANALYTICS",
  "MANAGE_QUEUE",
  "VIEW_EHR",
  "MANAGE_EHR",
  "MANAGE_CLINICAL_NOTES",
  "ADMINISTER_MEDICATION",
  "MANAGE_ORDERS",
  "MANAGE_DISCHARGE_SUMMARY",
  "VIEW_ANALYTICS",
];

export const DOCTOR_PERMISSIONS = [
  "VIEW_CLINICS",
  "VIEW_PATIENTS",
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
  "VIEW_PATIENTS",
  "MANAGE_PATIENTS",
  "MANAGE_APPOINTMENTS",
  "VIEW_APPOINTMENTS",
  "MANAGE_QUEUE",
  "VIEW_BILLING",
  "MANAGE_BILLING",
  "VIEW_ADMISSIONS",
  "MANAGE_ADMISSIONS",
  "MANAGE_BEDS",
  "MANAGE_ORDERS",
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
  "VIEW_PATIENTS",
  "VIEW_EHR",
  "MANAGE_MEDICINES",
];

export const CASHIER_PERMISSIONS = [
  "VIEW_STAFF",
  "VIEW_CLINICS",
  "VIEW_PATIENTS",
  "VIEW_BILLING",
  "MANAGE_BILLING",
];

export const CLINIC_MANAGER_PERMISSIONS = [
  "VIEW_PATIENTS",
  "MANAGE_PATIENTS",
  "VIEW_APPOINTMENTS",
  "MANAGE_APPOINTMENTS",
  "MANAGE_QUEUE",
  "VIEW_CLINICS",
  "VIEW_BILLING",
  "MANAGE_BILLING",
  "MANAGE_MEDICINES",
  "VIEW_EHR",
  "MANAGE_ORDERS",
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

/** Shared permission sets for CE authorization checks. */
export const BILLING_STAFF_PAYMENT_PERMISSIONS = ["MANAGE_BILLING", "MANAGE_APPOINTMENTS"] as const;

/** Canonical fallback permissions when a Role document is missing or incomplete. */
export const BUILTIN_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ADMIN_PERMISSIONS,
  doctor: DOCTOR_PERMISSIONS,
  receptionist: RECEPTIONIST_PERMISSIONS,
  nurse: NURSE_PERMISSIONS,
  lab_tech: LAB_TECH_PERMISSIONS,
  pharmacist: PHARMACIST_PERMISSIONS,
  cashier: CASHIER_PERMISSIONS,
  clinic_manager: CLINIC_MANAGER_PERMISSIONS,
  patient: PATIENT_PERMISSIONS,
  family_member: FAMILY_MEMBER_PERMISSIONS,
};

export function isPrivilegedRole(role: string | undefined): boolean {
  return role === "root" || role === "admin";
}

interface RoleCacheEntry {
  permissions: string[];
  expiresAt: number;
}

const rolePermissionsCache = new Map<string, RoleCacheEntry>();
const ROLE_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 60 * 1000; // 0 in tests, 60s in production

/** Invalidate cached permissions for one or all roles upon mutation */
export function invalidateRoleCache(roleName?: string) {
  if (roleName) {
    rolePermissionsCache.delete(roleName);
  } else {
    rolePermissionsCache.clear();
  }
}
(globalThis as any).__invalidateRoleCache = invalidateRoleCache;

/** Merge JWT, DB role, and built-in permissions for a caller (cached). */
export async function getEffectivePermissions(
  role: string,
  jwtPermissions: string[] = [],
): Promise<Set<string>> {
  let rolePermissions: string[] = [];
  const now = Date.now();
  const cached = rolePermissionsCache.get(role);

  if (cached && cached.expiresAt > now) {
    rolePermissions = cached.permissions;
  } else {
    const roleConfig = (await Role.findOne({ name: role }).lean()) as { permissions?: string[] } | null;
    rolePermissions = roleConfig?.permissions || [];
    rolePermissionsCache.set(role, {
      permissions: rolePermissions,
      expiresAt: now + ROLE_CACHE_TTL_MS,
    });
  }

  const builtinPerms = BUILTIN_ROLE_PERMISSIONS[role] || [];
  return new Set([...jwtPermissions, ...rolePermissions, ...builtinPerms]);
}

/** True when the request user has at least one of the listed permissions (root/admin bypass). */
export async function requestHasAnyPermission(
  req: FastifyRequest,
  ...requiredPermissions: string[]
): Promise<boolean> {
  const role = req.user?.role;
  if (!role) return false;
  if (isPrivilegedRole(role)) return true;

  const jwtPerms = (req.user as { permissions?: string[] }).permissions || [];
  const all = await getEffectivePermissions(role, jwtPerms);
  return requiredPermissions.some((perm) => all.has(perm));
}
