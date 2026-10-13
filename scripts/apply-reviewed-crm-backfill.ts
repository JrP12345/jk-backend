import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';
import { applyReviewedCrmBackfill, type ReviewedCrmBackfill } from '../services/CrmReviewedBackfillService.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--writes-paused' || args[3] !== '--authorized-rollout') throw new Error('A reviewed manifest, paused writes and separately authorized rollout are required');
  const manifest = JSON.parse(await readFile(args[1], 'utf8')) as { commands: ReviewedCrmBackfill[] };
  if (!Array.isArray(manifest.commands) || !manifest.commands.length || manifest.commands.length > 100) throw new Error('Use a bounded reviewed manifest of 1..100 commands');
  const first = manifest.commands[0];
  if (!manifest.commands.every(command => command.organizationId === first.organizationId && command.actorId === first.actorId && command.batchId === first.batchId && mongoose.isValidObjectId(command.organizationId) && mongoose.isValidObjectId(command.actorId) && mongoose.isValidObjectId(command.appointmentId))) throw new Error('Each batch must pin one organization, operator and batch identifier');
  if (!process.env.MONGODB_URI) throw new Error('A reviewed transaction-capable connection is required');
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    for (const command of manifest.commands) {
      try { console.log(JSON.stringify({ clientRequestId: command.clientRequestId, ...await applyReviewedCrmBackfill(command) })); }
      catch (error) { console.error(JSON.stringify({ clientRequestId: command.clientRequestId, status: 'stopped_for_review', code: (error as { statusCode?: number }).statusCode || 503 })); process.exitCode = 1; break; }
    }
  } finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error('Reviewed CRM backfill did not complete. No connection details or clinical content are logged.'); process.exitCode = 1; });
