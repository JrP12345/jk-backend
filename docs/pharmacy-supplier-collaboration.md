# Supplier collaboration operations

Implemented on 17 November 2026. See the sibling frontend's `docs/pharmacy-supplier-ordering-2026-11-17.md` for the audit, researched workflows and full staff flow.

## Implementation

Existing branch/supplier purchase orders now support a single active expiring bearer link, replace/revoke actions, direct supplier quantity/dispatch responses and bounded private attachments. `/supplier-order#<token>` sends tokens in credential-free API POST bodies, not query/path parameters. Public endpoints use no-store/no-referrer and route rate limits. Link holders cannot access other orders, supplier finances or internal files.

Audit identity is `supplier_link_holder`, without a fabricated staff user. Staff-recorded responses keep their actual identity. Core response/dispatch rules are shared. Actual invoice/receiving quantities come from existing receiving evidence; supplier actions cannot change stock, post invoices or record payments.

Supplier workspace reads existing orders, invoices, statements, returns, actual payments/credit notes/refunds, dispatch and order attachments. It creates no second ledger. File metadata, access and latest email references are bounded fields in `PharmacyPurchaseOrder`; bytes use the existing private R2 storage. Maximum 25 PDF/image files per order, 4 MB each. Staff sharing is opt-in. A file labelled invoice or credit note is evidence, not an automatically recognized financial document.

Supplier email persists an encrypted existing outbox entry per original command key, addressed to the supplier's current saved email. Normal order projections exclude raw capabilities, storage keys and message internals. Delivery state comes from the queued entry; accepted does not mean read.

## Configuration before actual use

1. Existing MongoDB transaction/majority-write requirements and schema/index preparation apply. The order schema adds a unique sparse `supplierAccess.tokenHash` index. No database preparation, migration or backfill was run here.
2. Configure existing R2 account/access key/secret and bucket. Keep the bucket private. Downloads recheck authority before signing and force attachment disposition. They live at most 60 seconds; revocation cannot invalidate an already signed URL before its short expiry.
3. Configure existing SMTP/sender settings and an explicit public HTTPS origin in `APP_URL`. Supplier email rejects localhost/private-network addresses, credentials, paths, queries and fragments in this value in every environment. Run the existing outbound message worker. Manual links use this public origin when configured; development-only links carry a warning.
4. Issue links only after recording a real sent order. Send them to the intended supplier. Bearer access delegates control of this order; it does not verify legal business identity. Replace/revoke a link forwarded accidentally.
5. Keep purchase posting, financial confirmations and physical receiving in existing staff workflows. Review external files against actual goods before posting.

Files undergo filename/type/byte-limit/signature and active-content checks; active/encrypted/embedded-content PDFs are rejected. This does not assert an external antivirus verdict. Normal storage/database failure cleanup is implemented. An abrupt process stop between object upload and metadata commit can leave a private orphan object: retain storage inventory/maintenance procedures and never delete a potentially referenced object based only on an HTTP failure.

## Deliberate boundaries

- No supplier master catalogue, other supplier terms, patient records, stock-edit or financial authority is exposed to link holders.
- No autonomous supplier WhatsApp/SMS send, supplier authentication accounts, OCR, live distributor feed, guessed substitution or consolidated multi-order invoice allocation.
- WhatsApp is a deliberate compose/share handoff. Email is queued when configured; SMTP can redeliver after an uncertain provider response, but the link still addresses the same order.
- Supplier pending requests stay in memory for same-key retry. Staff commands use the existing encrypted journal. Neither promises finalized offline supplier ordering.
- No actual supplier email, R2 upload, development-database migration, physical printer acceptance or real-device timing was performed in verification.

## Verification

Risk level 4. Twelve focused backend collaboration cases cover encrypted/recoverable link issuance; isolated projections; expiration/replacement/revocation; disabled branches/suppliers and permissions; exact responses/dispatch and concurrency; file visibility/download/signature/type/size/deduplication/capacity; storage/audit rollback; encrypted email/current recipient/queue rollback; actual partial receiving and supplier history isolation. All pass, along with 11 existing order cases and the default security-header regression.

Eleven frontend collaboration cases cover confirmation, original-command retry/remount, internal-by-default uploads, viewers, public no-cookie/no-cache requests, supplier responses/bulk filling, unknown outcomes, closed/revoked links, consolidated records and independent return pagination. Existing purchase/order UI regressions passed too. Private storage and SMTP are mocked, not actual provider acceptance.

Backend TypeScript and executable bundles passed; frontend application types and the new-route production build passed. The frontend build used an isolated `.next` destination and a nonproduction verification API URL; it was not a deployment. Follow-up browser acceptance and provider probes are recorded below. Deployed full-stack and physical supplier/printer acceptance remain unperformed.

## Completion readiness and acceptance: 17 November 2026

Added `utilities/pharmacySupplierReadiness.ts` and the read-only operator command `npm run check:pharmacy-supplier-providers`. Configuration-only execution makes no network calls. `-- --live` uses bounded R2 bucket HEAD and SMTP verify requests. It neither sends email nor uploads/lists objects or connects to MongoDB. Output contains setting names and sanitized states, not credentials or raw provider exceptions. Exit 1 means configuration or a connection is not ready.

Actual development-environment results:

| Check | Result | Limit |
| --- | --- | --- |
| R2 bucket access | Passed | HEAD only; no proof of private policy or upload permission |
| SMTP TLS/authentication | Passed | No email sent; no inbox or worker acceptance |
| Public supplier link origin | Missing | Set the deployed HTTPS origin in `APP_URL`; supplier email stays disabled until then |
| Real Chrome component flow | Passed | Synthetic API, no real business database/provider writes |
| Physical printing/store equipment | Pending | No physical printer supplied |

Supplier collaboration now exposes configuration availability and the public link origin. Public order reads expose upload availability without exposing configuration secrets; responses/dispatch do not depend on file storage. Localhost email is rejected before queueing. Labels preserve response provenance, and mobile long-name/form overflow is fixed in the public page.

Current focused verification: 27 backend cases passed (13 collaboration integration cases and 14 readiness/checker cases), backend types/build passed, 21 frontend order/collaboration cases passed, application types and scoped lint passed. Chrome 157 verified 360/390/768/1440 px layouts, confirmation, identical retry after an uncertain response, file upload/download, revocation, staff sharing, workspace tabs and a 48-row multi-page A4 PDF. The native print dialog was simulated. The harness and artifacts are documented in the frontend report.

To activate real external use, configure the actual public HTTPS deployment origin, run the existing outbound worker and deliberately accept inbox delivery plus a real private attachment round trip. Keep the bucket private. CDCI licence approval, live distributor integrations and autonomous WhatsApp remain separate external prerequisites. No licensed dataset or distributor feed was activated by this work.

## Order-history fulfilment reconciliation

Order list responses now include the same derived fulfilment vocabulary as detail reads (`billed`, `partially_received`, `received`, or the actual supplier stage). A single aggregation for the visible page matches organization, branch and exact order IDs against posted purchases; it sums billed/free and confirmed received quantities per product. Uninvoiced orders do not require an invoice query. The existing purchase-order index is reused. Supplier stage remains a separate field, and accepted short quantities remain the expected fulfilment quantity.

The summary does not expose response prices/notes, raw invoice data, private documents or access credentials. It never updates stock or a persisted fulfilment status. Missing receipt evidence fails explicitly. Latest verification: 12 purchase-order plus 13 supplier collaboration integration cases and backend types passed, including batched list history, actual partial/full receiving and tenant boundaries. The frontend consumers and tests are covered by the updated frontend report.
