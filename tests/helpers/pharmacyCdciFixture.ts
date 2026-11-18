import { strToU8, zipSync } from "fflate";

/** Synthetic format fixtures only. No distributed SNOMED/CDCI drug content. */
export const syntheticCdciFiles: Record<string, string> = {
  "BrandMaster.txt": "Identifier\tBrand Name\tProduct Identifier\tSupplier Identifier\tGeneric Identifier\tLicense Number\tLicense Status\tExcipient\tlast_updated_on\n000700\tSynthetic Brand 10 mg tablet\t300\t400\t200\t\tUNKNOWN\t\t20260819\t\n",
  "GenericMaster.txt": "Identifier\tGeneric Name\tSubstance Identifier\tRoute of Administration\tDose Form\tTherapeutic Role\tIndication\tContra Indication\tInteraction with Drugs\tClassification of Drugs\tSource/ Regulatory\tlast_updated_on\n200\tSynthetic salt A 10 mg + synthetic salt B 5 mg tablet\t100+101\t600\t500\t\t\t\t\t\t\t20260801\t\n",
  "ProductMaster.txt": "Identifier\tProduct Name\n300\tSynthetic Brand\t\n",
  "SupplierMaster.txt": "Identifier\tSupplier Name\tCountry\n400\tSynthetic supplier\tIndia\t\n",
  "SubstanceMaster.txt": "Identifier\tSubstance Name\tCAS Number\tUNII\tSubstance Description\tMolecular Weight\tToxicity\tSMILE\tInChI\tIUPAC Name\tMolecular Formula\tlast_updated_on\n100\tSynthetic salt A\t\t\t\t\t\t\t\t\t\t20260801\t\n101\tSynthetic salt B\t\t\t\t\t\t\t\t\t\t20260801\t\n",
  "DrugFormMaster.txt": "Id\tDose Form\n500\tSynthetic oral tablet\n",
  "RouteOfAdministrationMaster.txt": "Identifier\tRouteOfAdministration\n600\tSynthetic oral route\n",
  "License.txt": "Synthetic test fixture only. Common Drug Codes for India C-DAC format marker. No real terminology or permission grant."
};
export function syntheticCdciZip(overrides: Record<string, string | null> = {}) {
  const files = { ...syntheticCdciFiles, ...overrides };
  return zipSync(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null).map(([file, source]) => [`package/${file}`, strToU8(source)])));
}
