import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../architecture-inventory.mjs';

test('inventory preserves evidence, excludes generated/secrets and separates type-only cycles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ekavyu-architecture-'));
  try {
    const write = (file, body) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); };
    write('package.json', JSON.stringify({ dependencies: { 'example-client': '^1' }, devDependencies: { 'example-tool': '^2' } }));
    write('package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/example-client': { version: '1.0.0', license: 'MIT', dependencies: { helper: '^3' } }, 'node_modules/helper': { version: '3.1.0', license: 'Apache-2.0' } } }));
    write('src/a.ts', "import type { B } from './b'; import { client } from 'example-client'; export const a = client;");
    write('src/b.ts', "import { a } from './a'; export type B = typeof a;");
    write('src/c.ts', "export { d } from './d'; export const c = 1;");
    write('src/d.ts', "import { c } from './c'; export const d = c;");
    write('.env', 'NEVER_PUBLISH_THIS_SECRET=private'); write('.cache/compiled.js', 'invalid generated bundle');
    write('public/pharmacy-offline/generated.js', 'generated source');
    const report = inventory(root);
    assert.equal(report.totals.directDependencies, 2); assert.equal(report.totals.lockfilePackages, 2);
    assert.deepEqual(report.circularImportCandidates, [['src/c.ts', 'src/d.ts']]);
    assert.equal(report.directDependencies.find(row => row.name === 'example-client').references[0].file, 'src/a.ts');
    assert.equal(report.directDependencies.find(row => row.name === 'example-tool').references.length, 0);
    assert.match(report.directDependencies.find(row => row.name === 'example-tool').note, /do not establish non-use/);
    assert.equal(report.totals.generatedSourcesExcluded, 1); assert.equal(report.sources.length, 4);
    assert.ok(!JSON.stringify(report).includes('NEVER_PUBLISH_THIS_SECRET'));
    assert.equal(report.packages.find(row => row.name === 'helper').license, 'Apache-2.0');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ekavyu-architecture-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
