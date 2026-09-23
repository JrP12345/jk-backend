# Production Credential Rotation & Cache Invalidation SOP

**Document ID**: SEC-001-SOP  
**Classification**: Operational Security Protocol  
**Scope**: Meta WhatsApp Cloud API credentials, SMTP relay credentials, edge & application caches  

---

## 1. Context & Security Notice

Prior to remediation **SEC-001**, the public directory endpoints (`GET /api/public/organizations` and `GET /api/public/organizations/:id`) returned unprojected Organization documents. Any dedicated WhatsApp Access Tokens (`whatsappConfig.accessToken`) or custom SMTP passwords (`smtp.pass`) stored prior to this patch must be considered potentially compromised in public log indexing or downstream caching layers.

Follow this procedure to rotate all credentials and invalidate public response caches.

---

## 2. Meta WhatsApp Cloud API Credential Rotation

For any organization configured with `whatsappConfig.mode = "dedicated"`:

### Step 2.1: Generate New System User Access Token
1. Log in to [Meta Business Manager](https://business.facebook.com/).
2. Navigate to **Business Settings** > **Users** > **System Users**.
3. Select the System User associated with your WhatsApp Business Account (WABA).
4. Click **Generate New Token**.
5. Select the relevant Meta App ID.
6. Verify required permissions are checked:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
7. Set token expiration according to security policy (recommend Permanent System User token).
8. Copy the generated access token securely.

### Step 2.2: Apply New Token to Platform
1. Log in to the healthcare platform as an authorized Organization Admin or Root Administrator.
2. Navigate to **Settings** > **WhatsApp Configuration** or execute authorized PUT:
   ```http
   PUT /api/organization/whatsapp
   Authorization: Bearer <AdminJWT>
   Content-Type: application/json

   {
     "accessToken": "<NEW_META_ACCESS_TOKEN>"
   }
   ```
3. Verify that the response returns HTTP 200 without exposing the token.

### Step 2.3: Revoke Old Token
1. In Meta Business Manager, locate the previously active token or revoke older access tokens for the System User once outbound test messages succeed.
2. Confirm the token revocation via Meta Graph API debug endpoint:
   ```bash
   curl -G "https://graph.facebook.com/debug_token?input_token=<OLD_TOKEN>&access_token=<APP_ACCESS_TOKEN>"
   ```

---

## 3. Custom SMTP Relay Credential Rotation

For any organization configured with custom SMTP credentials (`smtp.host`, `smtp.user`, `smtp.pass`):

### Step 3.1: Issue New SMTP Password
1. In your email provider console (AWS SES, SendGrid, Postmark, Google Workspace, or self-hosted Postfix):
   - Generate a new dedicated SMTP password / API key.
   - Restrict sending domains strictly to the organization's verified domain.

### Step 3.2: Update Stored Organization SMTP Configuration
1. In the platform dashboard, navigate to **Settings** > **Email / SMTP Gateway** or execute authorized PUT:
   ```http
   PUT /api/onboarding/organization/me/smtp
   Authorization: Bearer <AdminJWT>
   Content-Type: application/json

   {
     "host": "smtp.yourprovider.com",
     "port": 587,
     "secure": false,
     "user": "smtp-user",
     "pass": "<NEW_SMTP_PASSWORD>",
     "fromEmail": "notifications@yourdomain.com",
     "fromName": "Healthcare Facility Notifications"
   }
   ```
2. Trigger a test email:
   ```http
   POST /api/notifications/test-email
   Authorization: Bearer <AdminJWT>
   Content-Type: application/json

   {
     "recipient": "security-verify@yourdomain.com"
   }
   ```
3. Confirm reception of the test notification.

### Step 3.3: Revoke Old SMTP Password
1. Terminate/delete the previous SMTP credential set in the email service provider console.

---

## 4. Cache Invalidation SOP

Because public endpoints were previously serving unprojected documents, any intermediate HTTP or reverse proxy cache must be purged immediately following deployment.

### Step 4.1: Edge / CDN Cache Purge (Cloudflare / CloudFront)
Purge URLs matching the following patterns:
- `/api/public/organizations*`
- `/api/public/clinics*`

Via Cloudflare API example:
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/purge_cache" \
     -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"prefixes": ["api/public/organizations", "api/public/clinics"]}'
```

### Step 4.2: Redis Cache Eviction (if applicable)
If Redis is used to cache public organization responses, issue targeted eviction:
```bash
redis-cli --scan --pattern "cache:public:org:*" | xargs redis-cli del
redis-cli --scan --pattern "cache:public:clinic:*" | xargs redis-cli del
```

### Step 4.3: Reverse Proxy (Nginx) Cache Purge
If Nginx `proxy_cache` is enabled:
```bash
rm -rf /var/cache/nginx/public_api/*
nginx -s reload
```

---

## 5. Verification Checklist

- [x] Mongoose `OrganizationSchema` enforces `select: false` on `smtp.pass` and `whatsappConfig.accessToken`.
- [x] Schema `toJSON` transform explicitly purges credentials if loaded in memory.
- [x] Public endpoints (`getOrganizations`, `getOrganizationDetails`, `getPublicClinics`, `getPublicClinicDetails`) use strict projection and DTO mappers.
- [x] Vitest regression suite `tests/publicOrganizationDto.test.ts` validates zero secret exposure in raw response bodies.
- [ ] Production operators executed Meta token rotation.
- [ ] Production operators executed SMTP credential rotation.
- [ ] Edge CDN caches purged for public organization and clinic endpoints.
