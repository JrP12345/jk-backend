import type { FastifyRequest } from "fastify";
import { Role } from "../models/Role.ts";
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
} from "../controllers/onboarding.ts";

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

/** Merge JWT, DB role, and built-in permissions for a caller. */
export async function getEffectivePermissions(
  role: string,
  jwtPermissions: string[] = [],
): Promise<Set<string>> {
  const roleConfig = (await Role.findOne({ name: role }).lean()) as { permissions?: string[] } | null;
  const rolePermissions = roleConfig?.permissions || [];
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
