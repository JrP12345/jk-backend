export function addBillingPeriod(start: Date, cycle: "monthly" | "annual") {
  const result = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (cycle === "annual" ? 12 : 1), 1,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  result.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()));
  return result;
}
