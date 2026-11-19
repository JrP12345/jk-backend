import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPharmacyStorage, storageOptions, summarizeStorage } from '../check-pharmacy-storage.mjs';

const MIB = 1024 * 1024;

test('storage planning counts uncompressed data and indexes, preserving operational headroom', () => {
  const report = summarizeStorage({ dataSize: 200 * MIB, indexSize: 100 * MIB, storageSize: 50 * MIB });
  assert.equal(report.usedBytes, 300 * MIB);
  assert.equal(report.aboveReserveBytes, 84 * MIB);
  assert.equal(report.status, 'headroom_available');
  assert.equal(report.scope, 'configured_database_only');
  assert.equal(report.databaseChanged, false);
  assert.equal(summarizeStorage({ dataSize: 256 * MIB, indexSize: 128 * MIB }).status, 'reserve_reached');
  assert.equal(summarizeStorage({ dataSize: 500 * MIB, indexSize: 20 * MIB }).status, 'budget_reached');
  assert.equal(summarizeStorage({ dataSize: 500 * MIB, indexSize: 20 * MIB }).remainingBytes, 0);
});

test('invalid metrics and budgets never produce a false capacity claim', () => {
  for (const args of [['--limit-mib=0'], ['--limit-mib=1'], ['--reserve-mib=-1'], ['--reserve-mib=512'],
    ['--limit-mib=512', '--limit-mib=512'], ['--apply'], ['--limit-mib=999999999999999999999']]) {
    assert.throws(() => storageOptions(args));
  }
  for (const value of [undefined, NaN, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => summarizeStorage({ dataSize: value, indexSize: 0 }));
  }
  assert.deepEqual(storageOptions(['--limit-mib=1024', '--reserve-mib=256']), { limitMiB: 1024, reserveMiB: 256 });
});

test('metadata probe issues only bounded read commands and handles absent product collections', async () => {
  const commands = [];
  const report = await readPharmacyStorage({ command: async command => {
    commands.push(command);
    if (command.dbStats) return { dataSize: 1024, indexSize: 512 };
    if (command.collStats === 'pharmacyglobalproducts') throw Object.assign(new Error('not created'), { code: 26 });
    return { count: 5, size: 1024, totalIndexSize: 256 };
  } }, storageOptions([]));
  assert.equal(commands.length, 3);
  assert.ok(commands.every(command => command.scale === 1 && command.maxTimeMS > 0 && (command.dbStats || command.collStats)));
  assert.deepEqual(report.productCollections.map(row => row.products), [0, 5]);
  await assert.rejects(() => readPharmacyStorage({ command: async () => { throw new Error('permission denied'); } }, storageOptions([])));
  await assert.rejects(() => readPharmacyStorage({ command: async command => {
    if (command.dbStats) return { dataSize: 0, indexSize: 0 };
    throw Object.assign(new Error('permission denied'), { code: 13 });
  } }, storageOptions([])));
});
