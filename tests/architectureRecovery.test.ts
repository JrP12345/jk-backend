import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { UploadIntent } from "../models/UploadIntent.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";
import { reconcileAppointmentOrderIntents } from "../services/AppointmentOrderReconciliationService.ts";
import { cleanupExpiredUploads } from "../services/UploadCleanupService.ts";
import * as storage from "../utilities/r2.ts";

afterEach(() => vi.restoreAllMocks());
async function intent() {
  const payment = await AppointmentPayment.create({ appointmentId: new mongoose.Types.ObjectId(), patientId: new mongoose.Types.ObjectId(),
    amount: 100, currency: "INR", paymentMethod: "razorpay", status: "ambiguous", orderReceipt: `receipt-${new mongoose.Types.ObjectId()}` });
  await AppointmentPayment.collection.updateOne({ _id: payment._id }, { $set: { updatedAt: new Date(Date.now() - 180_000) } });
  return payment;
}
describe("Durable recovery boundaries", () => {
  it("keeps an ambiguous order when lookup has no evidence and never resends the POST", async () => {
    const payment = await intent();
    const lookup = vi.spyOn(razorpayService, "findOrderByReceipt").mockResolvedValue(null);
    const create = vi.spyOn(razorpayService, "createOrder");
    await reconcileAppointmentOrderIntents();
    expect(lookup).toHaveBeenCalledWith(payment.orderReceipt);
    expect((await AppointmentPayment.findById(payment._id))?.status).toBe("ambiguous");
    expect(create).not.toHaveBeenCalled();
  });
  it("attaches only provider evidence matching amount, currency and persisted intent", async () => {
    const payment = await intent();
    const lookup = vi.spyOn(razorpayService, "findOrderByReceipt").mockResolvedValue({ id: "order-recovered", amount: 9999, currency: "INR", notes: { intentId: String(payment._id) } } as any);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcileAppointmentOrderIntents();
    expect((await AppointmentPayment.findById(payment._id))?.status).toBe("ambiguous");
    lookup.mockResolvedValue({ id: "order-recovered", amount: 10000, currency: "INR", notes: { intentId: String(payment._id) } } as any);
    await reconcileAppointmentOrderIntents();
    expect(await AppointmentPayment.findById(payment._id)).toMatchObject({ status: "created", razorpayOrderId: "order-recovered" });
  });
  it("retains failed object deletion metadata and removes it after a successful retry", async () => {
    const upload = await UploadIntent.create({ organizationId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(),
      objectKey: `orphan-${new mongoose.Types.ObjectId()}`, originalFileName: "fixture.pdf", maxSizeBytes: 1024,
      status: "quarantined", expiresAt: new Date(Date.now() - 48 * 60 * 60_000) });
    const remove = vi.spyOn(storage, "deleteObjectFromStorage").mockRejectedValueOnce(new Error("Temporary storage outage")).mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await cleanupExpiredUploads();
    expect((await UploadIntent.findById(upload._id))?.status).toBe("expired");
    await cleanupExpiredUploads();
    expect(await UploadIntent.exists({ _id: upload._id })).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("preserves registered authority and a live verification claim during cleanup", async () => {
    const owner = { organizationId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(), originalFileName: "fixture.pdf", maxSizeBytes: 1024,
      expiresAt: new Date(Date.now() - 48 * 60 * 60_000) };
    const rows = await UploadIntent.create([{ ...owner, objectKey: `registered-${new mongoose.Types.ObjectId()}`, status: "pending", registeredDocumentId: new mongoose.Types.ObjectId() },
      { ...owner, objectKey: `verifying-${new mongoose.Types.ObjectId()}`, status: "verifying", verifyingUntil: new Date(Date.now() + 60_000), verificationToken: "active-owner" }]);
    const remove = vi.spyOn(storage, "deleteObjectFromStorage").mockResolvedValue(undefined);
    await cleanupExpiredUploads();
    expect(remove).not.toHaveBeenCalled();
    expect(await UploadIntent.countDocuments({ _id: { $in: rows.map(row => row._id) } })).toBe(2);
  });
});
