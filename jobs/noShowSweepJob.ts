/**
 * Historical entry point retained for existing worker deployments.
 * Time passing cannot establish that a patient did not attend, so this job
 * intentionally performs no appointment writes. Staff review uses the
 * derived overdue state returned by appointment reads.
 */
export interface NoShowSweepOptions {
  organizationId?: string;
  clinicId?: string;
  gracePeriodMinutes?: number;
}

export interface NoShowSweepResult {
  sweptCount: number;
  clinicIdsAffected: string[];
}

export async function runNoShowSweep(_options: NoShowSweepOptions = {}): Promise<NoShowSweepResult> {
  return { sweptCount: 0, clinicIdsAffected: [] };
}

export function startNoShowSweepJob(_intervalMs?: number) {
  // Older deployment manifests may still start this worker.
}

export function stopNoShowSweepJob() {
  // No timer is installed.
}
