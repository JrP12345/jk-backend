import { Role } from "../models/Role.ts";
import { ADMIN_PERMISSIONS, BUILTIN_ROLE_PERMISSIONS, DOCTOR_PERMISSIONS, RECEPTIONIST_PERMISSIONS, NURSE_PERMISSIONS, LAB_TECH_PERMISSIONS, PHARMACIST_PERMISSIONS, CASHIER_PERMISSIONS, LOCATION_MANAGER_PERMISSIONS, PATIENT_PERMISSIONS, FAMILY_MEMBER_PERMISSIONS } from "../utilities/permissions.ts";

export async function seedDefaultRoles(session?: any) {
  const defaultRoles = [
    {
      name: "admin",
      description: "Full-access system administrator. Manages all organizational resources.",
      isSystemRole: true,
      permissions: ADMIN_PERMISSIONS,
    },
    {
      name: "location_manager",
      description: "Practice desk operator (OPD Queue, Pharmacy, Cashier).",
      isSystemRole: true,
      permissions: LOCATION_MANAGER_PERMISSIONS,
    },
    {
      name: "doctor",
      description: "Clinical physician with access to EHR, prescriptions, and appointments.",
      isSystemRole: true,
      permissions: DOCTOR_PERMISSIONS,
    },
    {
      name: "receptionist",
      description: "Front-desk staff managing appointments, queue, billing, and admissions.",
      isSystemRole: true,
      permissions: RECEPTIONIST_PERMISSIONS,
    },
    {
      name: "nurse",
      description: "Nursing staff managing patient care, medication administration, and observations.",
      isSystemRole: true,
      permissions: NURSE_PERMISSIONS,
    },
    {
      name: "lab_tech",
      description: "Laboratory technician managing diagnostic orders and results.",
      isSystemRole: true,
      permissions: LAB_TECH_PERMISSIONS,
    },
    {
      name: "pharmacist",
      description: "Pharmacy staff managing medicine inventory and prescriptions.",
      isSystemRole: true,
      permissions: PHARMACIST_PERMISSIONS,
    },
    {
      name: "cashier",
      description: "Billing and cashier staff managing invoices and payments.",
      isSystemRole: true,
      permissions: CASHIER_PERMISSIONS,
    },
    {
      name: "patient",
      description: "Patient with access to their own health records and appointments.",
      isSystemRole: true,
      permissions: PATIENT_PERMISSIONS,
    },
    {
      name: "family_member",
      description: "Family member with limited access to patient records.",
      isSystemRole: true,
      permissions: FAMILY_MEMBER_PERMISSIONS,
    },
  ];

  for (const role of defaultRoles) {
    const opts: any = { upsert: true, returnDocument: "after" };
    if (session) opts.session = session;

    // Seed only missing global definitions. Preserve explicitly reviewed grants,
    // including empty roles and organization-specific overrides.
    await Role.findOneAndUpdate(
      { name: role.name, organizationId: null },
      {
        $setOnInsert: {
          name: role.name,
          description: role.description,
          isSystemRole: role.isSystemRole,
          organizationId: null,
          permissions: BUILTIN_ROLE_PERMISSIONS[role.name] || role.permissions,
        },
      },
      opts
    );
  }
}

