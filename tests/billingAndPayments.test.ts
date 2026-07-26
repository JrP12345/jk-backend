import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { Claim } from "../models/Claim.ts";
import { OrgMember } from "../models/OrgMember.ts";
import bcrypt from "bcryptjs";

describe("Milestone 7: Billing & Payments Platform Integration Tests", () => {
  it("should create medical invoice, generate online payment link, and collect payment", async () => {
    const org = await Organization.create({ name: "Billing Test Health System", city: "Chennai" });
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "Billing Ward Clinic",
      city: "Chennai",
      address: "100 Finance Ave",
    });

    const staffUser = await User.create({
      name: "Billing Officer",
      email: "billing_officer@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    await OrgMember.create({
      organizationId: org._id,
      userId: staffUser._id,
      role: "admin",
    });

    const doctorUser = await User.create({
      name: "Dr. Billing Attending",
      email: "dr_billing@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    const patientUser = await User.create({
      name: "Billing Patient",
      email: "billing_patient@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "patient",
    });

    const patient = await Patient.create({
      userId: patientUser._id,
      organizationId: org._id,
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.8.0.1",
      payload: { email: "billing_officer@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // 1. Create Invoice
    const invoiceRes = await app.inject({
      method: "POST",
      url: "/api/invoices",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        patientId: patient._id.toString(),
        clinicId: clinic._id.toString(),
        doctorId: doctorUser._id.toString(),
        items: [
          { description: "General OPD Consultation", amount: 500, quantity: 1 },
          { description: "CBC Blood Panel Test", amount: 350, quantity: 1 },
        ],
        subtotal: 850,
        tax: 50,
        discount: 0,
        totalAmount: 900,
      },
    });

    expect(invoiceRes.statusCode).toBe(201);
    const invoice = JSON.parse(invoiceRes.body).data;
    expect(invoice.totalAmount).toBe(900);
    expect(invoice.status).toBe("unpaid");

    // 2. Generate Payment Link
    const payLinkRes = await app.inject({
      method: "POST",
      url: "/api/billing/payment-link",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        invoiceId: invoice.id,
        amount: 900,
        customerEmail: "billing_patient@ananta.internal",
      },
    });

    expect(payLinkRes.statusCode).toBe(200);
    const payLinkData = JSON.parse(payLinkRes.body).data;
    expect(payLinkData.checkoutUrl).toContain("pay.ananta.health");

    // 3. Collect Payment
    const payRes = await app.inject({
      method: "PUT",
      url: `/api/invoices/${invoice.id}/pay`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        paymentMethod: "upi",
      },
    });

    expect(payRes.statusCode).toBe(200);
    const paidInvoice = JSON.parse(payRes.body).data;
    expect(paidInvoice.status).toBe("paid");
  });

  it("should submit and adjudicate medical insurance claim", async () => {
    const org = await Organization.create({ name: "Insurance Test Org", city: "Mumbai" });
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "Insurance Clinic",
      city: "Mumbai",
      address: "55 Claims St",
    });

    const staffUser = await User.create({
      name: "Claims Manager",
      email: "claims_mgr@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    await OrgMember.create({
      organizationId: org._id,
      userId: staffUser._id,
      role: "admin",
    });

    const patientUser = await User.create({
      name: "Insured Patient",
      email: "insured_patient@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "patient",
    });

    const patient = await Patient.create({
      userId: patientUser._id,
      organizationId: org._id,
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.8.0.2",
      payload: { email: "claims_mgr@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // 1. Submit Claim
    const submitClaimRes = await app.inject({
      method: "POST",
      url: "/api/billing/claims",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        clinicId: clinic._id.toString(),
        patientId: patient._id.toString(),
        payerName: "Star Health Insurance",
        policyNumber: "SHI-99887766",
        preAuthCode: "AUTH-12345",
        totalClaimAmount: 15000,
      },
    });

    expect(submitClaimRes.statusCode).toBe(201);
    const claim = JSON.parse(submitClaimRes.body).data;
    expect(claim.claimNumber).toContain("CLM-");
    expect(claim.status).toBe("submitted");

    // 2. Adjudicate Claim
    const adjudicateRes = await app.inject({
      method: "POST",
      url: `/api/billing/claims/${claim.id}/adjudicate`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        status: "approved",
        approvedAmount: 13500,
        copayAmount: 1000,
        deductibleAmount: 500,
      },
    });

    expect(adjudicateRes.statusCode).toBe(200);
    const adjudicatedClaim = JSON.parse(adjudicateRes.body).data;
    expect(adjudicatedClaim.status).toBe("approved");
    expect(adjudicatedClaim.approvedAmount).toBe(13500);

    // 3. List Claims
    const getClaimsRes = await app.inject({
      method: "GET",
      url: `/api/billing/claims?patientId=${patient._id.toString()}`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(getClaimsRes.statusCode).toBe(200);
    const claimsList = JSON.parse(getClaimsRes.body).data;
    expect(claimsList.length).toBe(1);
  });
});
