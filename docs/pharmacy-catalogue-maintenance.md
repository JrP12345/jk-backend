# Reviewed catalogue maintenance and branch sale holds

These controls reuse `PharmacyGlobalProduct`, `Medicine`, `MedicineBatch`, `Location` and the required `AuditLog`. They do not change physical quantities. There is no automated legal-ban feed or fuzzy medicine matching.

## Source reference availability

Prepare a private JSON file after reviewing the **exact** source identity and current revision:

```json
{
  "productId": "actual-global-product-object-id",
  "expectedRevision": 1,
  "status": "withdrawn",
  "reason": "Actual reviewed reason",
  "reviewReference": "Actual source notice / review evidence",
  "confirmed": true
}
```

Allowed statuses are `available`, `withdrawn`, `discontinued`. The latter two remove a reference from new search/adoption. They do **not** block a branch's existing medicine: use a separate reviewed branch sale hold when appropriate. An existing branch link remains available through its normal stock/billing controls. Future provider ingestion leaves the independent maintenance status intact; new/corrected identity data continue through the existing rights-reviewed importer.

Validate disconnected, without database writes:

```powershell
node --experimental-strip-types scripts/import-pharmacy-catalogue.ts <review.json> --maintenance
```

Apply only to the deliberately selected database, after inspecting the preview:

```powershell
node --env-file=.env --experimental-strip-types scripts/import-pharmacy-catalogue.ts <review.json> --maintenance --apply --actor=<active-root-id>
```

The command checks the existing unique source index, active root, exact revision and required audit in a majority transaction. Stale/uncertain commands require reading the current revision before retrying; do not substitute a new revision without review. Normal source imports retain licence evidence and the CDCI approval gate. Maintenance grants no new data usage rights.

## Branch product and batch sale holds

Inventory → product actions → **Product / batch sale holds**. Changes require `MANAGE_ORGANIZATION`; reads use existing stock-view authority and branch/tenant isolation. Batch pages contain at most 25 records.

Endpoints:

- `GET /api/pharmacy/medicines/:id/sale-controls?locationId=...&cursor=...`
- `PUT /api/pharmacy/medicines/:id/sale-control`
- `PUT /api/pharmacy/batches/:id/sale-control`

PUT fields are `locationId`, `expectedRevision` (zero if never controlled), `blocked`, `reason` (3–500 characters), `reviewReference` (3–200), `confirmed: true`. Unknown fields, noninteger revisions and control characters are rejected. Every change records actor/time/revision and required audit evidence. Releasing one control does not erase another control, dispensing classification, expiry or quarantine. Physical isolation remains an operator task.

## Offline behavior

An administrator may apply a hold while an original PC owns branch stock. New authenticated snapshots omit held supply. Holds after preparation refuse activation. An authenticated counter background check uses:

`GET /api/pharmacy/locations/:locationId/offline-authority/:authorityId/sale-control-status`

The response binds authority and original manifest digest; it is `no-store`. New issuance stops durably when controls changed after preparation (or the current preparation cannot be verified). Save does not wait for this network call. Checks are throttled to 30 seconds and timeout after 8 seconds; connectivity/authentication failures retain the last successful check, not a false freshness claim. The signed-out restart shell has no authenticated live check and says so explicitly.

Original signed receipts issued **before** a later hold remain importable. Receipts issued **during** the active hold retain their financial/stock evidence for review; no automatic renumbering, repricing, acknowledgement or evidence deletion occurs. Hold release is refused until the original offline session is reconciled/closed, preserving its relevant active-hold interval. Repeated block reviews preserve the original hold start. No retroactive effective-date entry is implemented.

Contact a disconnected PC's operator immediately. It cannot learn a new hold without communication. A later catalogue refresh or source maintenance action cannot clear a branch hold. Existing parcels check original batches again at handover; held in-transit goods can be received into quarantine, preserving custody.
