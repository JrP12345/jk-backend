import mongoose, { Schema } from "mongoose";
import { documentBudget } from "../utilities/documentBudget.ts";
import { auditPlugin } from "../utilities/auditPlugin.ts";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";
import { Organization } from "./Organization.ts";
import { Location } from "./Location.ts";
import { pharmacyDocumentSchema, pharmacyTaxAmounts } from "./pharmacyDocumentSchema.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { pharmacyCalculationSchema } from "./pharmacyCalculationSchema.ts";
import { validateRetailInvoice } from "../utilities/pharmacyInvoice.ts";

const InvoiceItemSchema = new Schema({
  ...pharmacyTaxAmounts,
  taxTreatment: String,
  unitCode: String,
  pharmacyDispenseId: { type: Schema.Types.ObjectId, ref: "PharmacyDispense" },
  pharmacyDispenseLineId: { type: Schema.Types.ObjectId },
  calculationLineId: String,
  serviceCatalogId: { type: Schema.Types.ObjectId, ref: "ServiceCatalog" },
  description: { type: String, required: true },
  amount: { type: Number, required: true }, // Base unit price
  quantity: { type: Number, required: true, default: 1 },
  hsnSacCode: { type: String, default: "999312" },
  gstRate: { type: Number, default: 0 },
  cgstAmount: { type: Number, default: 0 },
  sgstAmount: { type: Number, default: 0 },
  igstAmount: { type: Number, default: 0 },
  totalItemAmount: { type: Number }
});

const InvoiceSchema = new Schema({
  kind: { type: String, enum: ["clinical", "pharmacy"], default: "clinical", required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  customerSnapshot: { type: new Schema({ anonymous: { type: Boolean, required: true }, partyId: Schema.Types.ObjectId, revision: Number, name: String, address: String, phone: String }, { _id: false }), default: undefined },
  openingBalanceId: { type: Schema.Types.ObjectId },
  openingBalanceSnapshot: { type: new Schema({ amountPaise: { type: Number, min: 1, required: true, validate: Number.isSafeInteger }, sourceDate: { type: String, required: true }, sourceReference: { type: String, required: true }, reviewReference: { type: String, required: true },
    issuer: { legalName: { type: String, required: true }, address: { type: String, required: true }, drugLicenceNumbers: [String] },
  }, { _id: false }), default: undefined },
  calculation: { type: pharmacyCalculationSchema },
  invoiceNumber: { type: String, required: true, unique: true },
  generationKey: { type: String },
  clinicalChargeVersion: { type: Number },
  supplementForInvoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },
  issuedAt: { type: Date },
  documentVersion: { type: Number },
  numberingVersion: { type: Number },
  financialYear: { type: String },
  invoiceSeries: { type: String },
  taxDocument: { type: pharmacyDocumentSchema },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization" },
  currency: { type: String, enum: ["INR", "USD", "CAD", "GBP", "AED", "EUR"] },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: function (this: { kind?: string }): boolean { return this.kind !== "pharmacy"; }, index: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", index: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: function (this: { kind?: string }): boolean { return this.kind !== "pharmacy"; }, index: true },

  items: [InvoiceItemSchema],
  pharmacyDispenseLineIds: { type: [Schema.Types.ObjectId], default: undefined },
  subtotal: { type: Number, required: true },
  taxableAmount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 }, // Combined tax total
  discount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },

  // GST Compliance Fields
  supplierGstin: { type: String, trim: true },
  customerGstin: { type: String, trim: true },
  invoiceType: {
    type: String,
    enum: ["B2C", "B2B", "SEZ", "EXPORT"],
    default: "B2C"
  },
  placeOfSupply: { type: String, trim: true },
  isInterstate: { type: Boolean, default: false },
  cgstTotal: { type: Number, default: 0 },
  sgstTotal: { type: Number, default: 0 },
  igstTotal: { type: Number, default: 0 },

  // Phase 3 e-Invoice hook fields
  eInvoiceIrn: { type: String, trim: true },
  eInvoiceQrCode: { type: String, trim: true },

  status: {
    type: String,
    enum: ["unpaid", "partially_paid", "paid", "refunded", "cancelled"],
    default: "unpaid",
    index: true
  },
  amountPaid: { type: Number, default: 0 },
  balanceDue: { type: Number },
  paymentRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  creditedPaise: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  refundedPaise: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  returnRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  payments: [
    {
      amount: { type: Number, required: true },
      operationKey: { type: String },
      receiptId: { type: Schema.Types.ObjectId }, componentId: String,
      actorId: { type: Schema.Types.ObjectId, ref: "User" }, shiftId: { type: Schema.Types.ObjectId, ref: "CashierShift" },
      paymentMethod: { type: String, required: true },
      referenceNumber: { type: String, trim: true },
      paidAt: { type: Date, default: Date.now },
      notes: { type: String, trim: true },
    },
  ],
  dueDate: { type: Date, index: true },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "upi", "net-banking", "insurance", "online", "courtesy_waiver", "other"]
  },
  paymentDate: { type: Date },
  notes: { type: String, trim: true },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

