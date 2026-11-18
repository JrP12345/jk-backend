import { configDefaults, defineConfig } from "vitest/config";

// Reviewed non-persistence tests: no database fixtures or database actions.
// All other tests retain their isolated MongoDB replica-set setup.
const unitTests = [
  "tests/pharmacyCsv.test.ts",
  "tests/pharmacyCalculationSource.test.ts",
  "tests/invoiceCalculation.test.ts",
  "tests/pharmacySupplierReadiness.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "build/**", ".cache/**", "dist/**", "scripts/tests/**"],
    projects: [
      { test: { name: "unit", include: unitTests } },
      { test: { name: "integration", exclude: unitTests, setupFiles: ["./tests/setup.ts"] } },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
