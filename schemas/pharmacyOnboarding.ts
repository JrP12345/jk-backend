import { validatePasswordStrength } from "../middleware/auth.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
export interface PharmacyOnboardingInput { email: string; ownerName: string; password?: string; businessName: string; city: string; address: string; businessPhone?: string; planId: string; planFingerprint: string }
const bad = () => new CommandError(400, "Provide the actual owner, business, address and currently published pharmacy trial selection");
export function onboardingInput(value: unknown): PharmacyOnboardingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const row = value as Record<string, unknown>, keys = ["email", "ownerName", "password", "businessName", "city", "address", "businessPhone", "planId", "planFingerprint"];
  if (Object.keys(row).some(key => !keys.includes(key)) || !["email", "ownerName", "businessName", "city", "address", "planId", "planFingerprint"].every(key => typeof row[key] === "string") ||
      typeof row.email !== "string" || row.email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(row.email.trim()) ||
      (row.ownerName as string).trim().length < 2 || (row.ownerName as string).length > 120 || (row.businessName as string).trim().length < 2 || (row.businessName as string).length > 200 ||
      (row.city as string).trim().length < 2 || (row.city as string).length > 100 || /^[0-9+\s-]{6,}$/.test((row.city as string).trim()) || (row.address as string).trim().length < 5 || (row.address as string).length > 500 ||
      !/^[a-f\d]{24}$/i.test(row.planId as string) || !/^[a-f\d]{64}$/.test(row.planFingerprint as string) || row.businessPhone !== undefined && (typeof row.businessPhone !== "string" || row.businessPhone.length > 30) ||
      row.password !== undefined && (typeof row.password !== "string" || Buffer.byteLength(row.password, "utf8") > 72)) throw bad();
  if (row.password && !validatePasswordStrength(row.password as string).valid) throw new CommandError(400, validatePasswordStrength(row.password as string).reason || "Choose a strong password for a new account");
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, typeof item === "string" && key !== "password" ? (key === "email" || key === "planId" ? item.trim().toLowerCase() : item.trim()) : item])) as unknown as PharmacyOnboardingInput;
}
export function onboardingProof(value: unknown, extra: "otp" | "none" = "none") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommandError(400, "The original setup proof is required");
  const row = value as Record<string, unknown>, keys = ["requestId", "setupToken", ...(extra === "otp" ? ["otp"] : [])];
  if (Object.keys(row).some(key => !keys.includes(key)) || typeof row.requestId !== "string" || !/^[a-f\d]{24}$/i.test(row.requestId) || typeof row.setupToken !== "string" || !/^[a-f\d]{64}$/.test(row.setupToken) || extra === "otp" && (typeof row.otp !== "string" || !/^\d{6}$/.test(row.otp))) throw new CommandError(400, "The original setup proof and six-digit code are required");
  return row as { requestId: string; setupToken: string; otp?: string };
}
