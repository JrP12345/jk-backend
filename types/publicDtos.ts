/**
 * Explicit Data Transfer Objects (DTOs) for Public-Facing Endpoints.
 *
 * SEC-001 Remediation: Ensures internal organization secrets (SMTP credentials,
 * WhatsApp Cloud API tokens, webhook secrets, tax IDs, internal subscription limits)
 * can NEVER leak across the public API boundary.
 */

import { organizationImageReference } from "../services/OrganizationBranding.ts";

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
  countryCode?: string | null;
  timezone?: string;
  isActive: boolean;
}

export interface PublicOrganizationDetail extends PublicOrganizationSummary {
  doctors?: any[];
  locations?: any[];
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
    image_url: organizationImageReference(doc, "image_url"),
    logo_url: organizationImageReference(doc, "logo_url"),
    images: Array.isArray(doc.images) ? doc.images.map((_: string, index: number) => organizationImageReference(doc, index)).filter(Boolean) : [],
    timings: doc.timings || "",
    working_days: doc.working_days || "",
    currency: doc.currency || "INR",
    countryCode: doc.countryCode || null,
    timezone: doc.timezone || "Asia/Kolkata",
    isActive: doc.isActive !== false,
  };
}

export function toPublicOrganizationDetail(
  raw: any,
  doctors: any[] = [],
  locations: any[] = []
): PublicOrganizationDetail {
  const summary = toPublicOrganizationSummary(raw);
  return {
    ...summary,
    doctors,
    locations,
  };
}

/** Public facility fields are opt-in; operational/payment settings stay private. */
export function toPublicLocation(raw: any) {
  const location = typeof raw.toJSON === "function" ? raw.toJSON() : raw;
  return {
    id: location.id || String(location._id), name: location.name, city: location.city,
    address: location.address || "", phone: location.phone || "", email: location.email || "",
    description: location.description || "", brandColor: location.brandColor,
    latitude: location.latitude, longitude: location.longitude,
    timings: location.timings, amenities: location.amenities || [],
  };
}
