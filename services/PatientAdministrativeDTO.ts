// Explicit administrative fields; never clinical details or login identifiers.
export function patientAdministrativeDTO(patient: any) {
  const user = patient.userId && typeof patient.userId === "object" && patient.userId.name ? patient.userId : null;
  const name = patient.name || user?.name || "Patient";
  const phone = patient.phone ?? user?.phone ?? "";
  const email = patient.email ?? user?.email ?? "";
  return {
    id: String(patient._id || patient.id), name, phone, email,
    userId: user ? { name, phone, email } : undefined,
    dob: patient.dob, gender: patient.gender, mrn: patient.mrn,
    accountType: patient.accountType, createdAt: patient.createdAt,
  };
}
