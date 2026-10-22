import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { CommandError } from "./CommandReceiptService.ts";

/** Readiness only. Schema setup is an explicit operator command, never a sale side effect. */
export async function requirePharmacyDispenseIndexes() {
  let indexes;
  try { indexes = await PharmacyDispense.collection.listIndexes().toArray(); }
  catch { throw new CommandError(503, "Prepare current pharmacy source indexes before issuing a new supply"); }
  if (!indexes.some(index => index.unique && index.key.fulfillmentClaims === 1 && Object.keys(index.key).length === 1 && index.partialFilterExpression?.kind === "clinical") ||
      indexes.some(index => index.unique && index.key.prescriptionIds === 1)) throw new CommandError(503, "Prepare current pharmacy source indexes before issuing a new supply");
}
