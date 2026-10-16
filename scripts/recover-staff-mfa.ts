import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { safeError } from "../utilities/safeError.ts";

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const userId = args.includes("--user-id") ? value("--user-id") : "";
  const reviewer = args.includes("--reviewed-by") ? value("--reviewed-by") : "";
  if (![userId, reviewer].every(id => /^[a-f\d]{24}$/i.test(id || ""))) throw new Error("Specify --user-id and --reviewed-by IDs");
  if (!process.env.MONGODB_URI) throw new Error("Explicit MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, maxPoolSize: 2 });
  const user = await User.findOne({ _id: userId, isActive: true, role: { $nin: ["root", "patient", "family_member", "guest"] } }).select("authVersion twoFactorEnabled").lean();
  if (!user) throw new Error("Active staff identity not found");
  if (!args.includes("--apply")) {
    console.log(JSON.stringify({ previewOnly: true, userId, twoFactorEnabled: !!user.twoFactorEnabled, expectedAuthVersion: user.authVersion || 1, required: "Verify identity independently; --apply --identity-verified --expected-auth-version <version> after review" }));
    return;
  }
  if (!args.includes("--identity-verified") || !args.includes("--expected-auth-version")) throw new Error("Explicit identity review and version are required");
  const expectedVersion = Number(value("--expected-auth-version"));
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("Invalid reviewed version");
  const { recoverStaffMfa } = await import("../services/StaffMfaRecovery.ts");
  console.log(JSON.stringify(await recoverStaffMfa(userId, reviewer, expectedVersion)));
}
main().catch(error => { console.error("Staff MFA recovery stopped", safeError(error)); process.exitCode = 1; }).finally(async () => {
  await mongoose.disconnect();
  // This operator CLI can import long-lived Redis subscribers on apply. The
  // transaction and cluster revocation publish are already awaited above.
  process.exit(process.exitCode ? Number(process.exitCode) : 0);
});
