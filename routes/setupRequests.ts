import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { authenticate, requirePlatformRoot } from "../middleware/auth.ts";
import { SetupRequest } from "../models/SetupRequest.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

export default async function setupRequestRoutes(app: FastifyInstance) {
  app.post("/api/public/setup-requests", {
    config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 5, timeWindow: "15 minutes" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["requestKey", "organization", "city", "name", "email"], properties: {
      requestKey: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" },
      organization: { type: "string", minLength: 1, maxLength: 200 },
      city: { type: "string", minLength: 1, maxLength: 100 },
      name: { type: "string", minLength: 1, maxLength: 100 },
      email: { type: "string", maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
      planSlug: { type: "string", maxLength: 100 },
    } } },
  }, async (req, reply) => {
    const body = req.body as { requestKey: string; organization: string; city: string; name: string; email: string; planSlug?: string };
    if (![body.organization, body.city, body.name].every(value => value.trim())) return reply.code(400).send(errorResponse("Please complete your practice and contact details"));
    const plan = body.planSlug ? await SaaSPlan.findOne({ slug: body.planSlug, status: "active" }).lean() : null;
    if (body.planSlug && !plan) return reply.code(400).send(errorResponse("This plan is unavailable. Choose another plan or request help choosing."));
    // Retrying an uncertain network response stores a single request. Never return contact data publicly.
    try {
      await SetupRequest.updateOne({ requestKey: body.requestKey }, { $setOnInsert: {
        requestKey: body.requestKey, organization: body.organization.trim(), city: body.city.trim(),
        name: body.name.trim(), email: body.email.trim().toLowerCase(), planSlug: plan?.slug || "", planName: plan?.name || "Help me choose a plan", status: "new",
      } }, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    return reply.code(201).send(successResponse(null, "Setup request received"));
  });

  const root = { preHandler: [authenticate, requirePlatformRoot(), async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (req.user?.role !== "root" || req.user.impersonatedBy) return reply.code(403).send(errorResponse("Return to your platform root account to review setup requests"));
  }] };
  app.get("/api/admin/setup-requests", { ...root, schema: { querystring: { type: "object", additionalProperties: false, properties: {
    status: { type: "string", enum: ["new", "contacted", "closed"] },
    cursor: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
  } } } }, async (req, reply) => {
    const { status, cursor } = req.query as { status?: "new" | "contacted" | "closed"; cursor?: string };
    const records = await SetupRequest.find({ ...(status ? { status } : {}), ...(cursor ? { _id: { $lt: new mongoose.Types.ObjectId(cursor) } } : {}) })
      .select("organization city name email planSlug planName status createdAt updatedAt").sort({ _id: -1 }).limit(51).lean();
    const items = records.slice(0, 50).map(({ _id, ...record }) => ({ ...record, id: _id.toString() }));
    return reply.send(successResponse({ items, nextCursor: records.length > 50 ? items.at(-1)!.id : null }));
  });
  app.patch("/api/admin/setup-requests/:id", { ...root, schema: {
    params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } } },
    body: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["new", "contacted", "closed"] } } },
  } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: string };
    const request = await SetupRequest.findByIdAndUpdate(id, { $set: { status, reviewedBy: req.user!.id } }, { returnDocument: "after", runValidators: true });
    if (!request) return reply.code(404).send(errorResponse("Setup request not found"));
    return reply.send(successResponse(null, "Request status updated"));
  });
}
