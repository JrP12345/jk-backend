/**
 * Static Analysis & CI Check: Tenant Scoping Enforcement
 *
 * Scans controllers, routes, and services to verify that all access to
 * tenant-owned models satisfies tenant isolation requirements from
 * the Tenant Ownership Matrix.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const matrixPath = path.join(rootDir, "platform", "tenantOwnershipMatrix.json");
if (!fs.existsSync(matrixPath)) {
  console.error("❌ tenantOwnershipMatrix.json not found!");
  process.exit(1);
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf-8"));
const tenantModels = Object.entries(matrix.models)
  .filter(([_, meta]: [string, any]) => meta.classification === "tenant")
  .map(([name]) => name);

console.log(`[CI/TenantCheck] Checking tenant scoping across ${tenantModels.length} tenant models...`);

const targetDirs = [
  path.join(rootDir, "controllers"),
  path.join(rootDir, "routes"),
  path.join(rootDir, "services"),
];

let warningsCount = 0;

function scanFile(filePath: string) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  tenantModels.forEach((modelName) => {
    // Look for findById calls on tenant models without organizationId checks nearby
    const findByIdPattern = new RegExp(`\\b${modelName}\\.findById\\s*\\(`, "g");
    lines.forEach((line, idx) => {
      if (findByIdPattern.test(line)) {
        // Check if tenant repo or explicit scope is present
        if (!line.includes("Repo") && !line.includes("organizationId")) {
          // Check next 3 lines or previous 3 lines
          const surrounding = lines.slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 4)).join(" ");
          if (!surrounding.includes("organizationId") && !surrounding.includes("resolveAuthorizedOrganizationScope")) {
            console.warn(`⚠️  [TenantCheck Warning] ${path.relative(rootDir, filePath)}:${idx + 1} - Direct ${modelName}.findById without explicit tenant scoping detected.`);
            warningsCount++;
          }
        }
      }
    });
  });
}

function walkDir(dir: string) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      scanFile(fullPath);
    }
  }
}

targetDirs.forEach((d) => walkDir(d));

console.log(`[CI/TenantCheck] Verification completed. Warnings: ${warningsCount}`);
process.exit(0);
