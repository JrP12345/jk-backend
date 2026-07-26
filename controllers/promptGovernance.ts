import type { FastifyRequest, FastifyReply } from "fastify";
import { AIPromptTemplate } from "../models/AIPromptTemplate.ts";
import { promptManager } from "../services/ai/PromptManager.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── GET /api/ai/prompts ────────────────────────────────────────────────
export async function listPromptTemplatesController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const templates = await AIPromptTemplate.find().sort({ key: 1, createdAt: -1 }).lean();
    return reply.code(200).send(successResponse(templates));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to list prompt templates"));
  }
}

// ─── POST /api/ai/prompts ───────────────────────────────────────────────
export async function createPromptDraftController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { key, version, title, description, systemPrompt, userPromptTemplate, temperature, requiredVariables } = req.body as any;

    if (!key || !version || !systemPrompt) {
      return reply.code(400).send(errorResponse("key, version, and systemPrompt are required"));
    }

    const template = await AIPromptTemplate.create({
      key,
      version,
      title: title || key,
      description,
      systemPrompt,
      userPromptTemplate: userPromptTemplate || "{{query}}",
      temperature: temperature || 0.2,
      requiredVariables: requiredVariables || ["query"],
      status: "draft",
      createdById: req.user?.id
    });

    return reply.code(201).send(successResponse(template, "Draft prompt template created"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Failed to create draft prompt template"));
  }
}

// ─── PUT /api/ai/prompts/:id/approve ───────────────────────────────────
export async function approvePromptTemplateController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    const template = await AIPromptTemplate.findById(id);
    if (!template) {
      return reply.code(404).send(errorResponse("Prompt template not found"));
    }

    // Deactivate previous active version for same key
    await AIPromptTemplate.updateMany({ key: template.key, status: "active" }, { status: "archived" });

    template.status = "active";
    template.approvedByUserId = req.user?.id as any;
    template.approvedAt = new Date();
    await template.save();

    return reply.code(200).send(successResponse(template, "Prompt template approved and set to active status"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to approve prompt template"));
  }
}

// ─── POST /api/ai/prompts/test ─────────────────────────────────────────
export async function testPromptSandboxController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { templateText, variables } = req.body as { templateText: string; variables: Record<string, any> };

    if (!templateText) {
      return reply.code(400).send(errorResponse("templateText is required"));
    }

    const compiled = promptManager.compileTemplate(templateText, variables || {});
    return reply.code(200).send(successResponse({ compiled }, "Prompt sandbox test compiled successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to compile test prompt"));
  }
}
