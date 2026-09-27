import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, INIT_CWD: cwd };
delete env.MONGOMS_DISABLE_POSTINSTALL;
delete env.MONGOMS_SYSTEM_BINARY;
const code = `
  const config = require('mongodb-memory-server-core/lib/util/resolveConfig');
  config.findPackageJson(process.cwd());
  if (!config.envToBool(config.resolveConfig(config.ResolveConfigVariables.DISABLE_POSTINSTALL))) {
    throw new Error('Test MongoDB download must be disabled during installation.');
  }
  if (config.resolveConfig(config.ResolveConfigVariables.RUNTIME_DOWNLOAD) !== 'true') {
    throw new Error('Integration-test runtime downloads must remain enabled.');
  }
  const binary = require('mongodb-memory-server-core/lib/util/MongoBinary');
  binary.MongoBinary.getPath = () => { throw new Error('Unexpected binary download during install.'); };
  require('mongodb-memory-server/postinstall.js');
`;
const result = spawnSync(process.execPath, ['-e', code], { cwd, env, encoding: 'utf8', timeout: 15000 });
assert.ifError(result.error);
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.match(result.stdout, /postinstall skipped/);
console.log('PASS: dependency install skips the test-only MongoDB download; integration-test runtime downloads remain enabled.');
