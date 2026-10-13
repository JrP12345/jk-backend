import crypto from 'node:crypto';
import { Organization } from '../models/Organization.ts';
import { WorkerLoop } from '../utilities/workerLoop.ts';
import { runOrganizationCrmReminders } from '../services/CrmReminderService.ts';
const loop = new WorkerLoop();
const holderId = `${process.pid}:${crypto.randomUUID()}`;
const cursors = new Map<string, string>();
let organizationCursor: string | undefined;
export const getCrmReminderProgress = () => loop.progress();
export async function runCrmReminderBatch() {
  const orgs = await Organization.find({ isActive: true, status: 'active', 'crmSettings.automationEnabled': true, ...(organizationCursor ? { _id: { $gt: organizationCursor } } : {}) }).sort({ _id: 1 }).select('_id').limit(20).lean();
  let processed = 0;
  for (const org of orgs) {
    const result = await runOrganizationCrmReminders(String(org._id), holderId, cursors.get(String(org._id)));
    if (result.nextCursor) cursors.set(String(org._id), result.nextCursor); else cursors.delete(String(org._id));
    processed += result.processed;
  }
  organizationCursor = orgs.length === 20 ? String(orgs[orgs.length - 1]._id) : undefined;
  return { processed };
}
export function startCrmReminderJob(intervalMs = 60_000) { loop.start(runCrmReminderBatch, intervalMs); }
export async function stopCrmReminderJob() { await loop.stop(); }
