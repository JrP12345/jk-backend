import mongoose, { Schema } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";

const InvoiceItemSchema = new Schema({
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
  invoiceNumber: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization" },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  
  items: [InvoiceItemSchema],
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
    enum: ["unpaid", "partially_paid", "paid", "refunded"], 
    default: "unpaid",
    index: true 
  },
  amountPaid: { type: Number, default: 0 },
  balanceDue: { type: Number },
  payments: [
    {
      amount: { type: Number, required: true },
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

InvoiceSchema.index({ clinicId: 1, status: 1 });
InvoiceSchema.index({ organizationId: 1, createdAt: -1 });
InvoiceSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });

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

export const Invoice = mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