InvoiceSchema.index({ locationId: 1, status: 1 });
// A separate array contains only real source IDs. Indexing mixed clinical items
// would also index missing pharmacy IDs as null, conflicting across normal bills.
InvoiceSchema.index({ pharmacyDispenseLineIds: 1 }, { unique: true,
  partialFilterExpression: { pharmacyDispenseLineIds: { $type: "objectId" } } });
InvoiceSchema.index({ generationKey: 1 }, { unique: true, partialFilterExpression: { generationKey: { $type: "string" } } });
InvoiceSchema.index({ organizationId: 1, createdAt: -1 });
InvoiceSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });

InvoiceSchema.pre("validate", function () {
  validateRetailInvoice(this);
  const lines = this.items.filter(item => item.pharmacyDispenseLineId);
  const ids = lines.map(item => item.pharmacyDispenseLineId!);
  if (this.items.some(item => Boolean(item.pharmacyDispenseId) !== Boolean(item.pharmacyDispenseLineId)) ||
      new Set(ids.map(String)).size !== ids.length) throw new Error("Invoice pharmacy source references must be complete and unique");
  if (JSON.stringify((this.pharmacyDispenseLineIds || []).map(String)) !== JSON.stringify(ids.map(String))) {
    this.pharmacyDispenseLineIds = ids.length ? ids : undefined;
  }
  if (this.documentVersion === 1) {
    const document = this.taxDocument;
    const validNumber = /^I[0-9A-Z]{4}[0-9]{4}\/[0-9]{6}$/.test(this.invoiceNumber);
    const sum = (key: "baseAmountPaise" | "cgstPaise" | "sgstPaise" | "grossAmountPaise") => this.items.reduce((total, item) => total + (item[key] ?? NaN), 0);
    if (!this.issuedAt || !document || document.version !== 1 || !validNumber || this.numberingVersion !== 2 || this.currency !== "INR" ||
        !document.issuer?.legalName || !document.issuer.address || !document.issuer.stateCode || !document.issuer.authorisedSignatory ||
        !document.issuer.drugLicenceNumbers?.length || !document.recipient?.name || !document.issuedBy || document.signatureMode !== "manual_on_print" ||
        document.issuedAt?.getTime() !== this.issuedAt.getTime() || this.invoiceSeries !== this.invoiceNumber.slice(1, 5) ||
        !this.financialYear || !this.invoiceSeries || !this.items.length || this.items.some(item =>
          !/^\d{4}(\d{2})?(\d{2})?$/.test(item.hsnSacCode) || !/^[A-Z]{3}$/.test(item.unitCode || "") ||
          ![item.baseAmountPaise, item.cgstPaise, item.sgstPaise, item.grossAmountPaise].every(value => Number.isSafeInteger(value) && value! >= 0) ||
          item.baseAmountPaise! + item.cgstPaise! + item.sgstPaise! !== item.grossAmountPaise ||
          Math.abs(item.amount * item.quantity - item.baseAmountPaise! / 100) > 0.000001 || item.totalItemAmount !== item.grossAmountPaise! / 100) ||
        this.subtotal !== sum("baseAmountPaise") / 100 || this.totalAmount !== sum("grossAmountPaise") / 100 ||
        this.tax !== (sum("cgstPaise") + sum("sgstPaise")) / 100 || this.cgstTotal !== sum("cgstPaise") / 100 ||
        this.sgstTotal !== sum("sgstPaise") / 100 || this.igstTotal !== 0 || this.discount !== 0 ||
        (!['tax_invoice', 'invoice_cum_bill_of_supply'].includes(document.kind) && this.tax !== 0)) {
      throw new CommandError(409, "Issued pharmacy document does not reconcile with its captured tax lines");
    }
  }
});

