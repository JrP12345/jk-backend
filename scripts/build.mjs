import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const workers = (await readdir("workers")).filter(name => name.endsWith(".ts"));
await build({
  entryPoints: ["index.ts", ...workers.map(name => "workers/" + name)],
  outdir: "dist", outbase: ".", bundle: true, platform: "node", format: "esm",
  packages: "external", target: "node24", logLevel: "info",
});
