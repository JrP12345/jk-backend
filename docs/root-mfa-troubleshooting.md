# Root authenticator codes rejected in production

Investigated on 2026-09-27. A read-only check against the database configured in
the workspace backend confirmed that the affected root account had a legacy
three-part hexadecimal encryption envelope. The deployed service's environment
has not been independently checked.

## Confirmed format regression and recovery

SEC-003 replaced the historical encryption reader with the `enc:v1:` reader
without retaining support for previously stored three-part envelopes. Login
therefore treated an encrypted historical secret as plaintext and rejected its
format. The secret was not deleted. The restored reader successfully decrypted
the affected account's original secret using its existing `ENCRYPTION_KEY`.

The reader now recognizes historical envelopes and verifies their AES-GCM
authentication tags using the original key derivation: direct decoding for
64-character hexadecimal keys, otherwise SHA-256 of `ENCRYPTION_KEY`. Current
envelopes continue to use the current key precedence and scrypt derivation.
Missing/wrong historical keys and tampered ciphertext fail closed. New secrets
continue to be stored in `enc:v1:` format.

At the user's request, the affected root secret was replaced in the configured
database and a local enrollment QR was created. The previous authenticator
entry must be replaced. Production shares that reset only if it uses the same
database, and must use the matching encryption configuration.

For local enrollment, `ROOT_2FA_QR_PATH` can select a PNG file instead of terminal
QR output. The setup script prepares the QR before saving the replacement and
removes the file if the database save fails. Delete the QR after enrollment.

The application uses the same base32 TOTP secret in its QR URL and verifier,
with six digits, SHA-1 and a 30-second period. Verification already accepts
plus/minus six periods (180 seconds); increasing tolerance is not a repair for
a different secret or an unreadable encrypted value.

## Confirmed misleading error and local repair

Field decryption returns `[DECRYPTION_FAILED]` when the encryption key or
authentication tag does not match. Login previously passed this sentinel into
TOTP verification and reported `Invalid two-factor code`. Login now refuses to
issue a session and reports a configuration failure instead. Server logs record
`mfa_secret_decryption_failed` or `mfa_secret_format_invalid`, with no OTP,
secret, ciphertext or encryption key. Ordinary wrong codes remain 401 responses.

The root setup script now accepts the same encryption-key variable names as
the encryption utility. Effective key precedence remains:
`DATA_ENCRYPTION_KEY` → `ENCRYPTION_KEY` → `APP_ENCRYPTION_KEY`.
This change does not rotate a key or MFA secret and preserves stored data.

## Read-only production check

After deploying these changes, run this in the backend service's shell with
the service's existing database and environment variables:

```sh
npm run check:root-2fa:production
```

If more than one active root exists, configure `ROOT_ADMIN_EMAIL` to select
the intended account. The check performs no writes, prints no secret/QR/code,
reports whether the saved secret is readable, the effective key variable name
and current server UTC. It does not establish that the phone has the same secret.

| Result | Next step |
| --- | --- |
| `MFA_SECRET_DECRYPTION_FAILED` | Check which encryption key originally stored the secret. In particular, a newly added `DATA_ENCRYPTION_KEY` overrides `ENCRYPTION_KEY`. Restore the original effective key if it was accidentally changed; investigate damaged ciphertext. Do not generate another encryption key as a repair. |
| `MFA_SECRET_FORMAT_INVALID` | The stored value is not usable as a base32 authenticator secret. Investigate prior setup/imports; controlled MFA re-enrollment may be required. |
| No matching active root | Confirm the deployed database, account email and active root role. A QR provisioned against a local database does not configure production. |
| `MFA_CONFIG_READABLE` | Confirm that Google Authenticator is showing the entry for this root account. A previous `setup:root-2fa` run replaces the secret and invalidates old entries, including entries still named Ananta. Enable automatic device date/time, compare server UTC and try a fresh code after the period changes. |
| Invalid/expired challenge | Sign in again to obtain a new short-lived MFA challenge; this is distinct from an invalid authenticator code. |

Google Authenticator 7.0+ uses the operating system clock; its old in-app
time-correction setting is no longer available. See
[Google's incorrect-code guidance](https://support.google.com/accounts/answer/1066447?co=GENIE.Platform%3DAndroid&hl=en).

Do not run `setup:root-2fa:production` merely to diagnose this issue: it rotates
the stored secret and requires scanning the replacement QR. No production reset
was performed during the initial diagnosis. The subsequent user-authorized reset
in the configured database is described above; no deployment was performed.

## Validation

Thirteen tests passed across `rootMfa.test.ts` and `fieldLevelEncryption.test.ts`
after the compatibility fix. They cover both historical key derivations,
missing/wrong historical keys, historical-secret production login, ciphertext
tampering refusing sessions, current encrypted-secret login, QR/secret
equivalence and field encryption. Backend TypeScript checking passed. The
read-only check after the authorized reset reported `MFA_CONFIG_READABLE`.
Phone enrollment and the deployed service environment still require verification.
