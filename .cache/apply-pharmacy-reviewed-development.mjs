import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { Invoice } from '../models/Invoice.ts';
import { MedicineBatch } from '../models/MedicineBatch.ts';
import { ChainTransitionRecord } from '../models/ChainTransitionRecord.ts';
import { OrgInvite } from '../models/OrgInvite.ts';
import { prepareDatabaseIndexes } from '../services/DatabaseIndexService.ts';
import { runDatabaseIndexSetup } from '../scripts/prepare-database-indexes.ts';
import { runMedicineSearchPreparation } from '../scripts/prepare-medicine-search.ts';

if (process.env.NODE_ENV === 'production') throw Error('Development setup refuses a production process.');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
try {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw Error('Transaction-capable database required.');
  const invoices = await Invoice.aggregate([
    { $project: { valid: { $setEquals: [
      { $map: { input: { $filter: { input: { $ifNull: ['$items', []] }, as: 'item', cond: { $eq: [{ $type: '$$item.pharmacyDispenseLineId' }, 'objectId'] } } }, as: 'item', in: '$$item.pharmacyDispenseLineId' } },
      { $ifNull: ['$pharmacyDispenseLineIds', []] }
    ] } } }, { $match: { valid: false } }, { $count: 'mismatches' }
  ]).option({ maxTimeMS: 5000 });
  if (invoices.length) throw Error('Invoice source projection needs separate review.');
  const reviewed = [
    { model: Invoice, oldName: 'items.pharmacyDispenseLineId_1', oldKey: { 'items.pharmacyDispenseLineId': 1 }, oldPartial: { 'items.pharmacyDispenseLineId': { $type: 'objectId' } }, replacementKey: { pharmacyDispenseLineIds: 1 }, replacementPartial: { pharmacyDispenseLineIds: { $type: 'objectId' } } },
    { model: MedicineBatch, oldName: 'medicineId_1_locationId_1_batchNumber_1', oldKey: { medicineId: 1, locationId: 1, batchNumber: 1 }, replacementKey: { organizationId: 1, locationId: 1, receiptLineId: 1 }, replacementPartial: { lotVersion: 1 } }
  ];
  const plans = [];
  for (const entry of reviewed) {
    const indexes = await entry.model.collection.listIndexes().toArray();
    const old = indexes.find(index => index.name === entry.oldName);
    const replacement = indexes.find(index => isDeepStrictEqual(index.key, entry.replacementKey) && index.unique === true && isDeepStrictEqual(index.partialFilterExpression, entry.replacementPartial));
    if (!replacement || old && (!isDeepStrictEqual(old.key, entry.oldKey) || old.unique !== true || !isDeepStrictEqual(old.partialFilterExpression, entry.oldPartial) || old.expireAfterSeconds !== undefined || old.sparse || old.hidden || old.collation)) throw Error('Reviewed index definitions changed; no removal permitted.');
    if (old) plans.push({ collection: entry.model.collection.name, old, replacement });
  }
  await writeFile(new URL('./pharmacy-reviewed-index-metadata.json', import.meta.url), JSON.stringify({ capturedAt: new Date().toISOString(), plans }, null, 2));
  for (const plan of plans) {
    await mongoose.connection.db.collection(plan.collection).dropIndex(plan.old.name);
    console.log(JSON.stringify({ reviewedObsoleteIndexRemoved: plan.old.name, replacementIndexRetained: plan.replacement.name }));
  }
  const setup = await prepareDatabaseIndexes([ChainTransitionRecord, OrgInvite]);
  console.log(JSON.stringify({ missingCollectionsPrepared: setup.ready, models: setup.models }));
} finally { await mongoose.disconnect(); }
await runDatabaseIndexSetup(['--check']);
if (process.exitCode) throw Error('Schema readiness incomplete; keep writers stopped.');
await runMedicineSearchPreparation(['--apply', '--writes-paused']);
if (process.exitCode) throw Error('Search readiness incomplete; keep writers stopped.');
