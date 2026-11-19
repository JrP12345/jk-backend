import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIB = 1024 * 1024;
const productCollections = ['pharmacyglobalproducts', 'medicines'];

function bytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} metric`);
  return value;
}

export function storageOptions(args) {
  const options = { limitMiB: 512, reserveMiB: 128 };
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(limit|reserve)-mib=(\d+)$/.exec(arg);
    if (!match || seen.has(match[1])) throw new Error('Invalid or repeated storage argument');
    seen.add(match[1]);
    options[match[1] === 'limit' ? 'limitMiB' : 'reserveMiB'] = Number(match[2]);
  }
  if (!Number.isSafeInteger(options.limitMiB) || options.limitMiB < 1 || options.limitMiB > 1_048_576 ||
      !Number.isSafeInteger(options.reserveMiB) || options.reserveMiB < 0 || options.reserveMiB >= options.limitMiB) {
    throw new Error('Set a positive budget and a smaller nonnegative reserve, in MiB');
  }
  return options;
}

export function summarizeStorage(stats, options = storageOptions([])) {
  const { limitMiB, reserveMiB } = storageOptions([`--limit-mib=${options.limitMiB}`, `--reserve-mib=${options.reserveMiB}`]);
  // Atlas Free counts uncompressed documents plus indexes, not allocated disk size.
  const dataBytes = bytes(stats.dataSize, 'document size');
  const indexBytes = bytes(stats.indexSize, 'index size');
  const usedBytes = bytes(dataBytes + indexBytes, 'total size');
  const budgetBytes = limitMiB * MIB, reserveBytes = reserveMiB * MIB;
  const remainingBytes = Math.max(0, budgetBytes - usedBytes);
  return { databaseChanged: false, scope: 'configured_database_only', budgetMiB: limitMiB, reserveMiB,
    dataBytes, indexBytes, usedBytes, remainingBytes, aboveReserveBytes: Math.max(0, remainingBytes - reserveBytes),
    status: usedBytes >= budgetBytes ? 'budget_reached' : remainingBytes <= reserveBytes ? 'reserve_reached' : 'headroom_available',
    constraints: [
      'Budget is operator-selected, not a detected hosting plan or guaranteed import capacity.',
      'Other databases on the cluster also consume its allowance; check the Atlas cluster total.',
      'Product search keys, indexes, invoices, stock movements and audits need space. Check again after each small import.',
      'This read-only report does not enforce a quota, approve a dataset or load any products.',
    ] };
}

export async function readPharmacyStorage(db, options) {
  const stats = await db.command({ dbStats: 1, scale: 1, maxTimeMS: 5000 });
  const report = summarizeStorage(stats, options);
  const collections = [];
  for (const name of productCollections) {
    try {
      const row = await db.command({ collStats: name, scale: 1, maxTimeMS: 3000 });
      collections.push({ collection: name, products: bytes(row.count, 'product count'), dataBytes: bytes(row.size, 'product size'),
        indexBytes: bytes(row.totalIndexSize, 'product indexes') });
    } catch (error) {
      if (error?.code !== 26) throw error;
      collections.push({ collection: name, products: 0, dataBytes: 0, indexBytes: 0 });
    }
  }
  return { ...report, productCollections: collections };
}

export async function runStorageCheck(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: npm run check:pharmacy-storage -- [--limit-mib=512] [--reserve-mib=128]. Reads configured database metadata only; no scans, products, indexes or stock are written. Defaults are a 512 MiB planning budget with 128 MiB reserved for operations. Check cluster-wide usage separately.');
    return;
  }
  const options = storageOptions(args);
  if (!process.env.MONGODB_URI) throw new Error('Configure MONGODB_URI privately before reading database storage');
  const { default: mongoose } = await import('mongoose');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false,
    maxPoolSize: 1, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 10000 });
  try {
    await connection.asPromise();
    const report = await readPharmacyStorage(connection.db, options);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'headroom_available') process.exitCode = 1;
    return report;
  } finally { await connection.close(true); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStorageCheck().catch(() => {
    // Driver/DNS errors can include credentials or private deployment addresses.
    console.error('Storage check failed. Check arguments, database credentials, permissions and network privately. No database changes were made.');
    process.exitCode = 1;
  });
}
