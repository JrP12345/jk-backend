import { PharmacyProfessionalReview } from "../../models/PharmacyProfessionalReview.ts";
import { Medicine } from "../../models/Medicine.ts";
import { Doctor } from "../../models/Doctor.ts";
import { OrgMember } from "../../models/OrgMember.ts";

/** Synthetic assertions only. Never a production registration or professional approval. Call before sealing Rx. */
export async function pharmacyRestrictedFixture(locationId: string, medicineId: string, organizationId: string, doctorId: string, actorId: string) {
  await Doctor.updateOne({ userId: doctorId }, { $setOnInsert: { userId: doctorId, organizationId, registrationNumber: "SYNTHETIC-RMP-001", isActive: true } }, { upsert: true });
  await OrgMember.updateOne({ userId: doctorId, organizationId }, { $setOnInsert: { role: "doctor", locationAccess: { mode: "all" } } }, { upsert: true });
  const doctor = await Doctor.findOne({ userId: doctorId });
  const professionals: Array<[string, "prescriber" | "pharmacist", string]> = [[doctorId, "prescriber", doctor!.registrationNumber!], [actorId, "pharmacist", "SYNTHETIC-PHARM-001"]];
  for (const [userId, profession, registrationNumber] of professionals) {
    await PharmacyProfessionalReview.updateOne({ organizationId, locationId, userId, profession }, { $set: {
      registrationNumber, council: "Synthetic test council", address: "Synthetic reviewed professional address",
      reviewReference: "Synthetic evidence; no real professional approval", validUntil: new Date("2099-12-31"), active: true,
      revision: 1, confirmedBy: actorId, confirmedAt: new Date(),
    } }, { upsert: true });
  }
  const medicine = await Medicine.findById(medicineId);
  await Medicine.updateOne({ _id: medicineId }, { $set: { dispensingRevision: 1, dispensingReview: {
    scheduleType: medicine!.scheduleType, reviewReference: "Synthetic sale restriction review", confirmedBy: actorId, confirmedAt: new Date(),
  } } });
}
