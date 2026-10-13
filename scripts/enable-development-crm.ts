import mongoose from 'mongoose';
import { User } from '../models/User.ts';
import { upgradeDevelopmentCrmDefaults } from '../services/CrmDefaultRoleUpgradeService.ts';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !arg.startsWith('--confirm-database='))) throw new Error('Unknown argument');
if (process.env.NODE_ENV === 'production') throw new Error('Development-only command');
const confirmation = args.filter(arg => arg.startsWith('--confirm-database='));
if (confirmation.length > 1) throw new Error('Confirm exactly one database');
const deadline = setTimeout(() => { console.error('Development CRM upgrade timed out'); process.exit(1); }, 30000);
try {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ekavyu_dev', { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
  const database = mongoose.connection.db!.databaseName;
  if (['admin', 'local', 'config'].includes(database)) throw new Error('Reserved database');
  if (args.includes('--apply') && confirmation[0]?.slice('--confirm-database='.length) !== database) throw new Error('Confirm the exact connected development database');
  const roots = await User.find({ role: 'root', isActive: true }).select('_id').limit(2).lean();
  if (roots.length !== 1) throw new Error('Exactly one active development root is required');
  console.log(JSON.stringify({ database, apply: args.includes('--apply'), roles: await upgradeDevelopmentCrmDefaults(String(roots[0]._id), args.includes('--apply')) }));
} finally { await mongoose.disconnect(); clearTimeout(deadline); }
// Permission cache subscribers keep Redis sockets open; all writes and cache
// invalidation have completed before terminating this one-shot operator process.
process.exit(0);
