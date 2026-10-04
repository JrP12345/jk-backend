import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Counter } from "../models/Counter.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { disruptionService } from "../services/disruptionService.ts";
import { eventBus } from "../events/eventBus.ts";
import { paymentProvider } from "../services/payment/PaymentProvider.ts";
import { SmsWhatsAppService } from "../services/SmsWhatsAppService.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { Role } from "../models/Role.ts";
import { app } from "../index.ts";
import { generateAccessToken } from "../utilities/helpers.ts";
import { razorpayService, type RazorpayRefund } from "../services/billing/RazorpayService.ts";
import { resilientHttpClient } from "../utilities/resilientHttpClient.ts";
import * as notifications from "../utilities/notifications.ts";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";

let replica: MongoMemoryReplSet;
let orgId: string, clinicId: string, doctorId: string, replacementId: string, foreignDoctorId: string, patientId: string;
let rootCookie: string, restrictedCookie: string;
beforeAll(async () => {
  // These cases verify actual commit/rollback, not the development standalone fallback.
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.disconnect(); await mongoose.connect(replica.getUri());
  await Promise.all([Appointment, Invoice, AuditLog, Counter, DoctorAssignment, AppointmentPayment, DomainEventOutbox].map(model => model.createIndexes()));
  const org = await Organization.create({ name: "Integrity Health", city: "Surat", timezone: "Asia/Kolkata", currency: "INR" }); orgId = org.id;
  const clinics = await Clinic.create([{ name: "Own", city: "Surat", organizationId: orgId }, { name: "Other location", city: "Surat", organizationId: orgId }]); clinicId = clinics[0].id;
  const doctors = await User.create([{ name: "Original", role: "doctor" }, { name: "Replacement", role: "doctor" }, { name: "Foreign", role: "doctor" }]);
  doctorId = doctors[0].id; replacementId = doctors[1].id; foreignDoctorId = doctors[2].id;
  const root = await User.create({ name: "Root", role: "root" });
  rootCookie = `access_token=${generateAccessToken({ id: root.id, email: "", role: "root" })}`;
  const restricted = await User.create({ name: "Restricted admin", role: "admin" });
  await Role.create({ name: "admin", organizationId: orgId, permissions: [] });
  restrictedCookie = `access_token=${generateAccessToken({ id: restricted.id, email: "", role: "admin", organization_id: orgId })}`;
  await DoctorAssignment.create([
    { clinicId, organizationId: orgId, doctorId, workingHours: '[{"start":"09:00","end":"17:00"}]' },
    { clinicId, organizationId: orgId, doctorId: replacementId, workingHours: '[{"start":"09:00","end":"17:00"}]' },
    { clinicId: clinics[1].id, organizationId: orgId, doctorId: foreignDoctorId, workingHours: "[]" },
  ]);
  const patient = await Patient.create({ name: "Integrity patient", phone: "9876500011", organizationId: orgId }); patientId = patient.id;
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(() => {
  vi.spyOn(eventBus, "publishDurable").mockResolvedValue(undefined as never);
  vi.spyOn(SmsWhatsAppService, "sendBookingConfirmation").mockResolvedValue(undefined as never);
  vi.spyOn(SmsWhatsAppService, "sendDisruptionRefundAlert").mockResolvedValue(undefined as never);
  vi.spyOn(SmsWhatsAppService, "sendDisruptionTransferAlert").mockResolvedValue(undefined as never);
  vi.spyOn(paymentProvider, "processRefund").mockResolvedValue({ refundId: "rfnd_fixture", status: "processed", amount: 600 });
  vi.spyOn(razorpayService, "verifyPaymentSignature").mockResolvedValue(true);
  vi.spyOn(notifications, "sendPaymentReceiptNotification").mockResolvedValue(undefined as never);
});
afterEach(() => vi.restoreAllMocks());

const visit = (extra = {}) => Appointment.create({ organizationId: orgId, clinicId, doctorId, patientId, appointmentTime: new Date("2027-01-10T03:30:00Z"), appointmentType: "reception", bookingMode: "sequential_queue", status: "disruption_triage", tokenNumber: 1, ...extra });
async function invoice(appointmentId: string, extra = {}) {
  return Invoice.create({ organizationId: orgId, clinicId, doctorId, patientId, appointmentId, invoiceNumber: `INV-${new mongoose.Types.ObjectId()}`, items: [{ description: "Consultation", quantity: 1, amount: 600 }], subtotal: 600, totalAmount: 600, amountPaid: 600, balanceDue: 0, status: "paid", paymentMethod: "online", currency: "INR", payments: [{ amount: 600, paymentMethod: "online", referenceNumber: "pay_verifiedFixture", paidAt: new Date() }], ...extra });
}
const reschedule = (appointmentId: string, targetDate = "2027-01-11", targetDoctorId?: string) => disruptionService.priorityReschedule({ appointmentId, targetDate, targetDoctorId, rescheduledByUserId: doctorId });
const cancel = (appointmentId: string) => disruptionService.cancelByDisruption({ appointmentId, cancelledByUserId: doctorId });
async function paymentRecord(appointmentId: string, invoiceId: string, status = "captured") {
  const key = String(new mongoose.Types.ObjectId());
  return AppointmentPayment.create({ appointmentId, invoiceId, patientId, amount: 600, currency: "INR", paymentMethod: "razorpay", status,
    razorpayOrderId: `order_${key}`, ...(status === "captured" ? { razorpayPaymentId: `pay_${key}` } : {}) });
}
const verify = (payment: any, cookie = rootCookie, paymentId = payment.razorpayPaymentId || `pay_${String(payment._id)}`) => app.inject({ method: "POST", url: "/api/appointment-payments/verify", headers: { cookie },
  payload: { appointmentId: String(payment.appointmentId), razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: paymentId, razorpaySignature: "test-signature" } });

describe("Disruption persistence and payment integrity", () => {
  const reconcileRefund = (appointmentId: string, cookie = rootCookie) => app.inject({ method: "POST", url: "/api/appointment-payments/reconcile-refund", headers: { cookie }, payload: { appointmentId } });
  const providerRefund = { id: "rfnd_verified", payment_id: "pay_verifiedFixture", amount: 60000, currency: "INR", status: "processed" };
  it("confirms an ambiguous refund once, committing invoice/audit/outbox together", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending", triageAction: "cancelled" });
    const paid = await invoice(original.id);
    vi.mocked(eventBus.publishDurable).mockRestore();
    const refundId = `rfnd_${original.id}`;
    const gateway = vi.spyOn(razorpayService, "fetchPaymentRefunds").mockResolvedValue({ items: [{ ...providerRefund, id: refundId }] });
    const results = await Promise.all([reconcileRefund(original.id), reconcileRefund(original.id)]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    expect((await Invoice.findById(paid.id))?.status).toBe("refunded");
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refunded");
    expect(await AuditLog.countDocuments({ action: "REFUND_RECONCILED", "details.appointmentId": original.id })).toBe(1);
    expect(await DomainEventOutbox.countDocuments({ idempotencyKey: `refund-confirmed:${refundId}` })).toBe(1);
    gateway.mockClear();
    expect((await reconcileRefund(original.id)).json().data.replayed).toBe(true);
    expect(gateway).not.toHaveBeenCalled();
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it.each([
    [[], "review"],
    [[{ ...providerRefund, status: "pending" }], "pending"],
    [[{ ...providerRefund, status: "failed" }], "review"],
    [[{ ...providerRefund, amount: 50000 }], "review"],
    [[{ ...providerRefund, currency: "USD" }], "review"],
    [[{ ...providerRefund, payment_id: "pay_other" }], "review"],
    [[providerRefund, { ...providerRefund, id: "rfnd_duplicate" }], "review"],
  ] as [RazorpayRefund[], string][])("keeps unconfirmed or mismatched refunds pending: %j", async (items, status) => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" }); const paid = await invoice(original.id);
    vi.spyOn(razorpayService, "fetchPaymentRefunds").mockResolvedValue({ items });
    const result = await reconcileRefund(original.id);
    expect(result.statusCode).toBe(200); expect(result.json().data.status).toBe(status);
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    expect((await Invoice.findById(paid.id))?.status).toBe("paid");
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it("does not read the provider for cash receipts or revoked billing grants", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" }); await invoice(original.id, { payments: [{ amount: 600, paymentMethod: "cash" }] });
    const gateway = vi.spyOn(razorpayService, "fetchPaymentRefunds");
    expect((await reconcileRefund(original.id, restrictedCookie)).statusCode).toBe(403);
    expect((await reconcileRefund(original.id)).json().data.status).toBe("review");
    expect(gateway).not.toHaveBeenCalled();
  });
  it("rolls back refund confirmation when audit persistence fails", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" }); const paid = await invoice(original.id);
    vi.spyOn(razorpayService, "fetchPaymentRefunds").mockResolvedValue({ items: [providerRefund] });
    const createAudit = AuditLog.create.bind(AuditLog);
    vi.spyOn(AuditLog, "create").mockImplementation(async (...args: any[]) => {
      if (args[0]?.action === "REFUND_RECONCILED") throw new Error("audit unavailable");
      return createAudit(...args);
    });
    expect((await reconcileRefund(original.id)).statusCode).toBe(502);
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    expect((await Invoice.findById(paid.id))?.status).toBe("paid");
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it("rolls back refund confirmation when outbox persistence fails after financial writes", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" });
    const paid = await invoice(original.id);
    vi.mocked(eventBus.publishDurable).mockRestore();
    const refundId = `rfnd_${original.id}`;
    vi.spyOn(razorpayService, "fetchPaymentRefunds").mockResolvedValue({ items: [{ ...providerRefund, id: refundId }] });
    const fail = vi.spyOn(DomainEventOutbox, "findOneAndUpdate").mockImplementationOnce(() => { throw new Error("outbox unavailable"); });
    expect((await reconcileRefund(original.id)).statusCode).toBe(502);
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    expect((await Invoice.findById(paid.id))?.status).toBe("paid");
    expect(await AuditLog.countDocuments({ action: "REFUND_RECONCILED", targetId: paid._id })).toBe(0);
    expect(await DomainEventOutbox.countDocuments({ idempotencyKey: `refund-confirmed:${refundId}` })).toBe(0);
    fail.mockRestore();
    expect((await reconcileRefund(original.id)).statusCode).toBe(200);
    expect((await Invoice.findById(paid.id))?.status).toBe("refunded");
    expect(await DomainEventOutbox.countDocuments({ idempotencyKey: `refund-confirmed:${refundId}` })).toBe(1);
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it("keeps provider read failure pending without issuing a refund", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" }); await invoice(original.id);
    vi.spyOn(razorpayService, "fetchPaymentRefunds").mockRejectedValue(new Error("provider unavailable"));
    expect((await reconcileRefund(original.id)).statusCode).toBe(502);
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it("denies cross-tenant billing reconciliation before contacting the provider", async () => {
    const cashier = await User.create({ name: "Cashier", role: "cashier" });
    await Role.create({ name: "cashier", organizationId: orgId, permissions: ["MANAGE_BILLING"] });
    const cookie = `access_token=${generateAccessToken({ id: cashier.id, email: "", role: "cashier", organization_id: orgId })}`;
    const foreignOrg = await Organization.create({ name: "Foreign", city: "Surat" });
    const foreignClinic = await Clinic.create({ name: "Foreign", city: "Surat", organizationId: foreignOrg.id });
    const original = await visit({ clinicId: foreignClinic.id, organizationId: foreignOrg.id, status: "cancelled", paymentStatus: "refund_pending" });
    const gateway = vi.spyOn(razorpayService, "fetchPaymentRefunds");
    expect((await reconcileRefund(original.id, cookie)).statusCode).toBe(404);
    expect(gateway).not.toHaveBeenCalled();
  });
  it("marks pending refunds in the existing bounded invoice response", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" }); const paid = await invoice(original.id);
    const result = await app.inject({ method: "GET", url: `/api/invoices?appointmentId=${original.id}&organizationId=${orgId}`, headers: { cookie: rootCookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.find((row: { id: string }) => row.id === paid.id)).toMatchObject({ refundPending: true, appointmentId: original.id });
  });
  it("rejects a provider assigned only to another location before transfer or reschedule", async () => {
    const original = await visit();
    await expect(disruptionService.transferPatient({ appointmentId: original.id, replacementDoctorId: foreignDoctorId, transferredByUserId: doctorId })).rejects.toMatchObject({ statusCode: 404 });
    await expect(reschedule(original.id, "2027-01-11", foreignDoctorId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await Appointment.findById(original.id))?.triageAction).toBe("pending");
    expect(eventBus.publishDurable).not.toHaveBeenCalled();
  });
  it("preserves completed and active consultations against all disruption mutations", async () => {
    for (const status of ["completed", "in-consultation"]) {
      const original = await visit({ status });
      await expect(reschedule(original.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(cancel(original.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(disruptionService.transferPatient({ appointmentId: original.id, replacementDoctorId: replacementId, transferredByUserId: doctorId })).rejects.toMatchObject({ statusCode: 409 });
      expect((await Appointment.findById(original.id))?.status).toBe(status);
    }
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it("commits only one concurrent reschedule and publishes only the committed result", async () => {
    const original = await visit();
    const results = await Promise.allSettled([reschedule(original.id, "2027-02-01"), reschedule(original.id, "2027-02-02")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await Appointment.countDocuments({ priorityRescheduledFromId: original._id })).toBe(1);
    expect(await AuditLog.countDocuments({ targetId: original._id, action: "APPOINTMENT_RESCHEDULED" })).toBe(1);
    expect(eventBus.publishDurable).toHaveBeenCalledOnce();
  });
  it("shares the canonical counter for concurrent queue reschedules", async () => {
    const first = await visit(), second = await visit();
    await Counter.create({ id: `token_${clinicId}_${doctorId}_2027-02-03`, seq: 0 });
    const results = await Promise.all([reschedule(first.id, "2027-02-03"), reschedule(second.id, "2027-02-03")]);
    expect(results.map(result => result.newAppt.tokenNumber).sort()).toEqual([1, 2]);
    const visits = await Appointment.find({ _id: { $in: results.map(result => result.newAppt._id) } });
    expect(visits.map(result => result.queuePosition).sort()).toEqual([1, 2]);
  });
  it("rolls back original/new visits, carried invoices and tokens after persistence failure", async () => {
    const original = await visit({ paymentStatus: "paid" });
    const paid = await invoice(original.id);
    vi.spyOn(Invoice, "updateMany").mockRejectedValueOnce(new Error("Invoice persistence failed"));
    await expect(reschedule(original.id, "2027-02-04")).rejects.toThrow("Invoice persistence failed");
    expect((await Appointment.findById(original.id))?.status).toBe("disruption_triage");
    expect(await Appointment.countDocuments({ priorityRescheduledFromId: original._id })).toBe(0);
    expect(String((await Invoice.findById(paid.id))?.appointmentId)).toBe(original.id);
    expect(await Counter.exists({ id: `token_${clinicId}_${doctorId}_2027-02-04` })).toBeNull();
    expect(eventBus.publishDurable).not.toHaveBeenCalled();
  });
  it("keeps the original visit pending when a target time slot collides", async () => {
    await DoctorAssignment.updateOne({ clinicId, doctorId: replacementId }, { bookingMode: "time_slot" });
    const original = await visit();
    await visit({ doctorId: replacementId, appointmentTime: new Date("2027-02-05T03:30:00Z"), status: "confirmed", bookingMode: "time_slot" });
    await expect(reschedule(original.id, "2027-02-05", replacementId)).rejects.toMatchObject({ code: 11000 });
    expect((await Appointment.findById(original.id))?.status).toBe("disruption_triage");
    expect(await Appointment.countDocuments({ priorityRescheduledFromId: original._id })).toBe(0);
    await DoctorAssignment.updateOne({ clinicId, doctorId: replacementId }, { bookingMode: "sequential_queue" });
  });
  it("persists cancellation/refund-pending before the provider call and refunds only once", async () => {
    const original = await visit({ paymentStatus: "paid" }); const paid = await invoice(original.id);
    let finish!: (result: { refundId: string; status: "processed"; amount: number }) => void;
    vi.mocked(paymentProvider.processRefund).mockImplementationOnce(async () => {
      expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
      return new Promise(resolve => { finish = resolve; });
    });
    const first = cancel(original.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(cancel(original.id)).rejects.toMatchObject({ statusCode: 409 });
    finish({ refundId: "rfnd_fixture", status: "processed", amount: 600 }); await first;
    expect(paymentProvider.processRefund).toHaveBeenCalledOnce();
    expect(vi.mocked(paymentProvider.processRefund).mock.calls[0][0]).toMatchObject({ transactionId: "pay_verifiedFixture", amount: 600 });
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refunded");
    expect((await Invoice.findById(paid.id))?.status).toBe("refunded");
  });
  it.each(["cash", "missing", "foreign", "split"])("retains %s receipts for billing review without fabricating a provider refund", async kind => {
    const original = await visit({ paymentStatus: "paid" });
    const payments = kind === "split" ? [{ amount: 300, paymentMethod: "online", referenceNumber: "pay_a" }, { amount: 300, paymentMethod: "cash" }] : [{ amount: 600, paymentMethod: kind === "cash" ? "cash" : "online", referenceNumber: kind === "missing" ? undefined : "pay_a" }];
    const paid = await invoice(original.id, { payments, currency: kind === "foreign" ? "USD" : "INR" });
    await cancel(original.id);
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    expect((await Invoice.findById(paid.id))?.status).toBe("paid");
    expect(paymentProvider.processRefund).not.toHaveBeenCalled();
  });
  it.each(["failed", "pending"] as const)("does not retry a %s refund through repeated cancellation", async status => {
    const original = await visit({ paymentStatus: "paid" }); await invoice(original.id);
    const refundId = status === "pending" ? "rfnd_pending" : "";
    vi.mocked(paymentProvider.processRefund).mockResolvedValueOnce({ refundId, status, amount: 600 });
    await cancel(original.id);
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    await expect(cancel(original.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(paymentProvider.processRefund).toHaveBeenCalledOnce();
    expect((await AuditLog.findOne({ action: "APPOINTMENT_CANCELLED", targetId: original._id }))?.details).toMatchObject({ refundId, refundProcessed: false });
  });
  it("requires the timeout worker's exact claim token", async () => {
    const original = await visit({ triageAction: "timeout_processing", disruptionTimeoutClaimToken: "current-worker" });
    await expect(disruptionService.cancelByDisruption({ appointmentId: original.id, cancelledByUserId: "system", timeoutClaimToken: "old-worker" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await Appointment.findById(original.id))?.status).toBe("disruption_triage");
    await disruptionService.cancelByDisruption({ appointmentId: original.id, cancelledByUserId: "system", timeoutClaimToken: "current-worker" });
    expect((await Appointment.findById(original.id))?.status).toBe("cancelled");
  });

  it("refunds a canonical capture when a legacy invoice has no receipt array", async () => {
    const original = await visit({ paymentStatus: "paid" }); const paid = await invoice(original.id, { payments: [] });
    const payment = await paymentRecord(original.id, paid.id);
    await cancel(original.id);
    expect(paymentProvider.processRefund).toHaveBeenCalledWith(expect.objectContaining({ transactionId: payment.razorpayPaymentId, amount: 600 }));
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refunded");
  });
  it("keeps refunded visits/invoices intact across verify and reconcile replays", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refunded" }); const paid = await invoice(original.id, { status: "refunded" });
    const payment = await paymentRecord(original.id, paid.id);
    expect((await verify(payment)).statusCode).toBe(200);
    const gateway = vi.spyOn(resilientHttpClient, "request");
    expect((await app.inject({ method: "POST", url: "/api/appointment-payments/reconcile", headers: { cookie: rootCookie }, payload: { appointmentId: original.id } })).statusCode).toBe(200);
    expect(gateway).not.toHaveBeenCalled();
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refunded");
    expect((await Invoice.findById(paid.id))?.status).toBe("refunded");
    expect(notifications.sendPaymentReceiptNotification).not.toHaveBeenCalled();
    expect((await verify(payment, rootCookie, "pay_foreignTransaction")).statusCode).toBe(409);
  });
  it("settles concurrent verification once and exposes its canonical receipt to refunds", async () => {
    const original = await visit({ status: "pending_payment", paymentStatus: "pending" });
    const unpaid = await invoice(original.id, { status: "unpaid", amountPaid: 0, balanceDue: 600, payments: [] });
    const payment = await paymentRecord(original.id, unpaid.id, "created");
    const results = await Promise.all([verify(payment), verify(payment)]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    const paid = await Invoice.findById(unpaid.id);
    expect(paid?.amountPaid).toBe(600); expect(paid?.payments).toHaveLength(1);
    expect(notifications.sendPaymentReceiptNotification).toHaveBeenCalledOnce();
    await Appointment.updateOne({ _id: original._id }, { status: "disruption_triage" });
    await cancel(original.id);
    expect(paymentProvider.processRefund).toHaveBeenCalledOnce();
  });
  it("rejects settlement and payment-choice mutations after cancellation", async () => {
    const original = await visit({ status: "cancelled", paymentStatus: "refund_pending" }); const unpaid = await invoice(original.id, { status: "unpaid", amountPaid: 0, balanceDue: 600, payments: [] });
    const payment = await paymentRecord(original.id, unpaid.id, "created");
    expect((await verify(payment)).statusCode).toBe(409);
    for (const action of ["pay-at-clinic", "create-order", "collect-counter"]) {
      expect((await app.inject({ method: "POST", url: `/api/appointment-payments/${action}`, headers: { cookie: rootCookie }, payload: { appointmentId: original.id, paymentMethod: "cash" } })).statusCode).toBe(409);
    }
    expect((await Appointment.findById(original.id))?.paymentStatus).toBe("refund_pending");
    expect((await Invoice.findById(unpaid.id))?.status).toBe("unpaid");
  });
  it("uses effective staff grants for payment operations", async () => {
    const original = await visit(); const unpaid = await invoice(original.id); const payment = await paymentRecord(original.id, unpaid.id);
    expect((await verify(payment, restrictedCookie)).statusCode).toBe(403);
  });
  it("checks out and settles only the outstanding balance after a partial payment", async () => {
    const original = await visit({ status: "confirmed", paymentStatus: "pending" });
    const partial = await invoice(original.id, { status: "partially_paid", amountPaid: 200, balanceDue: 400, payments: [{ amount: 200, paymentMethod: "cash" }] });
    const orderId = `order_${new mongoose.Types.ObjectId()}`;
    const createOrder = vi.spyOn(razorpayService, "createOrder").mockResolvedValue({ id: orderId } as never);
    vi.spyOn(razorpayService, "getPublicParams").mockResolvedValue({ keyId: "fixture" } as never);
    const checkout = () => app.inject({ method: "POST", url: "/api/appointment-payments/create-order", headers: { cookie: rootCookie }, payload: { appointmentId: original.id } });
    expect((await checkout()).json().data.amount).toBe(400);
    expect((await checkout()).json().data.amount).toBe(400);
    expect(createOrder).toHaveBeenCalledOnce();
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 400, currency: "INR" }));
    const payment = await AppointmentPayment.findOne({ razorpayOrderId: orderId });
    expect((await verify(payment)).statusCode).toBe(200);
    const paid = await Invoice.findById(partial.id);
    expect(paid).toMatchObject({ amountPaid: 600, balanceDue: 0, status: "paid" });
    expect(paid?.payments.map((receipt: { amount: number }) => receipt.amount)).toEqual([200, 400]);
  });
  it("collects counter payment once, returning current visit state and invoice currency", async () => {
    const original = await visit({ paymentStatus: "pending" }); const unpaid = await invoice(original.id, { status: "unpaid", amountPaid: 0, balanceDue: 600, payments: [], currency: "USD" });
    const collect = () => app.inject({ method: "POST", url: "/api/appointment-payments/collect-counter", headers: { cookie: rootCookie }, payload: { appointmentId: original.id, paymentMethod: "cash" } });
    const results = await Promise.all([collect(), collect()]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(result => result.statusCode === 200)!.json().data.appointment.paymentStatus).toBe("paid");
    expect((await Invoice.findById(unpaid.id))?.payments).toHaveLength(1);
    const payment = await AppointmentPayment.findOne({ invoiceId: unpaid._id });
    expect(payment?.currency).toBe("USD");
  });
  it("rejects reconciliation evidence with a mismatched provider amount", async () => {
    const original = await visit({ paymentStatus: "pending" }); const unpaid = await invoice(original.id, { status: "unpaid", amountPaid: 0, balanceDue: 600, payments: [] });
    const payment = await paymentRecord(original.id, unpaid.id, "created");
    vi.spyOn(razorpayService, "getCredentials").mockResolvedValue({ keyId: "fixture", keySecret: "fixture", webhookSecret: "fixture" });
    vi.spyOn(resilientHttpClient, "request").mockResolvedValue({ data: { items: [{ id: `pay_${payment.id}`, status: "captured", amount: 100, currency: "INR", order_id: payment.razorpayOrderId }] } } as never);
    const result = await app.inject({ method: "POST", url: "/api/appointment-payments/reconcile", headers: { cookie: rootCookie }, payload: { appointmentId: original.id } });
    expect(result.statusCode).toBe(409);
    expect((await AppointmentPayment.findById(payment.id))?.status).toBe("created");
    expect((await Invoice.findById(unpaid.id))?.amountPaid).toBe(0);
  });
});
