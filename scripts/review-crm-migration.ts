import mongoose from 'mongoose';
import { reviewCrmMigrationPage } from '../services/CrmMigrationReviewService.ts';

// Deliberately has no --apply mode. Use a read-only account and a reviewed snapshot.
async function main() {
  const args = process.argv.slice(2), allowed = new Set(['--organization', '--cursor', '--limit']);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('Use --organization <id> [--cursor <id>] [--limit 1..200]; writes are unsupported');
    values.set(args[i], args[i + 1]);
  }
  const organizationId = values.get('--organization');
  if (!organizationId || !mongoose.isValidObjectId(organizationId)) throw new Error('A reviewed organization identifier is required');
  if (!process.env.MONGODB_URI) throw new Error('A read-only snapshot connection is required');
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await reviewCrmMigrationPage({ organizationId, cursor: values.get('--cursor'), limit: values.has('--limit') ? Number(values.get('--limit')) : 100 }), null, 2));
  } finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error('CRM review failed. Check the reviewed scope, read-only connection and page arguments; connection details are not logged.'); process.exitCode = 1; });