const protectedIssuePaths = ["openingBalanceId", "openingBalanceSnapshot", "kind", "createdBy", "customerSnapshot", "calculation", "items", "pharmacyDispenseLineIds", "invoiceNumber", "documentVersion", "numberingVersion", "financialYear", "invoiceSeries", "taxDocument", "issuedAt", "currency", "organizationId", "locationId", "patientId", "doctorId", "encounterId", "appointmentId", "supplementForInvoiceId", "subtotal", "taxableAmount", "tax", "discount", "totalAmount", "cgstTotal", "sgstTotal", "igstTotal", "supplierGstin", "customerGstin", "invoiceType", "placeOfSupply", "isInterstate", "deletedAt"];
InvoiceSchema.pre("save", async function () {
  if (this.isNew) return;
  const issued = await Invoice.findOne({ _id: this._id, documentVersion: { $in: [1, 2, 3] }, issuedAt: { $ne: null } }).select("_id").lean();
  if (issued && (protectedIssuePaths.some(path => this.isModified(path)) || (this.isModified("status") && ["cancelled", "refunded"].includes(this.status)))) {
    throw new CommandError(409, "Issued pharmacy documents are immutable; use a linked supplement or reviewed credit workflow");
  }
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  InvoiceSchema.pre(operation, async function () {
    const update = this.getUpdate?.() as any;
    const paths = update ? Object.entries(update).flatMap(([key, value]) => key.startsWith("$") && value && typeof value === "object"
      ? [...Object.keys(value), ...(key === "$rename" ? Object.values(value) as string[] : [])] : [key]) : [];
    const destructive = operation.includes("delete") || operation.includes("Delete") || operation.includes("replace") || operation.includes("Replace");
    if ((destructive || Array.isArray(update) || paths.some(path => protectedIssuePaths.includes(path.split(".")[0])) ||
        ["cancelled", "refunded"].includes(update?.$set?.status || update?.status)) &&
        await this.model.exists({ $and: [this.getFilter(), { documentVersion: { $in: [1, 2, 3] }, issuedAt: { $ne: null } }] })) {
      throw new CommandError(409, "Issued pharmacy document fields cannot be rewritten or deleted");
    }
  });
}
InvoiceSchema.pre("bulkWrite", function () { throw new CommandError(409, "Use guarded invoice mutations; bulk writes bypass issued-document validation"); });
InvoiceSchema.pre("deleteOne", { document: true, query: false }, function () {
  if ([1, 2, 3].includes(this.documentVersion!) && this.issuedAt) throw new CommandError(409, "Issued pharmacy documents cannot be deleted");
});

// Snapshot the business currency when an invoice is issued. Existing invoices
// without this field retain their historical INR interpretation.
InvoiceSchema.pre("validate", async function () {
  if (!this.isNew || this.currency) return;
  let organizationId = this.organizationId;
  if (!organizationId && this.locationId) {
    const location = await Location.findById(this.locationId).select("organizationId").lean();
    organizationId = location?.organizationId;
  }
  if (organizationId) {
    const organization = await Organization.findById(organizationId).select("currency").lean();
    this.currency = organization?.currency || "INR";
  } else {
    this.currency = "INR";
  }
});

InvoiceSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

InvoiceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

InvoiceSchema.plugin(auditPlugin);
InvoiceSchema.plugin(tenantPlugin);
InvoiceSchema.plugin(documentBudget, { payments: 500, items: 1000 });

export const Invoice = mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
