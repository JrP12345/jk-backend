import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ignored = new Set(['node_modules', '.git', '.next', '.cloudflare', '.cache', 'dist', 'build', 'coverage', 'backups', 'keys', '.aws', '.codex', '.agents']);
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const posix = value => value.replaceAll('\\', '/');
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const packageName = value => value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0];

/** Static evidence only: references are candidates, never proof that code is unused or safe. */
export function inventory(root) {
  root = path.resolve(root);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.isSymbolicLink() || entry.name.startsWith('.env')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !/\.(?:pem|key|crt|enc|dump|log|tsbuildinfo)$/.test(entry.name)) files.push(posix(path.relative(root, full)));
    }
  }
  walk(root); files.sort();
  const manifest = json(path.join(root, 'package.json')) || {}, lock = json(path.join(root, 'package-lock.json'));
  const allSources = files.filter(file => sourceExtension.test(file));
  const generated = allSources.filter(file => file.startsWith('public/pharmacy-offline/'));
  const sources = allSources.filter(file => !generated.includes(file));
  const sourceSet = new Set(sources), references = new Map(), edges = [], unresolved = [], sourceFiles = [], hashes = new Map();
  const configFiles = files.filter(file => /(?:^|\/)(?:package\.json|Dockerfile|[^/]+\.(?:ya?ml|toml))$/.test(file));
  const configText = configFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
  for (const file of sources) {
    const content = fs.readFileSync(path.join(root, file), 'utf8'), isTest = /(?:^|\/)(?:tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(file);
    sourceFiles.push({ file, lines: content.split('\n').length, test: isTest });
    const hash = createHash('sha256').update(content.trim()).digest('hex');
    if (content.trim().length >= 200) hashes.set(hash, [...(hashes.get(hash) || []), file]);
    // Includes type/re-export, literal dynamic imports and require. Framework/dynamic discovery still needs manual review.
    const imports = /\b(?:import|export)\s+(?:(?:type\s+)?[^;]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of content.matchAll(imports)) {
      const specifier = match[1] || match[2], line = content.slice(0, match.index).split('\n').length;
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const base = specifier.startsWith('@/') ? 'src/' + specifier.slice(2) : posix(path.normalize(path.join(path.dirname(file), specifier)));
        const variants = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)];
        const target = variants.find(value => sourceSet.has(value));
        if (target) edges.push({ from: file, to: target, line, typeOnly: /^(?:import|export)\s+type\b/.test(match[0]) });
        else if (!/\.(?:css|json|svg|png|webp|jpe?g)$/.test(base)) unresolved.push({ file, line, specifier });
      } else if (!specifier.startsWith('node:') && !specifier.startsWith('#')) {
        const name = packageName(specifier), prior = references.get(name) || [];
        prior.push({ file, line, test: isTest }); references.set(name, prior);
      }
    }
  }
  const graph = new Map(sources.map(file => [file, []]));
  for (const { from, to, typeOnly } of edges) if (!typeOnly) graph.get(from).push(to);
  let index = 0; const indices = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(file) {
    indices.set(file, index); low.set(file, index++); stack.push(file); active.add(file);
    for (const next of graph.get(file)) {
      if (!indices.has(next)) { visit(next); low.set(file, Math.min(low.get(file), low.get(next))); }
      else if (active.has(next)) low.set(file, Math.min(low.get(file), indices.get(next)));
    }
    if (low.get(file) === indices.get(file)) {
      const component = []; let next;
      do { next = stack.pop(); active.delete(next); component.push(next); } while (next !== file);
      if (component.length > 1) cycles.push(component.sort());
    }
  }
  for (const file of sources) if (!indices.has(file)) visit(file);
  const direct = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).sort(([a], [b]) => a.localeCompare(b)).map(([name, requested]) => {
    const locked = lock?.packages?.['node_modules/' + name], installed = json(path.join(root, 'node_modules', name, 'package.json'));
    return { name, requested, scope: manifest.dependencies?.[name] ? 'production' : 'development', version: locked?.version || installed?.version || null,
      license: locked?.license || installed?.license || null, installedVersion: installed?.version || null,
      references: references.get(name) || [], configurationReferences: configText.filter(([, content]) => content.includes(name)).map(([file]) => file),
      peers: installed?.peerDependencies || {}, note: 'Missing static imports do not establish non-use: CLI, type, peer, configuration and framework discovery require review.' };
  });
  const packages = Object.entries(lock?.packages || {}).filter(([location]) => location).map(([location, entry]) => {
    const installed = (!entry.license || !entry.version) ? json(path.join(root, location, 'package.json')) : null;
    return { location, name: entry.name || location.split('node_modules/').at(-1), version: entry.version || installed?.version || null, license: entry.license || installed?.license || null,
      development: Boolean(entry.dev), optional: Boolean(entry.optional), link: Boolean(entry.link), deprecated: entry.deprecated || null, engines: entry.engines || installed?.engines || {},
      integrity: entry.integrity || null, dependencies: entry.dependencies || {}, optionalDependencies: entry.optionalDependencies || {}, peerDependencies: entry.peerDependencies || {} };
  });
  const directories = {};
  for (const file of files) { const dir = file.includes('/') ? file.split('/')[0] : '(root)'; directories[dir] = (directories[dir] || 0) + 1; }
  const inbound = new Set(edges.map(edge => edge.to));
  const candidates = sources.filter(file => !inbound.has(file) && !/(?:^|\/)(?:tests|scripts|workers|jobs|packages|cloudflare)(?:\/|$)|(?:^|\/)(?:page|layout|route|loading|error|not-found|default|proxy|middleware|instrumentation|index)\.|(?:\.config\.|-env\.d\.ts$)/.test(file));
  return { schemaVersion: 1, repository: path.basename(root), generatedAt: new Date().toISOString(),
    limitations: ['Static literal-import inventory, not runtime reachability, a penetration test, licence advice or a release certification.', 'Dynamic/framework/config-discovered entries and nonliteral imports require manual review; no candidate is automatically deleted.', 'No environment values, application database rows or secrets are read. Lockfile licences are metadata, not verification of every bundled notice.'],
    totals: { files: files.length, sources: sources.length, tests: sourceFiles.filter(file => file.test).length, generatedSourcesExcluded: generated.length, directDependencies: direct.length, lockfilePackages: packages.length },
    directories, directDependencies: direct, packages, sources: sourceFiles, importEdges: edges, circularImportCandidates: cycles, unresolvedLocalImports: unresolved,
    exactDuplicateCandidates: [...hashes.values()].filter(group => group.length > 1), noInboundImportCandidates: candidates,
    configurationFiles: configFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), root = path.resolve(args[0] || '.'), output = path.resolve(root, args[1] || 'build/architecture-inventory.json');
  const relative = path.relative(root, output);
  if (args.length > 2 || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.json')) throw Error('Usage: architecture-inventory.mjs [repository] [output.json inside repository]');
  const report = inventory(root); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ repository: report.repository, ...report.totals, cycles: report.circularImportCandidates.length, duplicateGroups: report.exactDuplicateCandidates.length, output: posix(relative) }));
}
