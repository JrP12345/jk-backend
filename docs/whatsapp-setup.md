# WhatsApp setup for ANANTA

The workspace WhatsApp guide is adapted to the existing Fastify, Mongoose, Next.js and outbound worker. Shared platform sending, dedicated clinic sending, notification preferences and prepaid credits remain the supported modes.

## Setup

1. Create a Meta app with WhatsApp, a WABA and a registered business phone. Assign the WABA to a system user. Generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`, and obtain the secret from the same Meta app.
2. Set the existing `DATA_ENCRYPTION_KEY` or `ENCRYPTION_KEY` before saving credentials. Keep it stable and backed up. Set `PUBLIC_API_BASE_URL` to the public HTTPS backend origin and pin `WHATSAPP_API_VERSION` (default `v25.0`). Never commit tokens or secrets.
3. Open Dashboard → Settings → WhatsApp. Root configures the shared gateway; a clinic owner can choose Dedicated WABA and save its WABA ID, phone ID, system-user token and app secret. Blank secret fields keep the saved values. WABAs cannot be reused across clinics or shared/dedicated senders.
4. Save, click **Test connection**, then **Sync templates**. Testing verifies that the phone belongs to the WABA. Credential changes reset connection state to pending. The browser receives readiness flags instead of saved tokens/secrets.
5. Copy the displayed callback URL and verify token into Meta. Subscribe to `messages`, `message_template_status_update`, `message_template_quality_update`, `template_category_update` and `message_template_components_update`. Subscribe the app to the WABA in Meta.
6. Create and approve the templates below in WhatsApp Manager and sync again. Match language (`META_WHATSAPP_LANG`, default `en`) and positional variable order. The panel lists missing/unusable templates.
7. Preview storage migration with `npm run migrate:whatsapp`, then run `npm run migrate:whatsapp -- --apply` during rollout. It encrypts legacy credentials/bodies, normalizes empty WABA IDs, checks duplicate provider IDs and creates indexes without deleting data. Production must run `npm run worker:outbound-messages` alongside the API. This worker now handles both outbound delivery and webhook processing. Development starts both inline; `RUN_INLINE_JOBS=true` enables inline processing in production as well.
8. Use a Meta-approved test recipient first. Check accepted → sent → delivered/read, STOP/START, paused templates, reconnect and provider timeout handling before enabling clinics.

For local Meta callbacks, use an HTTPS tunnel and set `PUBLIC_API_BASE_URL` to its backend origin. Meta cannot reach localhost or a private LAN address. Explicit development sandbox mode produces synthetic message IDs; missing live credentials fail instead of pretending to deliver. Sandbox mode is ignored in production.

## Template contract

Use numbered BODY variables in this order. Existing `META_WHATSAPP_*_TEMPLATE` overrides in `SmsWhatsAppService.ts` remain supported. OTP uses an AUTHENTICATION template with an OTP/copy-code button at index 0. Other clinical notifications require Meta's appropriate category and patient consent.

| Default template | Ordered BODY variables |
|---|---|
| `appointment_booking_confirmation` | patient, doctor, clinic, appointment time, token, tracker URL |
| `appointment_reminder` | patient, doctor, clinic, appointment time |
| `appointment_cancelled` | patient, doctor, clinic, appointment time |
| `consultation_completed` | patient, doctor, clinic, token, tracker URL |
| `queue_turn_approaching` | patient, token, patients ahead, doctor, tracker URL |
| `queue_delay_alert` | patient, doctor, delay minutes, tracker URL |
| `lab_results_ready` | patient, test name, tracker URL |
| `billing_receipt` | patient, invoice number, amount, tracker URL |
| `doctor_disruption_alert` | patient, doctor, clinic, appointment time, reschedule URL, cancellation URL |
| `appointment_transfer_alert` | patient, previous doctor, new doctor, clinic, token, tracker URL |
| `appointment_refund_confirmation` | patient, doctor, clinic, refund amount, refund ID |
| `otp_verification` | OTP; the button receives the same OTP |
| `document_ready` | document filename, document URL; no media HEADER |

## Delivery and privacy

- Application events persist encrypted payloads in `OutboundMessage`. A unique ledger intent is claimed before provider calls and credit reservation. Definitive failures refund shared credits; ambiguous outcomes keep the reservation for reconciliation.
- Each message POST is attempted once. Only definitive provider rejection can lead to a queue retry. Network uncertainty and recovered `sending` intents surface as `AMBIGUOUS_NETWORK` and are never automatically resent, including through operator replay. Check the patient's delivery before initiating any new message.
- Meta responses produce **accepted**, not **sent**. Verified callbacks advance ledger state atomically and capture pricing. Duplicate callbacks do not double-count delivery; late callbacks cannot downgrade read. Early callbacks without a ledger row remain queued for retry.
- Ingress verifies original raw bytes, resolves the WABA/phone owner, stores encrypted per-event jobs, then acknowledges. Unknown WABAs are dropped. Invalid signatures return 401; persistence failures return 503 so Meta can retry. Processing strips raw payloads; inbox records expire after 30 days.
- Session and consent records use sender scope plus a keyed phone hash from the existing encryption subsystem. STOP on the shared sender blocks that phone across platform sends; dedicated STOP is clinic-scoped. START explicitly restores messaging. All message types check consent. Plain text requires a patient inbound message within 24 hours; outside the window, notifications use approved templates. Explicit window-closed rejection falls back to the notification template.
- Inbound types and bodies are encrypted with 30-day retention. Non-text messages open the service window without interpreting their media. Booking sessions are encrypted in MongoDB with a 30-minute expiry. A recovered interrupted clinical command is marked uncertain instead of repeating a booking or queue mutation.
- Dedicated bot queries use the clinic's patient data. The shared bot declines to choose between multiple matching profiles. Live mode has no fallback to a global clinic or unrelated doctor roster.
- Message bodies are encrypted at rest. Settings logs show masked phones and status/error codes. Audit snapshots omit bodies, names, full phones and raw provider responses. The webhook verify token is intentionally visible for Meta setup; other secrets remain write-only.

## Documents

Real PDF links must be HTTPS and hosted under configured `PUBLIC_API_BASE_URL`, `API_BASE_URL` or `R2_CUSTOM_DOMAIN` origins. Downloads reject redirects, validate PDF MIME/signature and enforce a 10 MiB limit. Each PDF is uploaded to `/{phone}/media`; `/messages` uses the returned media ID. Upload failure falls back to a link notice inside an open session. Outside it, approved `document_ready` sends a no-file notice.

The existing prescription print endpoint returns HTML. It is shared as a secure printable link instead of a mislabeled PDF. This work does not introduce a new HTML-to-PDF renderer. The billing bot links to the authoritative tracker and no longer sends a prescription under an invoice filename.

## Project map

| Route | Access |
|---|---|
| `GET/PATCH /api/admin/whatsapp` | root shared credentials |
| `POST /api/admin/whatsapp/test` | root connection test |
| `POST /api/admin/whatsapp/templates/sync` | root template sync |
| `GET /api/admin/whatsapp/health` | root status, templates and delivery |
| `GET/PATCH /api/organization/whatsapp` | existing tenant settings permissions |
| `POST /api/organization/whatsapp/test` | organization management; shared actions require root |
| `POST /api/organization/whatsapp/templates/sync` | organization management; shared actions require root |
| `GET /api/organization/whatsapp/health` | organization management, tenant delivery |
| `GET/POST /api/webhooks/whatsapp` | verify token / raw-body HMAC |

The existing `Organization.whatsappConfig`, `OutboundMessage`, `NotificationLog`, `UsageRecord` and `AuditLog` are extended. New models: `WhatsAppAccount`, `WhatsAppTemplate`, `WhatsAppWebhookInbox`, `WhatsAppRecipient`, `WhatsAppInboundMessage`, `WhatsAppBookingSession`. Settings poll every 15 seconds and display today's counts and recent delivery records.

Optional guide features—Embedded Signup, a template editor, bulk campaigns, a staff conversation inbox, inbound media downloading and Meta cost analytics—are outside the current notification/patient-assistant workflow. Meta approval, subscription and a staging handset test remain external setup steps.

References: [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/overview), [Meta's API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [webhook statuses](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object).
