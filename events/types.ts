export type NotificationCategory =
  | "auth"
  | "organization"
  | "team"
  | "task"
  | "patient"
  | "billing"
  | "security"
  | "system";

export interface DomainEventPayload {
  eventId?: string;
  eventType: string;
  type?: string;
  category: NotificationCategory;
  organizationId?: string;
  tenantId?: string;
  createdBy?: string;
  targetUserId: string;
  title: string;
  message: string;
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
