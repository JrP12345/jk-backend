import { toPaise } from "./pharmacyTax.ts";

export const COUNTER_PRODUCT_FIELDS = "name genericName strength manufacturer rackLocation barcodes unitDefinition stockQuantity price scheduleType dispensingRevision dispensingReview saleControl";
type Product = { _id: unknown; name: string; genericName: string; strength?: string | null; manufacturer?: string | null; rackLocation?: string | null; barcodes?: string[] | null;
  stockQuantity: number; price: number; scheduleType?: string | null; dispensingRevision?: number | null;
  saleControl?: { blocked?: boolean | null; reason?: string | null } | null;
  unitDefinition?: { version: number; baseUnit: string; packUnit: string; unitsPerPack: number } | null;
  dispensingReview?: { scheduleType?: string | null; confirmedAt?: Date | null; confirmedBy?: unknown; reviewReference?: string | null } | null };
/** Same anonymous, sale-preparation projection for lookup and offline catalogue pages. */
export function counterProduct(row: Product) {
  let retailPricePaise: number | undefined;
  try { retailPricePaise = toPaise(row.price); } catch { /* Unknown display price still requires an online quote. */ }
  return { id: String(row._id), name: row.name, genericName: row.genericName, strength: row.strength, manufacturer: row.manufacturer,
    ...(row.rackLocation ? { rackLocation: row.rackLocation } : {}),
    barcodes: row.barcodes || [], unitDefinition: row.unitDefinition, stockQuantity: row.stockQuantity, retailPricePaise,
    ...(row.saleControl?.blocked ? { saleBlocked: true, saleBlockReason: row.saleControl.reason || "Sale hold" } : {}),
    eligible: Boolean(!row.saleControl?.blocked && row.unitDefinition && row.scheduleType === "general" && row.dispensingReview?.scheduleType === "general" && row.dispensingReview.confirmedAt && row.dispensingReview.confirmedBy && row.dispensingReview.reviewReference && (row.dispensingRevision || 0) >= 1) };
}
