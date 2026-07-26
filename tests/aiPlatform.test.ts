import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import bcrypt from "bcryptjs";

import { OrgMember } from "../models/OrgMember.ts";

describe("Milestone 5: AI Platform Infrastructure Tests", () => {
  it("should generate structured SOAP clinical note draft using AIService", async () => {
    const doctorUser = await User.create({
      name: "Dr. AI User",
      email: "dr_ai_soap@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.6.0.1",
      payload: { email: "dr_ai_soap@ananta.internal", password: "Password123!" },
    });
    expect(loginRes.statusCode).toBe(200);

    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const soapRes = await app.inject({
      method: "POST",
      url: "/api/ai/soap-notes/generate",
      remoteAddress: "10.6.0.2",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        chiefComplaint: "Acute high fever and productive cough for 3 days",
        vitals: { bp: "128/82", pulse: 88, temp: 101.4, respRate: 20, spO2: 96 },
        examinationFindings: "Bilateral basal crackles on auscultation. Throat mild erythema.",
        history: "History of mild seasonal asthma.",
      },
    });

    expect(soapRes.statusCode).toBe(200);
    const draft = JSON.parse(soapRes.body).data;

    expect(draft.subjective).toContain("Acute high fever");
    expect(draft.objective).toContain("101.4");
    expect(draft.assessment).toBeDefined();
    expect(draft.plan).toBeDefined();
    expect(draft.suggestedICD10).toBeDefined();
  });

  it("should query grounded patient health query assistant with RAG context", async () => {
    const org = await Organization.create({ name: "AI Health Assistant Org", city: "Delhi" });
    const doctorUser = await User.create({
      name: "Dr. Health Query Host",
      email: "dr_rag_query@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    const patientUser = await User.create({
      name: "RAG Patient",
      email: "rag_patient@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "patient",
    });

    const patient = await Patient.create({
      userId: patientUser._id,
      organizationId: org._id,
      bloodGroup: "O+",
      allergies: ["Penicillin"],
      conditions: ["Hypertension"],
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.6.0.3",
      payload: { email: "dr_rag_query@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const queryRes = await app.inject({
      method: "POST",
      url: "/api/ai/health-assistant/query",
      remoteAddress: "10.6.0.4",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        patientId: patient._id.toString(),
        query: "What active allergies or chronic conditions does this patient have?",
      },
    });

    expect(queryRes.statusCode).toBe(200);
    const result = JSON.parse(queryRes.body).data;

    expect(result.answer).toBeDefined();
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.disclaimer).toContain("ANANTA AI Health Assistant");
  });

  it("should evaluate CDS clinical safety checks and persist clinician overrides", async () => {
    const org = await Organization.create({ name: "CDS Test Org", city: "Pune" });
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "CDS Clinic",
      city: "Pune",
      address: "1 Medical Park",
    });

    const doctorUser = await User.create({
      name: "Dr. CDS Evaluator",
      email: "dr_cds_eval@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    await OrgMember.create({
      organizationId: org._id,
      userId: doctorUser._id,
      role: "admin",
    });

    const patientUser = await User.create({
      name: "Allergic Patient",
      email: "allergic_patient@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "patient",
    });

    const patient = await Patient.create({
      userId: patientUser._id,
      organizationId: org._id,
      allergies: ["Amoxicillin"],
      conditions: ["Asthma"],
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.6.0.5",
      payload: { email: "dr_cds_eval@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // 1. Evaluate safety
    const evalRes = await app.inject({
      method: "POST",
      url: "/api/prescriptions/evaluate-safety",
      remoteAddress: "10.6.0.6",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        patientId: patient._id.toString(),
        proposedPrescriptions: [{ medicineName: "Amoxicillin 500mg" }],
      },
    });

    expect(evalRes.statusCode).toBe(200);
    const evalData = JSON.parse(evalRes.body).data;
    expect(evalData.findings.length).toBeGreaterThan(0);

    // 2. Persist override decision
    const overrideRes = await app.inject({
      method: "POST",
      url: "/api/prescriptions/override-evaluation",
      remoteAddress: "10.6.0.7",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        clinicId: clinic._id.toString(),
        patientId: patient._id.toString(),
        findings: evalData.findings,
        clinicianDecision: "overridden",
        overrideReason: "Desensitization therapy completed under allergist supervision.",
      },
    });

    expect(overrideRes.statusCode).toBe(201);
    const persistedDoc = await CDSEvaluation.findById(JSON.parse(overrideRes.body).data.id);
    expect(persistedDoc?.clinicianDecision).toBe("overridden");
    expect(persistedDoc?.overrideReason).toContain("Desensitization therapy");
  });
});
