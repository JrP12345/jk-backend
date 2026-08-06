export type NotificationCategory =
  | "auth"
  | "organization"
  | "team"
  | "task"
  | "patient"
  | "clinical"
  | "consent"
  | "labs"
  | "billing"
  | "security"
  | "system";

export interface AnantaCloudEvent<T = any> {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject: string; // Patient ID or Resource ID
  time: string;
  datacontenttype: "application/json";
  metadata: {
    tenantId: string;
    facilityId?: string;
    correlationId: string;
    actor: {
      userId: string;
      role: string;
    };
  };
  data: T;
}

export interface DomainEventPayload {
  eventId?: string;
  eventType: string;
  type?: string;
  category: NotificationCategory;
  organizationId?: string;
  tenantId?: string;
  createdBy?: string;
  targetUserId?: string;
  title?: string;
  message?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  severity?: "info" | "success" | "warning" | "error";
  actionUrl?: string;
  icon?: string;
  metadata?: Record<string, any>;
  channels?: {
    email?: boolean;
    inApp?: boolean;
    push?: boolean;
    sms?: boolean;
  };
}

export const EVENT_TYPES = {
  // ANANTA Architecture Domain Events
  PATIENT_REGISTERED: "ananta.patient.registered",
  CONSENT_GRANTED: "ananta.consent.granted",
  CONSENT_REVOKED: "ananta.consent.revoked",
  CONSENT_BREAK_GLASS: "ananta.consent.break_glass",
  CLINICAL_ENCOUNTER_STARTED: "ananta.clinical.encounter.started",
  CLINICAL_ENCOUNTER_COMPLETED: "ananta.clinical.encounter.completed",
  CLINICAL_NOTE_SIGNED: "ananta.clinical.note.signed",
  CLINICAL_PRESCRIPTION_SIGNED: "ananta.clinical.prescription.signed",
  DOCUMENT_UPLOADED: "ananta.document.uploaded",
  DOCUMENT_OCR_COMPLETED: "ananta.document.ocr_completed",
  LAB_RESULT_VERIFIED: "ananta.lab.result_verified",

  // Auth
  AUTH_LOGIN_NEW_DEVICE: "AUTH_LOGIN_NEW_DEVICE",
  AUTH_PASSWORD_CHANGED: "AUTH_PASSWORD_CHANGED",
  AUTH_EMAIL_VERIFIED: "AUTH_EMAIL_VERIFIED",

  // Organization
  ORG_CREATED: "ORG_CREATED",
  ORG_MEMBER_INVITED: "ORG_MEMBER_INVITED",
  ORG_INVITE_ACCEPTED: "ORG_INVITE_ACCEPTED",
  ORG_MEMBER_REMOVED: "ORG_MEMBER_REMOVED",
  ORG_ROLE_CHANGED: "ORG_ROLE_CHANGED",

  // Tasks
  TASK_ASSIGNED: "TASK_ASSIGNED",
  TASK_MENTIONED: "TASK_MENTIONED",
  TASK_DUE_TODAY: "TASK_DUE_TODAY",
  TASK_OVERDUE: "TASK_OVERDUE",
  TASK_STATUS_CHANGED: "TASK_STATUS_CHANGED",

  // Healthcare / Patient
  PATIENT_APPOINTMENT_BOOKED: "PATIENT_APPOINTMENT_BOOKED",
  PATIENT_APPOINTMENT_CHECKED_IN: "PATIENT_APPOINTMENT_CHECKED_IN",
  PATIENT_APPOINTMENT_CANCELLED: "PATIENT_APPOINTMENT_CANCELLED",
  PATIENT_CALL_NEXT: "PATIENT_CALL_NEXT",
  PATIENT_LAB_RESULT_READY: "PATIENT_LAB_RESULT_READY",
  PATIENT_CRITICAL_ALERT: "PATIENT_CRITICAL_ALERT",

  // Billing
  BILLING_TRIAL_ENDING: "BILLING_TRIAL_ENDING",
  BILLING_PAYMENT_FAILED: "BILLING_PAYMENT_FAILED",
  BILLING_INVOICE_GENERATED: "BILLING_INVOICE_GENERATED",

  // Security
  SECURITY_SUSPICIOUS_LOGIN: "SECURITY_SUSPICIOUS_LOGIN",
  SECURITY_MFA_TOGGLED: "SECURITY_MFA_TOGGLED",

  // System
  SYSTEM_ALERT: "SYSTEM_ALERT",
  SYSTEM_MAINTENANCE: "SYSTEM_MAINTENANCE",
} as const;

