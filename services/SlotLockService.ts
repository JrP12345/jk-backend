import { redisClient } from "../utilities/redis.ts";

/**
 * SlotLockService — Atomic slot reservation using Redis SETNX + TTL.
 *
 * Prevents double-booking by holding a distributed lock on a specific
 * doctor+clinic+time slot. The lock auto-expires after LOCK_TTL_SECONDS
 * to prevent abandoned locks from blocking slots permanently.
 *
 * When Redis is unavailable (dev/testing), falls back to an in-memory Map.
 *
 * Lock Key Format: slot_lock:{clinicId}:{doctorId}:{YYYY-MM-DDTHH:MM}
 * Lock Value:      {userId}:{lockId}:{timestamp}
 */

const LOCK_TTL_SECONDS = 300; // 5 minutes
const LOCK_PREFIX = "slot_lock";

// In-memory fallback for environments without Redis
const memoryLocks = new Map<string, { value: string; expiresAt: number }>();

function buildLockKey(clinicId: string, doctorId: string, slotTime: string): string {
  // Normalize time to HH:MM granularity to match SlotService output
  const date = new Date(slotTime);
  if (isNaN(date.getTime())) {
    throw new Error("Invalid slot time format");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${LOCK_PREFIX}:${clinicId}:${doctorId}:${year}-${month}-${day}T${hours}:${minutes}`;
}

function generateLockId(): string {
  return `lck_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

function distributedLockUnavailable(): boolean {
  return process.env.NODE_ENV === "production" && (!redisClient || redisClient.status !== "ready");
}

// Clean expired in-memory locks periodically
function cleanMemoryLocks(): void {
  const now = Date.now();
  for (const [key, lock] of memoryLocks.entries()) {
    if (lock.expiresAt <= now) {
      memoryLocks.delete(key);
    }
  }
}

export interface SlotLockResult {
  success: boolean;
  lockId?: string;
  lockKey?: string;
  expiresInSeconds?: number;
  message: string;
  heldBy?: string;
}

export interface SlotLockInfo {
  isLocked: boolean;
  lockKey: string;
  heldByUserId?: string;
  lockId?: string;
  ttlSeconds?: number;
}

/**
 * Acquire an atomic lock on a specific appointment slot.
 * Returns a lockId that must be presented when booking or releasing.
 */
export async function acquireSlotLock(
  clinicId: string,
  doctorId: string,
  slotTime: string,
  userId: string
): Promise<SlotLockResult> {
  const lockKey = buildLockKey(clinicId, doctorId, slotTime);
  if (distributedLockUnavailable()) {
    return { success: false, lockKey, message: "Distributed slot locking is unavailable" };
  }
  const lockId = generateLockId();
  const lockValue = `${userId}:${lockId}:${Date.now()}`;

  if (redisClient) {
    // Atomic SET-if-Not-eXists with TTL
    const acquired = await redisClient.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");

    if (acquired === "OK") {
      return {
        success: true,
        lockId,
        lockKey,
        expiresInSeconds: LOCK_TTL_SECONDS,
        message: "Slot locked successfully",
      };
    }

    // Lock already held — report who holds it
    const existingValue = await redisClient.get(lockKey);
    const heldByUserId = existingValue ? existingValue.split(":")[0] : "unknown";
    const ttl = await redisClient.ttl(lockKey);

    // Allow same user to re-acquire (idempotent)
    if (heldByUserId === userId) {
      const existingLockId = existingValue ? existingValue.split(":")[1] : lockId;
      return {
        success: true,
        lockId: existingLockId,
        lockKey,
        expiresInSeconds: ttl > 0 ? ttl : LOCK_TTL_SECONDS,
        message: "Slot already locked by you",
      };
    }

    return {
      success: false,
      message: "Slot is currently held by another user",
      heldBy: heldByUserId,
    };
  }

  // In-memory fallback
  cleanMemoryLocks();
  const existing = memoryLocks.get(lockKey);
  const now = Date.now();

  if (existing && existing.expiresAt > now) {
    const heldByUserId = existing.value.split(":")[0];
    if (heldByUserId === userId) {
      const existingLockId = existing.value.split(":")[1];
      return {
        success: true,
        lockId: existingLockId,
        lockKey,
        expiresInSeconds: Math.ceil((existing.expiresAt - now) / 1000),
        message: "Slot already locked by you",
      };
    }
    return {
      success: false,
      message: "Slot is currently held by another user",
      heldBy: heldByUserId,
    };
  }

  memoryLocks.set(lockKey, {
    value: lockValue,
    expiresAt: now + LOCK_TTL_SECONDS * 1000,
  });

  return {
    success: true,
    lockId,
    lockKey,
    expiresInSeconds: LOCK_TTL_SECONDS,
    message: "Slot locked successfully",
  };
}

/**
 * Release a held slot lock. Only the lock owner (matching lockId) can release.
 */
export async function releaseSlotLock(
  clinicId: string,
  doctorId: string,
  slotTime: string,
  userId: string,
  lockId: string
): Promise<{ success: boolean; message: string }> {
  const lockKey = buildLockKey(clinicId, doctorId, slotTime);
  if (distributedLockUnavailable()) {
    return { success: false, message: "Distributed slot locking is unavailable" };
  }

  if (redisClient) {
    const existingValue = await redisClient.get(lockKey);
    if (!existingValue) {
      return { success: true, message: "Lock already released or expired" };
    }

    const [heldUserId, heldLockId] = existingValue.split(":");
    if (heldUserId !== userId) {
      return { success: false, message: "Cannot release lock held by another user" };
    }
    if (heldLockId !== lockId) {
      return { success: false, message: "Lock ID mismatch — lock may have been re-acquired" };
    }

    await redisClient.del(lockKey);
    return { success: true, message: "Slot lock released successfully" };
  }

  // In-memory fallback
  const existing = memoryLocks.get(lockKey);
  if (!existing || existing.expiresAt <= Date.now()) {
    return { success: true, message: "Lock already released or expired" };
  }

  const [heldUserId, heldLockId] = existing.value.split(":");
  if (heldUserId !== userId) {
    return { success: false, message: "Cannot release lock held by another user" };
  }
  if (heldLockId !== lockId) {
    return { success: false, message: "Lock ID mismatch" };
  }

  memoryLocks.delete(lockKey);
  return { success: true, message: "Slot lock released successfully" };
}

/**
 * Check whether a specific slot is currently locked.
 */
export async function checkSlotLock(
  clinicId: string,
  doctorId: string,
  slotTime: string
): Promise<SlotLockInfo> {
  const lockKey = buildLockKey(clinicId, doctorId, slotTime);
  if (distributedLockUnavailable()) {
    return { isLocked: true, lockKey, ttlSeconds: 0 };
  }

  if (redisClient) {
    const existingValue = await redisClient.get(lockKey);
    if (!existingValue) {
      return { isLocked: false, lockKey };
    }

    const [heldUserId, heldLockId] = existingValue.split(":");
    const ttl = await redisClient.ttl(lockKey);

    return {
      isLocked: true,
      lockKey,
      heldByUserId: heldUserId,
      lockId: heldLockId,
      ttlSeconds: ttl > 0 ? ttl : 0,
    };
  }

  // In-memory fallback
  cleanMemoryLocks();
  const existing = memoryLocks.get(lockKey);
  if (!existing || existing.expiresAt <= Date.now()) {
    return { isLocked: false, lockKey };
  }

  const [heldUserId, heldLockId] = existing.value.split(":");
  return {
    isLocked: true,
    lockKey,
    heldByUserId: heldUserId,
    lockId: heldLockId,
    ttlSeconds: Math.ceil((existing.expiresAt - Date.now()) / 1000),
  };
}

/**
 * Release the lock after a successful booking — called internally by bookAppointment.
 * Uses the lockKey directly (no validation against lockId) since booking was already authorized.
 */
export async function forceReleaseSlotLock(lockKey: string): Promise<void> {
  if (redisClient) {
    await redisClient.del(lockKey);
  } else {
    memoryLocks.delete(lockKey);
  }
}

/**
 * Validate that a user holds the lock for a given slot before allowing booking.
 * Returns true if the slot is unlocked (backward compat) or if the user holds the lock.
 */
export async function validateSlotLockForBooking(
  clinicId: string,
  doctorId: string,
  slotTime: string,
  userId: string,
  lockId?: string
): Promise<{ valid: boolean; lockKey: string; message: string }> {
  const info = await checkSlotLock(clinicId, doctorId, slotTime);

  if (distributedLockUnavailable()) {
    return { valid: false, lockKey: info.lockKey, message: "Distributed slot locking is unavailable" };
  }

  // If slot is not locked, allow booking (backward compatibility — lock is optional)
  if (!info.isLocked) {
    return { valid: true, lockKey: info.lockKey, message: "Slot is available" };
  }

  // If slot is locked by same user, allow booking
  if (info.heldByUserId === userId) {
    return { valid: true, lockKey: info.lockKey, message: "Slot locked by you" };
  }

  // Slot is locked by another user — reject
  return {
    valid: false,
    lockKey: info.lockKey,
    message: "Slot is currently held by another user. Please select a different time.",
  };
}
