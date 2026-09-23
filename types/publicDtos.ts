/**
 * Explicit Data Transfer Objects (DTOs) for Public-Facing Endpoints.
 * 
 * SEC-001 Remediation: Ensures internal organization secrets (SMTP credentials,
 * WhatsApp Cloud API tokens, webhook secrets, tax IDs, internal subscription limits)
 * can NEVER leak across the public API boundary.
 */

export interface PublicOrganizationSummary {
  id: string;
  name: string;
  address?: string;
  city: string;
  phone?: string;
  email?: string;
  description?: string;
  image_url?: string | null;
  logo_url?: string | null;
  images?: string[];
  timings?: string;
  working_days?: string;
  currency?: string;
  timezone?: string;
  isActive: boolean;
}

export interface PublicOrganizationDetail extends PublicOrganizationSummary {
  doctors?: any[];
  clinics?: any[];
}

export function toPublicOrganizationSummary(raw: any): PublicOrganizationSummary {
  if (!raw) return raw;
  const doc = typeof raw.toJSON === "function" ? raw.toJSON() : raw;
  const id = doc.id || (doc._id ? doc._id.toString() : "");

  return {
    id,
    name: doc.name || "",
    address: doc.address || "",
    city: doc.city || "",
    phone: doc.phone || "",
    email: doc.email || "",
    description: doc.description || "",
    image_url: doc.image_url || null,
    logo_url: doc.logo_url || null,
    images: Array.isArray(doc.images) ? doc.images : [],
    timings: doc.timings || "",
    working_days: doc.working_days || "",
    currency: doc.currency || "INR",
    timezone: doc.timezone || "Asia/Kolkata",
    isActive: doc.isActive !== false,
  };
}

export function toPublicOrganizationDetail(
  raw: any,
  doctors: any[] = [],
  clinics: any[] = []
): PublicOrganizationDetail {
  const summary = toPublicOrganizationSummary(raw);
  return {
    ...summary,
    doctors,
    clinics,
  };
}
