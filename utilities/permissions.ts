import type { FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { Role } from "../models/Role.ts";
import { redisClient, publishRedisEvent, createRedisSubscriber } from "./redis.ts";

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
  "ADMINISTRATIVE_GOVERNANCE",
  "VIEW_AUDIT_LOGS",
  "VIEW_PATIENTS",
  "MANAGE_PATIENTS",
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

/**
 * Platform Root check.
 * Only the platform root operator carries unrestricted bypass privileges.
 * Organizational 'admin' roles must have explicit permissions configured in the DB.
 */
export function isPrivilegedRole(role: string | undefined): boolean {
  return role === "root";
}

export function isPlatformRoot(role: string | undefined): boolean {
  return role === "root";
}

interface RoleCacheEntry {
  permissions: string[];
  expiresAt: number;
}

const rolePermissionsCache = new Map<string, RoleCacheEntry>();
const ROLE_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 300 * 1000; // 5 min in prod, 0 in tests
const REDIS_PERM_TTL_SECONDS = 300;

// Setup distributed Redis invalidation subscriber
const roleSubClient = createRedisSubscriber();
if (roleSubClient) {
  roleSubClient.subscribe("auth:role:invalidate", (err) => {
    if (err) {
      console.warn("[RoleCache] Failed to subscribe to auth:role:invalidate channel:", err.message);
    }
  });

  roleSubClient.on("message", (channel, message) => {
    if (channel === "auth:role:invalidate") {
      try {
        const payload = JSON.parse(message);
        if (payload?.roleName) {
          // Evict all entries matching this roleName
          for (const key of rolePermissionsCache.keys()) {
            if (key.includes(`:${payload.roleName}:`)) {
              rolePermissionsCache.delete(key);
            }
          }
        } else {
          rolePermissionsCache.clear();
        }
      } catch {
        rolePermissionsCache.clear();
      }
    }
  });
}

/** Invalidate cached permissions across the entire cluster */
export async function invalidateRoleCache(roleName?: string, organizationId?: string) {
  if (roleName) {
    for (const key of rolePermissionsCache.keys()) {
      if (key.includes(`:${roleName}:`)) {
        rolePermissionsCache.delete(key);
      }
    }
  } else {
    rolePermissionsCache.clear();
  }

  // Broadcast invalidation to all replicas via Redis PubSub
  try {
    if (redisClient) {
      // A shared generation prevents a replica from reloading stale Redis
      // permissions even when its Pub/Sub invalidation message is missed.
      await redisClient.incr(`auth:role:generation:${roleName || "all"}`);
    }
    await publishRedisEvent("auth:role:invalidate", { roleName, organizationId });
  } catch (err: any) {
    console.warn("[RoleCache] Failed to publish Redis cache invalidation:", err.message);
  }
}
(globalThis as any).__invalidateRoleCache = invalidateRoleCache;

/**
 * Authoritative permission resolution from Database Role definitions.
 * Stale JWT permissions are discarded completely.
 * Caches by organization, role, and version.
 */
export async function getEffectivePermissions(
  role: string,
  organizationId?: string,
  authVersion: number = 1
): Promise<Set<string>> {
  if (!role) return new Set();

  let generation = "local";
  let cacheAvailable = true;
  if (redisClient) {
    try {
      const versions = await redisClient.mget("auth:role:generation:all", `auth:role:generation:${role}`);
      generation = `${versions[0] || "0"}.${versions[1] || "0"}`;
    } catch {
      // During a shared-cache outage, do not trust previously granted access.
      cacheAvailable = false;
    }
  }
  const cacheKey = `perm:${organizationId || "global"}:${role}:${authVersion}:${generation}`;
  const now = Date.now();
  const cached = rolePermissionsCache.get(cacheKey);

  if (cacheAvailable && cached && cached.expiresAt > now) {
    return new Set(cached.permissions);
  }

  // Check Redis cache if available
  if (redisClient && cacheAvailable) {
    try {
      const redisVal = await redisClient.get(`auth:role:${cacheKey}`);
      if (redisVal) {
        const perms: string[] = JSON.parse(redisVal);
        rolePermissionsCache.set(cacheKey, { permissions: perms, expiresAt: now + ROLE_CACHE_TTL_MS });
        return new Set(perms);
      }
    } catch {
      // safe fallback to DB
    }
  }

  // Authoritative Database Query
  const orgFilter = organizationId && mongoose.Types.ObjectId.isValid(organizationId)
    ? [{ organizationId: new mongoose.Types.ObjectId(organizationId) }, { organizationId: null }]
    : [{ organizationId: null }];

  const roleConfig = (await Role.findOne({
    name: role,
    $or: orgFilter,
  })
    .sort({ organizationId: -1 })
    .lean()) as { permissions?: string[]; version?: number } | null;

  let effectivePermissions: string[] = [];
  if (roleConfig) {
    // An explicitly empty role is a denial, not an invitation to restore defaults.
    effectivePermissions = Array.isArray(roleConfig.permissions) ? roleConfig.permissions : [];
  } else {
    effectivePermissions = BUILTIN_ROLE_PERMISSIONS[role] || [];
  }

  // Cache in memory
  rolePermissionsCache.set(cacheKey, {
    permissions: effectivePermissions,
    expiresAt: now + ROLE_CACHE_TTL_MS,
  });

  // Cache in Redis
  if (redisClient && cacheAvailable) {
    try {
      await redisClient.set(
        `auth:role:${cacheKey}`,
        JSON.stringify(effectivePermissions),
        "EX",
        REDIS_PERM_TTL_SECONDS
      );
    } catch {
      // non-fatal
    }
  }

  return new Set(effectivePermissions);
}

/**
 * Authoritative check if request user has any of the required permissions.
 * Evaluates against authoritative database role without unioning stale JWT permissions.
 */
export async function requestHasAnyPermission(
  req: FastifyRequest,
  ...requiredPermissions: string[]
): Promise<boolean> {
  const role = req.user?.role;
  if (!role) return false;
  if (isPlatformRoot(role)) return true;

  const all = await getEffectivePermissions(role, req.user?.organization_id, req.user?.authVersion);
  return requiredPermissions.some((perm) => all.has(perm));
}
