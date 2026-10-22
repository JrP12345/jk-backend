import { CommandError } from "../services/CommandReceiptService.ts";
import { toPaise } from "./pharmacyTax.ts";

/** Validates the committed retail contract without requiring any clinical entity. */
export function validateRetailInvoice(invoice: any) {
  const fail = (): never => { throw new CommandError(409, "Retail invoice does not reconcile with its captured sources and calculation"); };
  if (invoice.kind !== "pharmacy") { if ([2, 3].includes(invoice.documentVersion)) fail(); return; }
  const calc = invoice.calculation, doc = invoice.taxDocument, customer = invoice.customerSnapshot;
  if (invoice.documentVersion === 3) {
    const amount = toPaise(invoice.totalAmount), paid = toPaise(invoice.amountPaid ?? 0), opening = invoice.openingBalanceSnapshot;
    if (!amount || opening?.amountPaise !== amount || !invoice.openingBalanceId || !opening?.sourceDate || !opening.sourceReference || !opening.reviewReference || !opening.issuer?.legalName || !opening.issuer.address ||
        !invoice.organizationId || !invoice.createdBy || !invoice.issuedAt || !/^O[0-9A-Z]{4}[0-9]{4}\/[0-9]{6}$/.test(invoice.invoiceNumber) ||
        invoice.numberingVersion !== 1 || !invoice.financialYear || invoice.invoiceSeries !== invoice.invoiceNumber.slice(1, 5) || invoice.currency !== "INR" ||
        !customer || customer.anonymous !== false || !customer.partyId || !customer.name || !Number.isSafeInteger(customer.revision) ||
        invoice.patientId || invoice.doctorId || invoice.encounterId || invoice.appointmentId || invoice.items.length || calc || doc || invoice.subtotal !== invoice.totalAmount ||
        invoice.tax !== 0 || invoice.taxableAmount !== 0 || invoice.discount !== 0 || invoice.cgstTotal !== 0 || invoice.sgstTotal !== 0 || invoice.igstTotal !== 0 ||
        (invoice.creditedPaise ?? 0) !== 0 || (invoice.refundedPaise ?? 0) !== 0 || (invoice.returnRevision ?? 0) !== 0 || paid > amount ||
        toPaise(invoice.balanceDue) !== amount - paid) fail();
    return;
  }
  if (invoice.openingBalanceId || invoice.openingBalanceSnapshot) fail();
  if (invoice.documentVersion !== 2 || !invoice.createdBy || !invoice.organizationId || !customer || typeof customer.anonymous !== "boolean" ||
      !customer.anonymous && (!customer.partyId || !customer.name || !Number.isSafeInteger(customer.revision)) || customer.anonymous && customer.partyId ||
      invoice.patientId || invoice.doctorId || invoice.encounterId || invoice.appointmentId || invoice.supplementForInvoiceId ||
      !calc || calc.policy !== "pharmacy-paise-v2" || calc.currency !== "INR" || calc.priceMode !== "inclusive" || !["sgst", "none"].includes(calc.taxMode) ||
      !doc || doc.version !== 2 || doc.pricingPolicy !== calc.policy || !["tax_invoice", "bill_of_supply", "invoice_cum_bill_of_supply", "ordinary_bill"].includes(doc.kind) ||
      !doc.issuer?.legalName || !doc.issuer.address || !doc.issuer.authorisedSignatory || !doc.issuer.drugLicenceNumbers?.length || !doc.recipient?.name ||
      String(doc.issuedBy) !== String(invoice.createdBy) || doc.signatureMode !== "manual_on_print" || doc.supplyMode !== "counter_pickup" ||
      !invoice.issuedAt || doc.issuedAt?.getTime() !== invoice.issuedAt.getTime() || invoice.currency !== "INR" || invoice.numberingVersion !== 2 ||
      !/^I[0-9A-Z]{4}[0-9]{4}\/[0-9]{6}$/.test(invoice.invoiceNumber) || !invoice.financialYear || invoice.invoiceSeries !== invoice.invoiceNumber.slice(1, 5) ||
      !invoice.items.length || calc.lines.length !== invoice.items.length || !calc.totals || invoice.isInterstate || invoice.invoiceType !== "B2C") fail();
  const totals = calc.totals, fields = ["amountBeforeDiscountPaise", "lineDiscountPaise", "invoiceDiscountPaise", "baseAmountPaise", "cgstPaise", "sgstPaise", "grossAmountPaise"];
  const paid = toPaise(invoice.amountPaid ?? 0), credited = invoice.creditedPaise ?? 0;
  const refunded = invoice.refundedPaise ?? 0;
  if (paid > totals.payablePaise || !Number.isSafeInteger(credited) || credited < 0 || credited > totals.payablePaise ||
      !Number.isSafeInteger(refunded) || refunded < 0 || refunded > Math.max(0, paid + credited - totals.payablePaise) ||
      !Number.isSafeInteger(invoice.returnRevision ?? 0) || (invoice.returnRevision ?? 0) < 0 ||
      invoice.balanceDue !== undefined && toPaise(invoice.balanceDue) !== Math.max(0, totals.payablePaise - paid - credited)) fail();
  const safe = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const ids = new Set<string>();
  for (const item of invoice.items) {
    const line = calc.lines.find((row: any) => row.lineId === item.calculationLineId);
    if (!line || ids.has(line.lineId) || !item.pharmacyDispenseId || !item.pharmacyDispenseLineId || line.quantity !== item.quantity || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !/^\d{4}(\d{2})?(\d{2})?$/.test(item.hsnSacCode) || !/^[A-Z]{3}$/.test(item.unitCode || "") || fields.some(field => !safe(line[field])) ||
        ["baseAmountPaise", "cgstPaise", "sgstPaise", "grossAmountPaise"].some(field => item[field] !== line[field]) ||
        line.baseAmountPaise + line.cgstPaise + line.sgstPaise !== line.grossAmountPaise || line.grossAmountPaise !== line.amountBeforeDiscountPaise - line.lineDiscountPaise - line.invoiceDiscountPaise ||
        line.utgstPaise !== 0 || line.igstPaise !== 0 || line.unallocatedTaxPaise !== 0 || line.gstRateBps !== Math.round(item.gstRate * 100) ||
        Math.abs(item.amount * item.quantity - item.baseAmountPaise / 100) > 0.000001 || item.totalItemAmount !== item.grossAmountPaise / 100) fail();
    ids.add(line.lineId);
  }
  if (fields.some(field => !safe(totals[field]) || BigInt(totals[field]) !== calc.lines.reduce((sum: bigint, line: any) => sum + BigInt(line[field]), 0n)) ||
      !Number.isSafeInteger(totals.roundOffPaise) || Math.abs(totals.roundOffPaise) > 99 || !safe(totals.payablePaise) ||
      totals.utgstPaise !== 0 || totals.igstPaise !== 0 || totals.unallocatedTaxPaise !== 0 || totals.payablePaise !== totals.grossAmountPaise + totals.roundOffPaise ||
      invoice.subtotal !== totals.baseAmountPaise / 100 || invoice.tax !== (totals.cgstPaise + totals.sgstPaise) / 100 ||
      invoice.cgstTotal !== totals.cgstPaise / 100 || invoice.sgstTotal !== totals.sgstPaise / 100 || invoice.igstTotal !== 0 ||
      invoice.totalAmount !== totals.payablePaise / 100 || invoice.discount !== (totals.lineDiscountPaise + totals.invoiceDiscountPaise) / 100 ||
      (doc.issuer.registration !== "regular" || !["tax_invoice", "invoice_cum_bill_of_supply"].includes(doc.kind)) && invoice.tax !== 0) fail();
}
