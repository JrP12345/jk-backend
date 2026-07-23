import type { FHIRPatient } from "../types.ts";

export class PatientMapper {
  public static toFHIR(patient: any): FHIRPatient {
    const user = patient.userId || {};
    const nameStr = user.name || patient.name || "Unknown Patient";
    const nameParts = nameStr.split(" ");
    const family = nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameStr;
    const given = nameParts.length > 1 ? nameParts.slice(0, nameParts.length - 1) : [nameStr];

    const telecom: any[] = [];
    if (user.phone || patient.phone) {
      telecom.push({ system: "phone", value: user.phone || patient.phone });
    }
    if (user.email || patient.email) {
      telecom.push({ system: "email", value: user.email || patient.email });
    }

    return {
      resourceType: "Patient",
      id: patient._id?.toString() || patient.id?.toString() || "unknown",
      active: true,
      name: [
        {
          family,
          given,
          text: nameStr,
        },
      ],
      telecom,
      gender: patient.gender ? (patient.gender.toLowerCase() as any) : "unknown",
      birthDate: patient.dob ? new Date(patient.dob).toISOString().split("T")[0] : patient.dateOfBirth ? new Date(patient.dateOfBirth).toISOString().split("T")[0] : undefined,
    };
  }
}
