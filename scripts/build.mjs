import { build } from "esbuild";
import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const workers = (await readdir("workers")).filter(name => name.endsWith(".ts"));
const started = performance.now();
console.log(`[build] Compiling API and ${workers.length} worker bundles; no database connection or integration tests run in this step.`);
await build({
  entryPoints: ["index.ts", ...workers.map(name => "workers/" + name)],
  outdir: "dist", outbase: ".", bundle: true, platform: "node", format: "esm",
  packages: "external", target: "node24", logLevel: "info",
});
const artifacts = ["dist/index.js", ...workers.map(name => "dist/workers/" + name.replace(/\.ts$/, ".js"))];
for (const artifact of artifacts) {
  const file = await stat(artifact);
  if (!file.isFile() || file.size === 0) throw new Error(`[build] Missing or empty executable artifact: ${artifact}`);
}
console.log(`[build] Verified ${artifacts.length} executable bundles in ${((performance.now() - started) / 1000).toFixed(2)}s. Start with npm start.`);
