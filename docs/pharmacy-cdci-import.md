# CDCI catalogue import — 16 November 2026

The owner supplied `CommonDrugCodesForIndia_FlatFilePackage.zip`. The implementation reads the actual seven-table TSV format inside that ZIP, including its trailing empty tabs and omitted empty trailing fields. It never extracts archive paths or evaluates source text. Source IDs remain strings. Header changes, duplicate IDs, invalid Unicode, unsafe archives and malformed relationships fail review; clinical names are never truncated or fuzzy-matched.

## Observed package review

| Master | Records |
| --- | ---: |
| Brand | 93,911 |
| Generic | 10,305 |
| Product | 72,284 |
| Supplier | 8,213 |
| Substance | 3,283 |
| Drug form | 423 |
| Administration route | 160 |

The exact mapping validates **93,897 branded records** and rejects **14** with missing primary product/supplier/generic references. The rejection manifest retains every affected source ID; it does not invent the missing relationships. A future apply requires explicitly reviewing those exclusions. The source's latest row update is `20260819`; this is not asserted to be the package publication date.

- ZIP SHA-256: `aebd30ac95d73accf573c86fd4dae1dc90eff03ae0fbcd312bc761011e88270a`
- `License.txt` SHA-256: `e1a39033f281c2798c5457564500efddb4862500a03753bef534bec5c1236a91`
- Mapping: `cdci-flat-2026-11-16-v1`
- Local development review artifact: `build/cdci-package-review-2026-11-16.json` (ignored; contains counts, hashes and rejection IDs, no medicine corpus).

The observed full-package check took about 12 seconds on this development machine, without connecting to MongoDB. This is package validation timing, not a billing/search benchmark.

## Publication prerequisite

