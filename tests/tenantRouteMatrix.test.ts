import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { ServiceCatalog } from "../models/ServiceCatalog.ts";
import { InsuranceTariff } from "../models/InsuranceTariff.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

describe("Tenant Authorization Route Matrix", () => {
  let orgA: any;
  let orgB: any;
  let adminA: any;
  let adminB: any;
  let rootAdmin: any;

  let cookieA: string;
  let cookieB: string;
  let rootCookie: string;

  beforeAll(async () => {
    await app.ready();

    await User.deleteMany({ email: { $in: ["adminA@matrix.test", "adminB@matrix.test", "root@matrix.test"] } });
    await Organization.deleteMany({ name: { $in: ["Matrix Org A", "Matrix Org B"] } });
    await ServiceCatalog.deleteMany({});
    await InsuranceTariff.deleteMany({});

    orgA = await Organization.create({
      name: "Matrix Org A",
      city: "City A",
    });

    orgB = await Organization.create({
      name: "Matrix Org B",
      city: "City B",
    });

    adminA = await User.create({
      name: "Admin A",
      email: "adminA@matrix.test",
      password: "Password123!",
      role: "admin",
    });
    await OrgMember.create({ userId: adminA._id, organizationId: orgA._id, role: "admin" });

    adminB = await User.create({
      name: "Admin B",
      email: "adminB@matrix.test",
      password: "Password123!",
      role: "admin",
    });
    await OrgMember.create({ userId: adminB._id, organizationId: orgB._id, role: "admin" });

    rootAdmin = await User.create({
      name: "Root Admin",
      email: "root@matrix.test",
      password: "Password123!",
      role: "root",
    });

    cookieA = `access_token=${generateAccessToken({
      id: adminA._id.toString(),
      email: adminA.email!,
      role: "admin",
      organization_id: orgA._id.toString(),
    })}`;
    cookieB = `access_token=${generateAccessToken({
      id: adminB._id.toString(),
      email: adminB.email!,
      role: "admin",
      organization_id: orgB._id.toString(),
    })}`;
    rootCookie = `access_token=${generateAccessToken({
      id: rootAdmin._id.toString(),
      email: rootAdmin.email!,
      role: "root",
    })}`;
  });

  describe("Service Catalog Tenant Boundary", () => {
    it("allows same-tenant creation", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/service-catalog",
        headers: { cookie: cookieA },
        payload: {
          code: "SRV-TEST-A",
          name: "Test Service A",
          department: "General",
          price: 500,
        },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body).data;
      expect(data.organizationId).toBe(orgA._id.toString());
    });

    it("rejects cross-tenant organizationId in request body with 403", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/service-catalog",
        headers: { cookie: cookieA },
        payload: {
          organizationId: orgB._id.toString(), // attempting cross-tenant injection
          code: "SRV-FORGED-B",
          name: "Forged Service for Org B",
          department: "General",
          price: 999,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/cross-tenant/i);
    });

    it("ignores forged x-organization-id header and strictly scopes to JWT tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/service-catalog",
        headers: {
          cookie: cookieA,
          "x-organization-id": orgB._id.toString(),
        },
        payload: {
          code: "SRV-HEADER-TEST",
          name: "Header Test Service",
          department: "General",
          price: 300,
        },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body).data;
      // Must be assigned to Org A, never Org B
      expect(data.organizationId).toBe(orgA._id.toString());
    });

    it("allows platform root super-admin to explicitly specify target organization", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/service-catalog",
        headers: { cookie: rootCookie },
        payload: {
          organizationId: orgB._id.toString(),
          code: "SRV-ROOT-CREATED",
          name: "Root Created Service",
          department: "General",
          price: 750,
        },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body).data;
      expect(data.organizationId).toBe(orgB._id.toString());
    });
  });

  describe("Patient Search and Details Tenant Boundary", () => {
    it("rejects cross-tenant organizationId in query with 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/patients?organizationId=${orgB._id.toString()}`,
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/cross-tenant/i);
    });
  });

  describe("Invoices Tenant Boundary", () => {
    it("rejects cross-tenant organizationId in invoices query with 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/invoices?organizationId=${orgB._id.toString()}`,
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/cross-tenant/i);
    });
  });

  describe("Insurance Tariff Tenant Boundary", () => {
    it("rejects cross-tenant organizationId in tariff upsert with 403", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/insurance/tariffs",
        headers: { cookie: cookieA },
        payload: {
          organizationId: orgB._id.toString(),
          tpaName: "Star Health",
          serviceCode: "SRV-TPA-01",
          serviceName: "Consultation",
          agreedRate: 400,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/cross-tenant/i);
    });
  });
});
