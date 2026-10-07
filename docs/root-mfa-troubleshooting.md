# Root authenticator troubleshooting

Current contract, 2026-10-07. MFA secrets must use the current enc:v1 authenticated encryption envelope. DATA_ENCRYPTION_KEY is the only data-encryption environment variable. Plaintext or unreadable secrets refuse login without issuing a session. An ordinary incorrect authenticator code returns 401; unreadable configuration returns a configuration error without printing secret material.

## Read-only diagnosis

Run npm run check:root-2fa:production in the service environment with its existing MONGODB_URI and DATA_ENCRYPTION_KEY. ROOT_ADMIN_EMAIL selects an account when multiple active roots exist. The check performs no writes and prints no QR, secret, key or OTP.

| Result | Action |
| --- | --- |
| MFA_SECRET_DECRYPTION_FAILED | Verify the configured key and ciphertext integrity. Generating a different key does not recover encrypted data. |
| MFA_SECRET_FORMAT_INVALID | Enroll an encrypted authenticator secret through the controlled setup workflow. |
| No matching active root | Check the database, account email, active status and root role. |
| MFA_CONFIG_READABLE | Check the authenticator entry, automatic device time and server UTC. A reset replaces the secret and invalidates previous entries. |
| Expired login challenge | Sign in again for a fresh MFA challenge. |

The QR and manual enrollment use the same base32 secret. Current verification uses six digits, SHA-1, a 30-second period and the existing +/-180-second drift tolerance. A different secret is not a clock problem.

## Deliberate enrollment

setup:root-2fa requires explicit MONGODB_URI, ROOT_ADMIN_EMAIL and DATA_ENCRYPTION_KEY. Production rotation additionally requires ROOT_2FA_CONFIRM=RESET. ROOT_2FA_QR_PATH may select a PNG instead of terminal output. The script prepares the QR before saving and removes it if saving fails. Delete enrollment artifacts after use.

Development data with superseded envelopes should be reset and reenrolled through [development-data.md](development-data.md). Source cleanup does not rotate keys, reset MFA or touch a live database. Do not run enrollment as a diagnostic check.
