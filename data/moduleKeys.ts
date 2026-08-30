/**
 * Module Keys — Single Source of Truth
 *
 * This shared constant defines every toggleable module in the platform.
 * Used by both backend (seeding, guard middleware) and frontend (sidebar, settings UI).
 *
 * Each module has:
 *  - route:     The frontend dashboard route
 *  - priority:  P1 (clinic essential), P2 (important), P3 (hospital/specialty)
 *  - label:     Human-readable display name
 *  - alwaysOn:  If true, module cannot be disabled (e.g., Dashboard, Settings)
 */

export interface ModuleDefinition {
  route: string;
  priority: "P1" | "P2" | "P3";
  label: string;
  alwaysOn?: boolean;
  description?: string;
  section?: string;
}

export const MODULE_KEYS: Record<string, ModuleDefinition> = {
  // ─── P1 — Clinic Essentials ──────────────────────────────────────
  "dashboard":       { route: "/dashboard",              priority: "P1", label: "Dashboard Overview",    alwaysOn: true, section: "Core Workspace",         description: "Main dashboard with overview metrics and quick actions" },
  "notifications":   { route: "/dashboard/notifications", priority: "P1", label: "Notifications",        alwaysOn: true, section: "Core Workspace",         description: "System notifications and alerts center" },
  "settings":        { route: "/dashboard/settings",      priority: "P1", label: "System Settings",      alwaysOn: true, section: "Administration",         description: "Organization, AI, notification, and billing settings" },
  "appointments":    { route: "/dashboard/appointments",  priority: "P1", label: "Appointments",                        section: "Outpatient (OPD)",       description: "Schedule and manage patient appointments" },
  "queue":           { route: "/dashboard/queue",          priority: "P1", label: "Queue Desk",                          section: "Outpatient (OPD)",       description: "Real-time patient queue management for front desk" },
  "patients":        { route: "/dashboard/patients",       priority: "P1", label: "Patients Directory",                  section: "Outpatient (OPD)",       description: "Patient registration, search, and demographic records" },
  "consultations":   { route: "/dashboard/consultations",  priority: "P1", label: "Consultations (SOAP)",                section: "Outpatient (OPD)",       description: "Clinical consultations with SOAP notes and EHR" },
  "billing":         { route: "/dashboard/billing",        priority: "P1", label: "Patient Billing",                     section: "Billing & Finance",      description: "Create, manage, and track patient invoices" },
  "pharmacy":        { route: "/dashboard/pharmacy",       priority: "P1", label: "Pharmacy Inventory",                  section: "Diagnostics & Pharmacy", description: "Medicine stock management, batches, and dispensing" },
  "staff":           { route: "/dashboard/staff",          priority: "P1", label: "Staff Accounts",                      section: "Administration",         description: "Manage doctors, nurses, receptionists, and other staff" },
  "clinics":         { route: "/dashboard/clinics",        priority: "P1", label: "Clinic Branches",                     section: "Administration",         description: "Add and manage multi-location clinic branches" },

  // ─── P2 — Important / Extended ────────────────────────────────────
  "laboratory":      { route: "/dashboard/laboratory",     priority: "P2", label: "Laboratory & LIS",                   section: "Diagnostics & Pharmacy", description: "Lab test ordering, sample tracking, and result management" },
  "radiology":       { route: "/dashboard/radiology",      priority: "P2", label: "Radiology & PACS",                   section: "Diagnostics & Pharmacy", description: "Imaging orders, radiology reports, and PACS integration" },
  "analytics":       { route: "/dashboard/analytics",      priority: "P2", label: "Analytics",                          section: "Core Workspace",         description: "Operational and financial analytics dashboards" },
  "service-catalog": { route: "/dashboard/billing/services", priority: "P2", label: "Service Catalog",                  section: "Billing & Finance",      description: "Define and manage billable services and pricing" },
  "insurance":       { route: "/dashboard/insurance",      priority: "P2", label: "Insurance & Claims",                 section: "Billing & Finance",      description: "Insurance tariffs, claims processing, and pre-authorization" },
  "teleconsultation": { route: "/dashboard/teleconsultation", priority: "P2", label: "Teleconsultation",                section: "Outpatient (OPD)",       description: "Video consultations with virtual waiting rooms" },
  "shifts":          { route: "/dashboard/shifts",          priority: "P2", label: "Shift Roster",                      section: "Administration",         description: "Staff shift scheduling and roster management" },
  "audit":           { route: "/dashboard/audit",           priority: "P2", label: "Audit Logs",                        section: "Administration",         description: "System-wide audit trail and activity logging" },
  "feedback":        { route: "/dashboard/feedback",       priority: "P2", label: "Patient Feedback",                   section: "Administration",         description: "Collect and analyze patient experience feedback" },
};

/** All module key strings */
export type ModuleKey = keyof typeof MODULE_KEYS;

/** Get all module keys of a given priority */
export function getModulesByPriority(priority: "P1" | "P2" | "P3"): string[] {
  return Object.entries(MODULE_KEYS)
    .filter(([, def]) => def.priority === priority)
    .map(([key]) => key);
}

/** Get module keys that are always on and cannot be disabled */
export function getAlwaysOnModules(): string[] {
  return Object.entries(MODULE_KEYS)
    .filter(([, def]) => def.alwaysOn)
    .map(([key]) => key);
}
