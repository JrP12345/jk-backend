import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { GeneticTestRecord } from "../models/GeneticTestRecord.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getGeneticRecords(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, panelType, geneticCounselingStatus, search } = req.query as {
      clinicId?: string;
      panelType?: string;
      geneticCounselingStatus?: string;
      search?: string;
    };

    const query: any = {
      deletedAt: null,
    };

    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      query.clinicId = new mongoose.Types.ObjectId(clinicId);
    } else if (user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      query.organizationId = new mongoose.Types.ObjectId(orgId);
    }

    if (panelType && panelType !== "ALL") query.panelType = panelType;
    if (geneticCounselingStatus && geneticCounselingStatus !== "ALL") query.geneticCounselingStatus = geneticCounselingStatus;

    if (search) {
      query.$or = [
        { sampleId: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
        { geneticCounselorName: { $regex: search, $options: "i" } },
        { "geneVariants.geneName": { $regex: search, $options: "i" } },
      ];
    }

    const records = await GeneticTestRecord.find(query).sort({ sampleCollectedDate: -1 });

    // KPI Metrics
    const totalSamples = records.length;
    let pathogenicCount = 0;
    records.forEach((r) => {
      if (r.geneVariants && r.geneVariants.some((v: any) => v.classification === "pathogenic" || v.classification === "likely_pathogenic")) {
        pathogenicCount++;
      }
    });

    const counselingPending = records.filter(
      (r) => r.geneticCounselingStatus === "counseling_scheduled" || r.geneticCounselingStatus === "variant_analysis"
    ).length;
    const sequencingActive = records.filter((r) => r.geneticCounselingStatus === "pending_sequencing").length;

    return reply.code(200).send(
      successResponse({
        records,
        metrics: {
          totalSamples,
          pathogenicCount,
          counselingPending,
          sequencingActive,
        },
      })
    );
  } catch (err) {
    console.error("getGeneticRecords error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching genetic test records"));
  }
}

export async function createGeneticRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      sampleId,
      patientName,
      patientAge,
      panelType,
      sequencingPlatform,
      geneVariants,
      actionableInsights,
      geneticCounselingStatus,
      geneticCounselorName,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!patientName || !panelType) {
      return reply.code(400).send(errorResponse("patientName and panelType are required"));
    }

    const generatedSampleId = sampleId || `GEN-${Date.now().toString().slice(-6)}`;

    const newRecord = await GeneticTestRecord.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      sampleId: generatedSampleId,
      patientName,
      patientAge: Number(patientAge) || 40,
      panelType,
      sequencingPlatform: sequencingPlatform || "Illumina NovaSeq 6000",
      geneVariants: geneVariants || [],
      actionableInsights: actionableInsights || "",
      geneticCounselingStatus: geneticCounselingStatus || "pending_sequencing",
      geneticCounselorName: geneticCounselorName || "Dr. Eleanor Vance, FACMG",
      notes: notes || "",
    });

    return reply.code(201).send(successResponse(newRecord, "Genetic test record created & sample registered successfully"));
  } catch (err) {
    console.error("createGeneticRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating genetic test record"));
  }
}

export async function updateGeneticStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { geneticCounselingStatus, geneVariants, actionableInsights, geneticCounselorName, notes } = req.body as {
      geneticCounselingStatus?: string;
      geneVariants?: any[];
      actionableInsights?: string;
      geneticCounselorName?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid genetic test record ID"));
    }

    const record = await GeneticTestRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Genetic test record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (geneticCounselingStatus) {
      record.geneticCounselingStatus = geneticCounselingStatus as any;
      if (geneticCounselingStatus === "completed") {
        record.reportDate = new Date();
      }
    }
    if (geneVariants) record.geneVariants = geneVariants as any;
    if (actionableInsights !== undefined) record.actionableInsights = actionableInsights;
    if (geneticCounselorName) record.geneticCounselorName = geneticCounselorName;
    if (notes !== undefined) record.notes = notes;

    await record.save();
    return reply.code(200).send(successResponse(record, "Genetic test status updated successfully"));
  } catch (err) {
    console.error("updateGeneticStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating genetic test record status"));
  }
}

export async function deleteGeneticRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid genetic test record ID"));
    }

    const record = await GeneticTestRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Genetic test record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    record.deletedAt = new Date();
    await record.save();

    return reply.code(200).send(successResponse(record, "Genetic test record deleted successfully"));
  } catch (err) {
    console.error("deleteGeneticRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting genetic test record"));
  }
}
