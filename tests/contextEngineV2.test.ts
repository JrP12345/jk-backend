import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { contextEngine } from "../services/ai/ContextEngine.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";

describe("Phase 3: Context Engine v2 6D Context Tests", () => {
  let testPatientId: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    const org = await (Organization as any).create({
      name: "6D Context Test Hospital",
      email: `ctx_org_${Date.now()}@ananta.internal`,
      phone: "+1999777555",
      address: "300 Context Way",
      city: "San Francisco",
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email: `ctx_pat_${Date.now()}@ananta.internal`,
      name: "Maria Context",
      password: "Password123!",
      role: "patient",
      organizationId: org._id
    });
    testUserId = (user as any)._id.toString();

    const patient = await (Patient as any).create({
      userId: (user as any)._id,
      organizationId: org._id,
      dob: new Date("1985-05-15"),
      gender: "female",
      conditions: ["Severe Bronchial Asthma", "Acute Bronchitis"]
    });
    testPatientId = (patient as any)._id.toString();
  });

  afterAll(async () => {
    await Patient.deleteMany({ _id: testPatientId });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should build 6-dimensional context including Route, PHR, Role, and Organization", async () => {
    const context = await contextEngine.build6DContext({
      currentRoute: "/dashboard/patients/chart",
      activePatientId: testPatientId,
      userRole: "doctor",
      organizationId: testOrgId
    });

    expect(context.routeContext).toContain("/dashboard/patients/chart");
    expect(context.roleContext).toContain("doctor");
    expect(context.organizationContext).toContain(testOrgId);
    expect(context.patientRecordContext).toContain("Maria Context");
    expect(context.patientRecordContext).toContain("Severe Bronchial Asthma");
    expect(context.fullContextSummary).toBeDefined();
  });
});
