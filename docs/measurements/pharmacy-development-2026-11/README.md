# Pharmacy development evidence, November 2026

Archived during repository cleanup on 18 November. These are dated development
measurements and reviewed index definitions, not current production acceptance.
Contents are preserved from their original `.cache` files.

- `pharmacy-numbering-index-review.json`: exact obsolete and retained numbering
  index definitions reviewed before the authorized development operation.
- `pharmacy-reviewed-index-metadata.json`: exact purchase-lot and dispense-line
  definitions reviewed before the authorized development operation.
- `pharmacy-save-benchmark/`: synthetic one-, ten- and twenty-line save samples
  and competing-till integrity results. The current performance test regenerates
  local output under ignored `.cache`, without overwriting this archive.
- `pharmacy-search/benchmark.json`: dated synthetic search-plan sample.

The completed one-off index-removal scripts were retired. Use the maintained
`scripts/prepare-database-indexes.ts` and `scripts/prepare-medicine-search.ts`
for current reviewed setup; do not infer authorization to change a database from
these historical definitions. This cleanup did not execute database operations.
