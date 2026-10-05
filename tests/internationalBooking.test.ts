import { describe, expect, it } from "vitest";
import app from "../index.ts";
import { Clinic } from "../models/Clinic.ts";
import { Invoice } from "../models/Invoice.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Counter } from "../models/Counter.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { Organization } from "../models/Organization.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { generateAccessToken } from "../utilities/helpers.ts";
import { vi } from "vitest";
import { clinicDateKey, clinicLocalTimeToDate } from "../utilities/clinicTime.ts";

describe("international clinic booking", () => {
  it("requires an explicit timezone for a Canadian organization", async () => {
    const suffix = Date.now();
    const response = await app.inject({
      method: "POST", url: "/api/onboarding/organization",
      payload: { org_name: `CA Clinic ${suffix}`, city: "Toronto", countryCode: "CA", currency: "CAD",
        admin_name: "CA Admin", admin_email: `ca-${suffix}@test.com`, admin_password: "Password123!" },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it("uses configured professional plan limits and respects a zero-day trial", async () => {
    const suffix = Date.now();
    const plan = await SaaSPlan.create({ name: "Configured Professional", slug: "professional", description: "Test plan",
      monthlyPrice: 100, annualPrice: 1000, trialDays: 0, limits: { maxClinics: 3, maxDoctors: 7, maxStaff: 9 } });
    const response = await app.inject({ method: "POST", url: "/api/onboarding/organization",
      payload: { org_name: `Plan Clinic ${suffix}`, city: "Mumbai", countryCode: "IN", plan: "pro",
        admin_name: "Plan Admin", admin_email: `plan-${suffix}@test.com`, admin_password: "Password123!" } });
    expect(response.statusCode, response.body).toBe(201);
    const org = response.json().data.organization;
    const storedOrg = await Organization.findById(org.id);
    expect(storedOrg?.maxClinics).toBe(3);
    expect(storedOrg?.maxDoctors).toBe(7);
    const subscription = await Subscription.findOne({ organizationId: org.id });
    expect(subscription?.planId.toString()).toBe(plan.id);
    expect(subscription?.trialEndsAt?.getTime()).toBe(subscription?.trialStartedAt?.getTime());
  });

  it("books at clinic local time, snapshots USD, and blocks INR checkout", async () => {
    const suffix = Date.now();
    const organization = await app.inject({
      method: "POST", url: "/api/onboarding/organization",
      payload: { org_name: `US Clinic ${suffix}`, city: "New York", countryCode: "US", currency: "USD",
        timezone: "America/New_York", admin_name: "US Admin", admin_email: `us-${suffix}@test.com`,
        admin_password: "Password123!" },
    });
    expect(organization.statusCode, organization.body).toBe(201);
    const organizationId = organization.json().data.organization.id;
    const cookies = (organization.headers["set-cookie"] as string[]).map(cookie => cookie.split(";")[0]).join("; ");
    const clinic = await Clinic.findOne({ organizationId });
    expect(clinic).toBeTruthy();

    const doctor = await app.inject({
      method: "POST", url: "/api/onboarding/doctor", headers: { cookie: cookies },
      payload: { name: "Dr International", email: `us-doctor-${suffix}@test.com`, password: "Password123!", specialization: "General" },
    });
    expect(doctor.statusCode, doctor.body).toBe(201);
    const doctorId = doctor.json().data.id;
    const assignment = await app.inject({
      method: "POST", url: "/api/onboarding/doctors/assignments", headers: { cookie: cookies },
      payload: { doctorId, clinicId: clinic!.id, fees: 125, workingHours: "09:00 - 17:00" },
    });
    expect(assignment.statusCode, assignment.body).toBe(201);

    let day = new Date(`${clinicDateKey(new Date(Date.now() + 3 * 86400000), "America/New_York")}T12:00:00Z`);
    if (day.getUTCDay() === 0) day = new Date(day.getTime() + 86400000);
    const dayKey = day.toISOString().slice(0, 10);
    const appointmentTime = clinicLocalTimeToDate(dayKey, "10:00", "America/New_York").toISOString();
    const booking = await app.inject({
      method: "POST", url: "/api/appointments", headers: { cookie: cookies },
      payload: { clinicId: clinic!.id, doctorId, appointmentTime, appointmentType: "online",
        patientDetails: { name: "US Patient", dob: "1990-01-01", gender: "other", phone: "+14155550199" } },
    });
    expect(booking.statusCode, booking.body).toBe(201);
    const appointmentId = booking.json().data.id;
    const invoice = await Invoice.findOne({ appointmentId });
    expect(invoice?.currency).toBe("USD");
    const patientUser = await User.create({ name: "International patient", email: `patient-${suffix}@test.com`, role: "patient" });
    await Patient.updateOne({ _id: booking.json().data.patientId }, { userId: patientUser._id });
    const patientCookie = `access_token=${generateAccessToken({ id: patientUser.id, email: patientUser.email!, role: "patient", organization_id: organizationId })}`;
    const patientInvoice = await app.inject({ method: "GET", url: `/api/invoices/${invoice!.id}`, headers: { cookie: patientCookie } });
    expect(patientInvoice.statusCode, patientInvoice.body).toBe(200);
    expect(patientInvoice.json().data.currency).toBe("USD");
    const manualInvoice = await app.inject({
      method: "POST", url: "/api/invoices", headers: { cookie: cookies },
      payload: { clinicId: clinic!.id, doctorId, patientId: booking.json().data.patientId,
        items: [{ description: "Taxable service", amount: 100, quantity: 1, gstRate: 5 }] },
    });
    expect(manualInvoice.statusCode, manualInvoice.body).toBe(409);
    const checkoutPreview = await app.inject({
      method: "GET", url: `/api/billing/checkout/preview/${appointmentId}`, headers: { cookie: cookies },
    });
    expect(checkoutPreview.statusCode, checkoutPreview.body).toBe(409);
    const checkout = await app.inject({
      method: "POST", url: "/api/appointment-payments/create-order", headers: { cookie: cookies },
      payload: { appointmentId },
    });
    expect(checkout.statusCode, checkout.body).toBe(409);
    const upi = await app.inject({
      method: "POST", url: "/api/appointment-payments/collect-counter", headers: { cookie: cookies },
      payload: { appointmentId, paymentMethod: "upi" },
    });
    expect(upi.statusCode, upi.body).toBe(409);
    const invoiceUpi = await app.inject({ method: "PUT", url: `/api/invoices/${invoice!.id}/pay`,
      headers: { cookie: cookies }, payload: { paymentMethod: "upi" } });
    expect(invoiceUpi.statusCode, invoiceUpi.body).toBe(409);
    const partialUpi = await app.inject({ method: "POST", url: `/api/invoices/${invoice!.id}/payments`,
      headers: { cookie: cookies }, payload: { idempotencyKey: "test-financial-internationalBooking_test_ts-1", paymentMethod: "upi", amount: 25 } });
    expect(partialUpi.statusCode, partialUpi.body).toBe(409);
    expect((await Invoice.findById(invoice!._id))?.status).toBe("unpaid");

    for (const invalidDate of ["2026-02-30", "2026-13-01", "2026-09-29T12:00:00Z", "invalid"]) {
      const invalidSlots = await app.inject({ method: "GET",
        url: `/api/public/doctors/${doctorId}/slots?clinicId=${clinic!.id}&date=${invalidDate}` });
      expect(invalidSlots.statusCode, invalidSlots.body).toBe(400);
    }

    const rescheduledTime = clinicLocalTimeToDate(dayKey, "23:30", "America/New_York").toISOString();
    await DoctorAssignment.updateOne({ clinicId: clinic!._id, doctorId }, { workingHours: JSON.stringify({ all: { start: "00:00", end: "23:59" } }) });
    const reschedule = await app.inject({ method: "PATCH", url: `/api/appointments/${appointmentId}/reschedule`,
      headers: { cookie: cookies }, payload: { newTime: rescheduledTime } });
    expect(reschedule.statusCode, reschedule.body).toBe(200);
    const tokenCounter = await Counter.findOne({ id: `token_${clinic!.id}_${doctorId}_${dayKey}` });
    expect(tokenCounter).toBeTruthy();
    expect(reschedule.json().data.tokenNumber).toBeGreaterThan(booking.json().data.tokenNumber);

    await Clinic.updateOne({ _id: clinic!._id }, { latitude: 40.7128, longitude: -74.006 });
    const branch = await app.inject({
      method: "PUT", url: `/api/onboarding/clinics/${clinic!.id}`, headers: { cookie: cookies },
      payload: { name: clinic!.name, city: clinic!.city, timezone: "America/Los_Angeles" },
    });
    expect(branch.statusCode, branch.body).toBe(200);
    expect(branch.json().data.latitude).toBe(40.7128);
    expect(branch.json().data.longitude).toBe(-74.006);
    const clinicList = await app.inject({ method: "GET", url: "/api/onboarding/clinics", headers: { cookie: cookies } });
    expect(clinicList.json().data.find((item: { id: string }) => item.id === clinic!.id)?.effectiveTimezone).toBe("America/Los_Angeles");
    const publicDetail = await app.inject({ method: "GET", url: `/api/public/clinics/${clinic!.id}` });
    expect(publicDetail.json().data.timezone).toBe("America/Los_Angeles");

    const receptionist = await app.inject({ method: "POST", url: "/api/onboarding/receptionist", headers: { cookie: cookies },
      payload: { name: "International reception", email: `reception-${suffix}@test.com`, password: "Password123!", clinicId: clinic!.id } });
    expect(receptionist.statusCode, receptionist.body).toBe(201);
    for (const email of [`us-doctor-${suffix}@test.com`, `reception-${suffix}@test.com`]) {
      const staffLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Password123!" } });
      expect(staffLogin.statusCode, staffLogin.body).toBe(200);
      const staffCookie = (staffLogin.headers["set-cookie"] as string[]).map(cookie => cookie.split(";")[0]).join("; ");
      const staffQueue = await app.inject({ method: "GET", url: `/api/queue?clinicId=${clinic!.id}&doctorId=${doctorId}&date=${dayKey}`,
        headers: { cookie: staffCookie } });
      expect(staffQueue.statusCode, staffQueue.body).toBe(200);
      expect(staffQueue.json().data.some((item: { id: string }) => item.id === appointmentId)).toBe(true);
    }

    const joinPayload = { clinicId: clinic!.id, doctorId, name: "Walk-in Patient", phone: "+14155550188" };
    const joined = await app.inject({ method: "POST", url: "/api/public/join-queue", payload: joinPayload });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(joined.json().data.trackingUrl).toContain("/track/");
    const duplicate = await app.inject({ method: "POST", url: "/api/public/join-queue", payload: joinPayload });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.body).not.toContain("trackerToken");

    const indianVisitor = await app.inject({ method: "POST", url: "/api/public/join-queue",
      payload: { ...joinPayload, name: "Indian visitor", phone: "+91 98765 43210" } });
    expect(indianVisitor.statusCode, indianVisitor.body).toBe(201);

    const joinedId = joined.json().data.appointmentId;
    const indianVisitorId = indianVisitor.json().data.appointmentId;
    await Appointment.updateMany({ _id: { $in: [joinedId, indianVisitorId] } }, { appointmentTime: new Date("2026-09-29T00:15:00Z") });
    await DoctorDayOverride.create({ organizationId, clinicId: clinic!._id, doctorId, date: "2026-09-28", status: "unavailable", reason: "Local-day leave" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T00:30:00Z"));
    try {
      const boundaryDetail = await app.inject({ method: "GET", url: `/api/public/clinics/${clinic!.id}` });
      const publicDoctor = boundaryDetail.json().data.doctors.find((item: { id: string }) => item.id === doctorId);
      expect(publicDoctor.waitingPatientsCount).toBe(2);
      expect(publicDoctor.isAvailable).toBe(false);
      expect(publicDoctor.overrideReason).toBe("Local-day leave");
      const tracker = await app.inject({ method: "GET", url: joined.json().data.trackingUrl.replace("/track/", "/api/public/track/") });
      expect(tracker.statusCode, tracker.body).toBe(200);
      expect(tracker.json().data.isToday).toBe(true);
      expect(tracker.json().data.clinic.timezone).toBe("America/Los_Angeles");
      expect(tracker.json().data.doctorAvailability.isAvailable).toBe(false);
      const queue = await app.inject({ method: "GET", url: `/api/queue?clinicId=${clinic!.id}&doctorId=${doctorId}`, headers: { cookie: cookies } });
      expect(queue.statusCode, queue.body).toBe(200);
      expect(queue.json().data.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([joinedId, indianVisitorId]));
    } finally {
      vi.useRealTimers();
    }
  });
});
