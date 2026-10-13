export const CRM_PERMISSION_CATALOG = [
  { code: "VIEW_CRM", name: "View patient relationships", description: "Read authorized administrative CRM context" },
  { code: "MANAGE_CRM_INQUIRIES", name: "Manage inquiries", description: "Capture and progress authorized inquiries" },
  { code: "MANAGE_CRM_TASKS", name: "Manage CRM tasks", description: "Work on owned or explicitly authorized tasks" },
  { code: "ASSIGN_CRM_TASKS", name: "Assign CRM tasks", description: "Assign and reassign work in the permitted scope" },
  { code: "COMMUNICATE_PATIENTS", name: "Communicate with patients", description: "Request communications subject to consent and recipient policy" },
  { code: "RECORD_COMMUNICATION_CONSENT", name: "Record communication choices", description: "Record attributable patient instructions and evidence" },
  { code: "VIEW_CRM_ANALYTICS", name: "View CRM analytics", description: "Read permitted operational aggregates" },
  { code: "EXPORT_CRM", name: "Export CRM data", description: "Export authorized administrative information" },
  { code: "MANAGE_CRM_SETTINGS", name: "Manage CRM settings", description: "Configure permitted workflow defaults" },
  { code: "REVIEW_PATIENT_IDENTITY", name: "Review patient identity", description: "Review identity conflicts without automatically merging records" },
  { code: "RESOLVE_PATIENT_DUPLICATES", name: "Resolve patient duplicates", description: "Reserved for reviewed duplicate resolution; does not grant clinical access" },
].map(permission => ({ ...permission, category: "Patient relationships & CRM" }));

const ownWork = ["VIEW_CRM", "MANAGE_CRM_TASKS", "COMMUNICATE_PATIENTS", "RECORD_COMMUNICATION_CONSENT"];
export const CRM_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...ownWork, "MANAGE_CRM_INQUIRIES", "ASSIGN_CRM_TASKS", "VIEW_CRM_ANALYTICS", "MANAGE_CRM_SETTINGS", "REVIEW_PATIENT_IDENTITY"],
  location_manager: [...ownWork, "MANAGE_CRM_INQUIRIES", "ASSIGN_CRM_TASKS", "VIEW_CRM_ANALYTICS"],
  receptionist: [...ownWork, "MANAGE_CRM_INQUIRIES"],
  doctor: [...ownWork, "VIEW_CRM_ANALYTICS"],
  nurse: [...ownWork],
};
