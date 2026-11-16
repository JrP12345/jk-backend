import mongoose from "mongoose";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";

/** Must run in the supply/review transaction: revocation shares these write locks. */
export async function qualifyPharmacyProfessional(organizationId: string, locationId: string, userId: string, profession: "pharmacist" | "prescriber") {
  requireStockTransaction((mongoose as any).transactionAsyncLocalStorage?.getStore()?.session || null);
  const member = await OrgMember.findOneAndUpdate({ organizationId, userId, role: { $nin: ["patient", "family_member", "guest"] },
    ...(profession === "pharmacist" ? { $or: [{ "locationAccess.mode": "all" }, { "locationAccess.mode": "selected", "locationAccess.locationIds": locationId }] } : {}) }, { $inc: { __v: 1 } });
  const person = await User.findOneAndUpdate({ _id: userId, isActive: true }, { $inc: { __v: 1 } });
  const qualification = await PharmacyProfessionalReview.findOneAndUpdate({ organizationId, locationId, userId, profession, active: true, validUntil: { $gt: new Date() }, confirmedBy: { $exists: true }, confirmedAt: { $exists: true } }, { $inc: { __v: 1 } });
  if (!member || !person || !qualification || !genuineDetail(person.name) || ![qualification.registrationNumber, qualification.council, qualification.address, qualification.reviewReference].every(genuineDetail)) throw new CommandError(409, "Current reviewed professional registration and branch membership are required");
  return { person, qualification };
}
