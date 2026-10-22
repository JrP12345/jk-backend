import { Organization } from "../models/Organization.ts";
import { Doctor } from "../models/Doctor.ts";
import { CommandError } from "./CommandReceiptService.ts";

/** Caller shares a transaction. The organization lock serializes concurrent seat claims. */
export async function requireDoctorCapacity(organizationId: string, actorRole?: string, existingUserId?: string) {
  const organization = await Organization.findOneAndUpdate({ _id: organizationId, isActive: { $ne: false }, status: { $ne: "inactive" } }, { $inc: { __v: 1 } });
  if (!organization) throw new CommandError(403, "Organization is unavailable");
  if (actorRole === "root") return;
  if (existingUserId && await Doctor.exists({ organizationId, userId: existingUserId, isActive: { $ne: false } })) return;
  const allowed = organization.maxDoctors ?? 2;
  if (!Number.isSafeInteger(allowed) || allowed < 0) throw new CommandError(409, "Doctor capacity requires review");
  if (await Doctor.countDocuments({ organizationId, isActive: { $ne: false } }) >= allowed) throw new CommandError(403, `Doctor count quota limit of ${allowed} reached. Review the subscription before adding a doctor.`);
}
