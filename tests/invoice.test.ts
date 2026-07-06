import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";

describe("Invoice & Payment API Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let invoiceId: string;

  it("should setup basic requirements", async () => {
    // 1. Create org + admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Surat Medical Invoicing",
        city: "Surat",
        admin_name: "Yash Chopra",
        admin_email: "yash@test.com",
        admin_password: "Password123",
      },
    });
    adminCookies = bootstrapRes.headers["set-cookie"] as string[];

    // 2. Create clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Billing Hub", city: "Surat" },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register patient
    const patRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Raj Kapoor", email: "raj@test.com", password: "Password123" },
    });
    const patUser = await User.findOne({ email: "raj@test.com" });
    const patProfile = await Patient.findOne({ userId: patUser!._id });
    patientId = patProfile!._id.toString();
  });

  it("should successfully create a manual invoice with custom itemizations", async () => {
    const docUser = await User.findOne({ email: "yash@test.com" });
    
    const response = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        patientId: patientId,
        doctorId: docUser!._id.toString(),
        items: [
          { description: "First Consultation", quantity: 1, amount: 300 },
          { description: "Suture kit", quantity: 2, amount: 150 },
        ],
        subtotal: 600,
        tax: 30, // 5% GST
        discount: 50,
        totalAmount: 580,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("unpaid");
    expect(body.data.totalAmount).toBe(580);
    invoiceId = body.data.id;
  });

  it("should retrieve list of invoices and retrieve detailed itemization data", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/invoices?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.success).toBe(true);
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);

    const detailsRes = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(detailsRes.statusCode).toBe(200);
    const detailsBody = JSON.parse(detailsRes.body);
    expect(detailsBody.success).toBe(true);
    expect(detailsBody.data.totalAmount).toBe(580);
    expect(detailsBody.data.items.length).toBe(2);
  });

  it("should collect cash payment and update invoice state to paid", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/invoices/${invoiceId}/pay`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        paymentMethod: "cash",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("paid");

    // Double check status in DB
    const finalInvoice = await Invoice.findById(invoiceId);
    expect(finalInvoice!.status).toBe("paid");
  });
});
