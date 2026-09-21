import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { SoapTemplate } from "../models/SoapTemplate.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

export async function getSoapTemplates(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { specialty } = req.query as { specialty?: string };
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;

    const filter: any = {
      $or: [{ isPublic: true }],
    };

    if (orgId) {
      filter.$or.push({ organizationId: orgId });
    }

    if (specialty) {
      filter.specialty = new RegExp(specialty, "i");
    }

    const templates = await SoapTemplate.find(filter).sort({ title: 1 });
    return reply.code(200).send(successResponse(templates));
  } catch (err) {
    console.error("getSoapTemplates error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function createSoapTemplate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const { title, specialty, subjective, objective, assessment, plan, isPublic } = req.body as any;

    if (!title || !specialty) {
      return reply.code(400).send(errorResponse("title and specialty are required"));
    }

    const template = await SoapTemplate.create({
      title: title.trim(),
      specialty: specialty.trim(),
      subjective: subjective || "",
      objective: objective || "",
      assessment: assessment || "",
      plan: plan || "",
      createdBy: userId,
      organizationId: orgId || undefined,
      isPublic: isPublic !== undefined ? isPublic : true,
    });

    return reply.code(201).send(successResponse(template, "SOAP template created successfully"));
  } catch (err) {
    console.error("createSoapTemplate error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function seedDefaultSoapTemplates(req: FastifyRequest, reply: FastifyReply) {
  try {
    const count = await SoapTemplate.countDocuments();
    if (count > 0) {
      return reply.code(200).send(successResponse(null, `Catalog already has ${count} SOAP templates`));
    }

    const defaults = [
      {
        title: "General Medicine Outpatient Routine",
        specialty: "General Medicine",
        subjective: "Patient presents with mild fever and fatigue for 2 days. No shortness of breath or chest pain.",
        objective: "Vitals: BP 120/80 mmHg, HR 78 bpm, Temp 37.2°C, SpO2 98%. Chest clear on auscultation.",
        assessment: "Acute Viral Upper Respiratory Infection.",
        plan: "1. Paracetamol 500mg PO TDS PRN for fever.\n2. Hydration & rest.\n3. Follow up if symptoms worsen in 3 days.",
        isPublic: true,
      },
      {
        title: "Cardiology Follow-Up",
        specialty: "Cardiology",
        subjective: "Follow-up for essential hypertension and hyperlipidemia. Reports compliance with anti-hypertensives.",
        objective: "Vitals: BP 128/82 mmHg, HR 68 bpm. S1, S2 present, no murmurs or peripheral edema.",
        assessment: "Essential Hypertension - Well Controlled.",
        plan: "1. Continue Telmisartan 40mg OD.\n2. Repeat Lipid Profile in 3 months.\n3. Low sodium diet.",
        isPublic: true,
      },
      {
        title: "Pediatric Wellness & Growth Check",
        specialty: "Pediatrics",
        subjective: "Child brought in for routine growth checkup and vaccination review. Active, eating well.",
        objective: "Weight 14kg (50th percentile), Height 96cm. Ears, nose, throat normal. Milestones appropriate.",
        assessment: "Healthy pediatric growth and development.",
        plan: "1. Administer scheduled booster vaccine.\n2. Routine nutritional advice.",
        isPublic: true,
      },
    ];

    const inserted = await SoapTemplate.insertMany(defaults);
    return reply.code(201).send(successResponse(inserted, `Seeded ${inserted.length} default SOAP templates`));
  } catch (err) {
    console.error("seedDefaultSoapTemplates error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
