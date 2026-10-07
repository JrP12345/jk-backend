/** Facility classification for physical healthcare Locations. */
export const FACILITY_TYPES = ["clinic", "hospital", "diagnostic_center", "medical_center", "specialty_center", "other"] as const;
export type FacilityType = typeof FACILITY_TYPES[number];

export function isFacilityType(value: unknown): value is FacilityType {
  return typeof value === "string" && FACILITY_TYPES.some(type => type === value);
}

/** An unclassified location must never be inferred to be a clinic from its name. */
export function publicFacilityType(value: unknown): FacilityType | null {
  return isFacilityType(value) ? value : null;
}
