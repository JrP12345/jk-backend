import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { razorpayService } from "./billing/RazorpayService.ts";
export async function reconcileAppointmentOrderIntents() {
  const rows = await AppointmentPayment.find({ status: { $in: ["creating", "ambiguous"] }, orderReceipt: { $exists: true }, updatedAt: { $lt: new Date(Date.now() - 120_000) } }).sort({ updatedAt: 1 }).limit(20).lean();
  for (const row of rows) {
    try {
      const order = await razorpayService.findOrderByReceipt(row.orderReceipt!);
      if (!order) continue; // Absence is not proof that an ambiguous POST failed.
      if (order.amount !== Math.round(row.amount * 100) || order.currency !== row.currency || order.notes?.intentId !== String(row._id)) throw new Error("Provider order does not match persisted intent");
      await AppointmentPayment.updateOne({ _id: row._id, status: { $in: ["creating", "ambiguous"] } }, { $set: { razorpayOrderId: order.id, status: "created" } });
    } catch { console.error("appointment.order.reconciliation.failed", { intentId: String(row._id) }); }
  }
}
