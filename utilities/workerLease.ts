import { WorkerLease } from "../models/WorkerLease.ts";

export interface WorkerLeaseRequest {
  name: string;
  holderId: string;
  leaseMs: number;
  now?: Date;
}

/**
 * Atomically creates, takes over, or renews a named lease. A worker may only
 * renew its own lease; another holder must wait until the expiry time.
 */
export async function acquireOrRenewWorkerLease({
  name,
  holderId,
  leaseMs,
  now = new Date(),
}: WorkerLeaseRequest): Promise<boolean> {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("Worker lease duration must be a positive number of milliseconds");
  }

  try {
    const lease = await WorkerLease.findOneAndUpdate(
      {
        name,
        $or: [
          { holderId },
          { expiresAt: { $lte: now } },
          { expiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          holderId,
          expiresAt: new Date(now.getTime() + leaseMs),
        },
        $setOnInsert: { name },
      },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).lean();

    return lease?.holderId === holderId;
  } catch (error: any) {
    // When a non-expired lease exists, concurrent upsert attempts can race on
    // the unique name index. The other worker owns the lease in that case.
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** Release only the current holder's lease. Never delete a newer holder's row. */
export async function releaseWorkerLease(name: string, holderId: string): Promise<void> {
  await WorkerLease.deleteOne({ name, holderId });
}
