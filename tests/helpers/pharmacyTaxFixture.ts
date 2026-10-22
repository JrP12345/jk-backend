import mongoose from "mongoose";
import { PharmacyTaxProfile } from "../../models/PharmacyTaxProfile.ts";
import { Location } from "../../models/Location.ts";
import { Organization } from "../../models/Organization.ts";
import { Medicine } from "../../models/Medicine.ts";

// Synthetic test evidence only. No production issuer or professional approval is created.
export async function pharmacyTaxFixture(locationId: string, medicineIds: string[], actorId = new mongoose.Types.ObjectId().toString()) {
  const location = await Location.findById(locationId);
  if (!location) throw new Error("Synthetic tax fixture location missing");
  await Organization.updateOne({ _id: location.organizationId }, { $set: { countryCode: "IN", currency: "INR" } });
  if (!await PharmacyTaxProfile.exists({ locationId })) await PharmacyTaxProfile.create({ organizationId: location.organizationId, locationId, revision: 1,
    registration: "unregistered", legalName: "Synthetic pharmacy issuer", address: "Synthetic branch address, Pune", stateCode: "27",
    drugLicenceNumbers: ["SYNTHETIC-TEST-LICENCE"], authorisedSignatory: "Synthetic signatory", reviewReference: "Synthetic test review - not professional approval",
    pricesIncludeTax: true, minimumHsnDigits: 4, electronicReportingRequired: false, confirmedBy: actorId, confirmedAt: new Date() });
  for (const id of medicineIds) {
    const medicine = await Medicine.findById(id);
    if (!medicine) throw new Error("Synthetic tax fixture medicine missing");
    await Medicine.updateOne({ _id: id }, { $set: { taxRevision: 1, taxClassification: { hsnCode: medicine.hsnCode,
      unitCode: "NOS", gstRate: medicine.gstRate, treatment: medicine.gstRate > 0 ? "taxable" : "nil_rated",
      reviewReference: "Synthetic classification review", confirmedBy: actorId, confirmedAt: new Date() } } });
  }
}
