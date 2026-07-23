import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Security & Compliance Verification Tests", () => {
  it("should ensure no raw credit card input fields or 16-digit PAN regex exist in frontend source code", () => {
    const billsPagePath = path.join(process.cwd(), "../frontend/src/app/(dashboard)/dashboard/bills/page.tsx");
    const source = fs.readFileSync(billsPagePath, "utf8");

    // Ensure raw card number regex /^\d{16}$/ is completely absent from page source
    expect(source).not.toContain("/^\\d{16}$/");
    
    // Ensure raw cardForm state is absent from page source
    expect(source).not.toContain("cardForm");
    
    // Ensure SAQ A PCI compliance annotation is present
    expect(source).toContain("PCI-DSS");
  });

  it("should ensure user model does not store privateKey or publicKey fields", () => {
    const userModelPath = path.join(process.cwd(), "models/User.ts");
    const source = fs.readFileSync(userModelPath, "utf8");

    expect(source).not.toContain("privateKey:");
    expect(source).not.toContain("publicKey:");
  });
});