The included licence identifies CC BY 4.0, permits specified distribution/derivative use within India, and subjects included SNOMED CT content to the applicable Affiliate Licence. [NRCeS FAQs](https://www.nrces.in/faqs) explicitly say an affiliate licence is required even though use within India is free. The owner confirmed **no affiliate licence is currently held**. Consequently, this task did not publish real terminology records, create live indexes, or change branch medicines, prices, batches or stock.

Affiliate registration instructions are on [NRCeS SNOMED CT](https://www.nrces.in/standards/snomed-ct). The owner's application was submitted on 16 November 2026; the dashboard showed **Submitted / Applying**. Its assigned number is not approval, and no approval is inferred from it. Review deployment geography (including hosting), SaaS/end-user sublicensing and the actual approved terms; downloading the ZIP or ticking an application checkbox does not create those rights. There is no automated provider-account registration or external messaging in this implementation.

## Mapping

- Brand identifier becomes `sourceId`; full brand name stays unchanged.
- Generic, product, supplier, substance, dose-form and route references are joined strictly by their provided identifiers and retained in `sourceIds`.
- Generic clinical name and the joined substance names are searchable. Strength stays in the original clinical names; no numeric strength is guessed into a separate verified field.
- Supplier names are stored/searchable as **supplier names**. They are not silently promoted to verified manufacturers or branch supplier-account records.
- This package supplies no verified physical pack conversion, barcode, branch price, stock, batch or expiry. These fields stay empty/explicit in the existing adoption/purchase/receiving workflows.
- Source registration/licence status is not treated as a dispensing or GST approval. No indication, contraindication, interaction or substitution engine is created.

The existing catalogue picker displays CDCI/C-DAC attribution, the CC BY 4.0 link and the SNOMED condition. Source supplier labels remain distinct from manufacturer labels. CDCI global search/adoption is scoped to India organizations as an additional application control; this does not replace affiliate/deployment review.

## Operator commands

Default is disconnected, read-only package validation:

```powershell
node scripts/import-pharmacy-cdci.ts 'C:\Users\Jay\Downloads\CommonDrugCodesForIndia_FlatFilePackage.zip' --report=build/cdci-review-new.json
```

Report files use exclusive creation, so existing evidence is not overwritten. ZIP input is bounded to 32 MB, all expanded contents to 96 MB, individual files to 32 MB and each master to 150,000 records.

Prepare a matching **unapproved** review draft at the same time, without a database connection:

```powershell
node scripts/import-pharmacy-cdci.ts 'C:\Users\Jay\Downloads\CommonDrugCodesForIndia_FlatFilePackage.zip' --report=build/cdci-activation-report.json --draft-review=build/cdci-activation-pending.json
```

The draft copies the actual package/licence hashes, mapping version and rejected source IDs. Both approval flags are `false` and evidence references are empty. Copying rejected IDs is a review aid, not confirmation that those exclusions or rights were approved. The draft cannot pass apply until actual evidence is reviewed. Output files must use new distinct paths; source packages and evidence are never overwritten. Keep completed evidence private and outside the repository. On Windows, file access follows the destination folder's ACL; do not rely on Unix file modes for confidentiality.

Check deployment readiness without importing anything (requires the selected environment and actual active root ID):

```powershell
node --env-file=.env scripts/import-pharmacy-cdci.ts 'C:\Users\Jay\Downloads\CommonDrugCodesForIndia_FlatFilePackage.zip' --check --actor=ACTUAL_ROOT_OBJECT_ID
```

This validates the package, checks transaction-capable MongoDB, active root status and current global-catalogue/medicine/user/audit indexes, and reports specific missing/conflicting metadata. It never creates collections, indexes, products, audit entries or root updates. Pending rights are reported as `rightsReady: false`, so overall `ready` remains false even if technical prerequisites pass. Exit `2` means readiness is incomplete; exit `1` means command/configuration failure. Supply `--review=<private-file>` after approval to validate evidence as well. `--check` and `--apply` are mutually exclusive; database connection attempts have bounded timeouts and errors omit connection credentials.

After actual rights approval, create a private review JSON outside the repository. These are placeholders; the approval values must not be enabled without the real evidence:

```json
{
  "packageSha256": "ACTUAL_REVIEWED_ZIP_SHA256",
  "licenceSha256": "ACTUAL_LICENCE_SHA256",
  "mappingVersion": "cdci-flat-2026-11-16-v1",
  "reviewReference": "ACTUAL_RIGHTS_REVIEW_REFERENCE",
  "snomedAffiliateReference": "ACTUAL_AFFILIATE_OR_WRITTEN_NRces_PERMISSION_REFERENCE",
  "indiaDeploymentAndUsersConfirmed": false,
  "commercialStorageAndRedistributionApproved": false,
  "excludedBrandIds": []
}
```

Copy the exact rejected IDs from the reviewed report into `excludedBrandIds`; arbitrary replacements, missing IDs or excluding valid rows are rejected. Once legally approved, use the current schema's separate database index preparation procedure, then:

```powershell
node --env-file=.env scripts/import-pharmacy-cdci.ts 'C:\approved-data\CommonDrugCodesForIndia_FlatFilePackage.zip' --apply --actor=ACTUAL_ROOT_OBJECT_ID --release=ACTUAL_REVIEWED_RELEASE_ID --review='C:\approved-data\rights-review.json'
```

Apply performs one bounded source lookup and bulk write per batch of at most 200 medicines inside the existing majority transaction and required global audit append. An active root operator is required. It checks prepared catalogue/audit indexes and never creates indexes during an import. Each completed batch is durable; if later batches fail, rerun the exact same package/review/release. Identical source rows retry unchanged; changed references increment their revisions. Clinical source names are not used as deduplication keys.

Updates affect shared reference records only. Existing branch adoption, billing, purchase, lot and stock records are not overwritten. Publication does not automatically deactivate references absent from a later package; withdrawn/missing records need an explicitly reviewed source-maintenance decision. No unverified automatic refresh schedule or licensed commercial API has been enabled.

## Activation handoff after approval

1. Retain the actual approval and agreement outside Git. Confirm applicant identity, intended pharmacy SaaS use, storage/redistribution, deployment and user geography, and end-user terms. A submitted application or affiliate number alone is insufficient. If later incorporating a separate company, confirm licence-holder/transfer requirements with NRCeS.
2. Retain the original ZIP and its actual release identification. A row's update date is not a package release date. Revalidate if the package or mapper changes. Review the rejected-source manifest and complete the private review file with real evidence references; enable rights flags only after that review.
3. Run existing index readiness `npm run db:indexes -- --check`. If setup is needed, pause development API/worker writes using the existing operating procedure, then run `npm run db:indexes -- --apply --writes-paused`. This tool never drops/replaces conflicting indexes; resolve reported conflicts explicitly. Do not run setup as part of validation or merely to obtain a green check.
4. Run CDCI `--check --actor=<id> --review=<file>`. Proceed only with `ready: true`. This is a prerequisite check, not a guarantee against a later network/server failure.
5. Run the reviewed `--apply` command with the same package, review and actual release ID. Retain final created/updated/unchanged/excluded counts and required audit evidence. On interruption, repeat those exact inputs; completed batches are retained, and retries do not duplicate identities. Do not change the release/reference solely to force a retry.
6. Verify the existing pharmacy catalogue picker: search a known source brand, generic/salt and supplier; confirm source attribution and pagination. Add one explicitly reviewed product to the intended branch and confirm zero stock, correct physical-unit conversion and the chosen branch price. Confirm another branch remains untouched. This adoption is a separate explicit action, not an automatic import effect.
7. Exercise the existing purchase-file missing-item discovery using that product, review the supplier mapping and draft, and receive only an intentional test purchase if authorized. Catalogue activation never receives stock, finalizes purchases, changes bills or overwrites batch prices.

No new provider account, paid API or application code change is normally needed for this handoff. Actual approval scope, source release and database readiness still have to be checked when available; this guide does not promise instant import or completed physical-store acceptance.

## Verification

This follow-up is risk level 4 (shared identity, tenant access and database ingestion). Focused verification passed: 47 backend cases across CDCI parsing/rights, shared catalogue adoption, existing reviewed imports and purchase CSV flows; 32 frontend cases across the existing catalogue/purchase/import consumers. Both package TypeScript checks, changed frontend file lint, repository diff checks and the API/four-worker backend build passed. Source mapping was additionally checked against every branded record in the supplied ZIP. Tests publish only synthetic fixtures into disposable MongoDB test databases; no real terminology was loaded into the development database. There was no new frontend dependency, route, configuration or build-boundary change in this follow-up.

Activation preparation adds focused synthetic command-lifecycle coverage: disconnected draft creation, non-overwrite/path/mode guards, pending/approved-evidence readiness without writes, missing-index and inactive-root refusal, partial-batch interruption/resume, idempotent reimport and preservation of branch stock/prices. These fixtures are not a real SNOMED licence or dataset approval.

### Verified preparation on 16 November 2026

- 26 distinct focused backend cases passed across `pharmacyCdci`, `pharmacyCdciActivation` and `pharmacyGlobalCatalogue`; the added standalone-transaction case was run separately after the initial 25 passed. Backend `check:fast` and both repository diff checks passed. Only backend command/test code and documentation changed in this preparation, so no frontend suite or application bundle build was repeated.
- Prepared ignored local artifacts: `build/cdci-activation-report.json`, `build/cdci-activation-pending.json`, and `build/cdci-activation-preflight.jsonl`. The pending evidence file remains unapproved; no licence secrets or clinical corpus are committed.
- The actual selected development database passed the read-only preflight: `transactionCapable: true`, `actorReady: true`, all **31 expected indexes across five models** ready, no index issues, and `databaseChanged: false`. Overall readiness remains `false` solely because `rightsReady: false`. Exit `2` is expected for that pending approval. No schema setup was needed or performed.
- The initial sandboxed network lookup timed out; the read-only preflight succeeded outside that network sandbox. No connection credentials were printed, no real terminology records were imported, and no branch adoption/stock/purchase operation was performed.

After actual approval review, recheck readiness against the then-selected database and unchanged package, complete the evidence references, import and verify the resulting real-catalogue flow. Existing technical preparation does not substitute for that final verification.
