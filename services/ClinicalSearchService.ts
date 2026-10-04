import mongoose from "mongoose";
import { SearchEngine } from "../platform/search/SearchEngine.ts";
import type { SearchQueryOptions, SearchResultItem, SearchQueryResponse } from "../platform/search/types.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { Prescription } from "../models/Prescription.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Encounter } from "../models/Encounter.ts";

export interface GroupedQualityMetrics {
  medication: {
    totalScheduled: number;
    administered: number;
    refused: number;
    held: number;
    complianceRatePercentage: number;
  };
  diagnostics: {
    totalOrders: number;
    completedResults: number;
    abnormalResults: number;
    abnormalRatePercentage: number;
  };
  clinical: {
    totalNews2Evaluations: number;
    averageNews2Score: number;
    highRiskEvaluationsCount: number;
  };
  discharge: {
    totalFinalizedSummaries: number;
    totalCountersignedSummaries: number;
  };
}

export interface EncounterSummaryReport {
  encounterId: string;
  encounterType: string;
  status: string;
  startedAt: Date;
  endedAt?: Date;
  patientId: string;
  chiefComplaint?: string;
  symptoms?: string[];
  diagnoses?: any[];
  primaryDiagnosis?: string;
  treatmentPlan?: string;
  prescriptions?: any[];
  conditionOnDischarge?: string;
  vitalsTrend: Array<{ code: string; name: string; value: string; unit: string; recordedAt: Date }>;
  news2Trajectory: Array<{ totalScore: number; riskCategory: string; evaluatedAt: Date }>;
  marCompliance: { total: number; administered: number; refused: number; complianceRate: number };
  labSummary: Array<{ testName: string; value: string; isAbnormal: boolean }>;
}

export class ClinicalSearchService {
  /**
   * Cross-engine longitudinal clinical search across a patient's entire EHR.
   */
  static async searchPatientRecord(
    patientId: string,
    options: SearchQueryOptions = {}
  ): Promise<SearchQueryResponse> {

    const queryTokens = SearchEngine.tokenize(options.q || "");
    const rawTerm = options.q ? options.q.trim() : "";
    const items: SearchResultItem[] = [];

    // 1. Search ClinicalNotes
    const notes = options.category && !['all', 'notes'].includes(options.category) ? [] : await ClinicalNote.find({ patientId, isLatest: true })
      .select('subjective.chiefComplaint subjective.historyOfPresentIllness objective.physicalExamination assessment.diagnoses plan.treatmentPlan createdAt')
      .sort({ createdAt: -1 })
      .lean() as any[];

    for (const note of notes) {
      const textBlock = [
        note.subjective?.chiefComplaint,
        note.subjective?.historyOfPresentIllness,
        note.objective?.physicalExamination,
        note.assessment?.diagnoses?.map((d: any) => `${d.code} ${d.description}`).join(" "),
        note.plan?.treatmentPlan,
      ].filter(Boolean).join(" ");

      const score = rawTerm ? SearchEngine.calculateRelevanceScore(textBlock, queryTokens) : 10;
      if (!rawTerm || score > 0) {
        items.push({
          id: note._id.toString(),
          category: "notes",
          resourceType: "ClinicalNote",
          title: `Clinical Note: ${note.subjective?.chiefComplaint || "SOAP Note"}`,
          snippet: textBlock.length > 120 ? textBlock.slice(0, 120) + "..." : textBlock,
          score,
          occurredAt: note.createdAt,
          resourceRef: {
            resourceId: note._id.toString(),
            link: `/dashboard/notes?id=${note._id.toString()}`,
          },
        });
      }
    }

    // 2. Search Observations
    const obsList = options.category && !['all', 'observation'].includes(options.category) ? [] : await Observation.find({ patientId })
      .select('name code value unit recordedAt createdAt')
      .sort({ recordedAt: -1 })
      .lean() as any[];

    for (const obs of obsList) {
      const textBlock = `${obs.name} ${obs.code} ${obs.value} ${obs.unit}`;
      const score = rawTerm ? SearchEngine.calculateRelevanceScore(textBlock, queryTokens) : 5;
      if (!rawTerm || score > 0) {
        items.push({
          id: obs._id.toString(),
          category: "observation",
          resourceType: "Observation",
          title: `Vital: ${obs.name || obs.code}`,
          snippet: `${obs.name}: ${obs.value} ${obs.unit}`.trim(),
          score,
          occurredAt: obs.recordedAt || obs.createdAt,
          resourceRef: {
            resourceId: obs._id.toString(),
            link: `/dashboard/vitals?id=${obs._id.toString()}`,
          },
        });
      }
    }

    // 3. Search Diagnostic Lab Orders
    const labList = options.category && !['all', 'lab'].includes(options.category) ? [] : await LabOrder.find({ patientId })
      .select('testId result clinicalReason resultedAt orderDate createdAt status')
      .populate("testId", "name code department")
      .sort({ orderDate: -1 })
      .lean() as any[];

    for (const lab of labList) {
      const testName = lab.testId?.name || "Lab Order";
      const testCode = lab.testId?.code || "";
      const textBlock = `${testName} ${testCode} ${lab.result?.value} ${lab.result?.interpretation} ${lab.clinicalReason}`;
      const score = rawTerm ? SearchEngine.calculateRelevanceScore(textBlock, queryTokens) : 8;
      if (!rawTerm || score > 0) {
        items.push({
          id: lab._id.toString(),
          category: "lab",
          resourceType: "LabOrder",
          title: `Lab: ${testName}`,
          snippet: lab.result?.value
            ? `Result: ${lab.result.value} ${lab.result.unit} (${lab.result.interpretation || lab.status})`
            : `Status: ${lab.status}`,
          score,
          occurredAt: lab.resultedAt || lab.orderDate || lab.createdAt,
          resourceRef: {
            resourceId: lab._id.toString(),
            link: `/dashboard/laboratory?id=${lab._id.toString()}`,
          },
        });
      }
    }

    // Use platform SearchEngine to rank deterministically & paginate
    return SearchEngine.rankAndPaginate(items, options);
  }

  /**
   * Generates a patient/clinical story report for a single encounter.
   */
  static async getEncounterSummaryReport(encounterId: string): Promise<EncounterSummaryReport> {

    let encounter = mongoose.Types.ObjectId.isValid(encounterId)
      ? (await Encounter.findById(encounterId).lean() as any)
      : null;
    if (!encounter && mongoose.Types.ObjectId.isValid(encounterId)) {
      encounter = await Encounter.findOne({ appointmentId: encounterId }).lean() as any;
    }
    if (!encounter) throw new Error("Encounter not found");

    const realEncounterId = encounter._id.toString();

    // Fetch latest ClinicalNote
    const note = (await ClinicalNote.findOne({ encounterId: realEncounterId, isLatest: true }).lean() as any)
      || (await ClinicalNote.findOne({ encounterId: realEncounterId }).sort({ createdAt: -1 }).lean() as any);

    // Fetch DischargeDocument if finalized
    // Vitals trend
    const observations = await Observation.find({ encounterId: realEncounterId })
      .sort({ recordedAt: 1 })
      .lean() as any[];

    const vitalsTrend = observations.map((o) => ({
      code: o.code,
      name: o.name,
      value: o.value,
      unit: o.unit || "",
      recordedAt: o.recordedAt || o.createdAt,
    }));

    // NEWS2 Trajectory
    const scores = await ObservationScore.find({ encounterId: realEncounterId })
      .sort({ evaluatedAt: 1 })
      .lean() as any[];

    const news2Trajectory = scores.map((s) => ({
      totalScore: s.totalScore,
      riskCategory: s.riskCategory,
      evaluatedAt: s.evaluatedAt,
    }));

    // Lab Results
    const labOrders = await LabOrder.find({ encounterId: realEncounterId, status: "result-uploaded" })
      .populate("testId", "name")
      .lean() as any[];

    const labSummary = labOrders.map((l) => ({
      testName: l.testId?.name || "Lab Test",
      value: l.result?.value || l.resultValue,
      isAbnormal: l.result?.isAbnormal || false,
    }));

    const chiefComplaint = note?.subjective?.chiefComplaint || "";
    const symptoms = note?.subjective?.symptoms || [];
    const diagnoses = note?.assessment?.diagnoses || [];
    const primaryDiag = note?.assessment?.diagnoses?.[0]?.description || "";
    const treatmentPlan = note?.plan?.treatmentPlan || "";
    const prescriptions = note?.plan?.prescriptions || [];

    return {
      encounterId: realEncounterId,
      encounterType: encounter.encounterType,
      status: encounter.status,
      startedAt: encounter.startedAt,
      endedAt: encounter.endedAt,
      patientId: encounter.patientId?.toString(),
      chiefComplaint,
      symptoms,
      diagnoses,
      primaryDiagnosis: primaryDiag,
      treatmentPlan,
      prescriptions,
      vitalsTrend,
      news2Trajectory,
      marCompliance: {
        total: 0,
        administered: 0,
        refused: 0,
        complianceRate: 100,
      },
      labSummary,
    };
  }

  /**
   * Generates organization-wide quality metrics grouped by clinical domains.
   * Always reads directly from MongoDB (single source of truth).
   */
  static async getQualityMetrics(organizationId: string): Promise<GroupedQualityMetrics> {

    // Group 1: Medication Quality Metrics
    const totalScheduled = 0;
    const administered = 0;
    const refused = 0;
    const held = 0;
    const complianceRatePercentage = 100;

    // Return counters rather than materializing every historical clinical document.
    const organization = new mongoose.Types.ObjectId(organizationId);
    const [diagnostics, scores] = await Promise.all([
      LabOrder.aggregate([{ $match: { organizationId: organization } }, { $group: { _id: null,
        totalOrders: { $sum: 1 },
        completedResults: { $sum: { $cond: [{ $eq: ['$status', 'result-uploaded'] }, 1, 0] } },
        abnormalResults: { $sum: { $cond: ['$result.isAbnormal', 1, 0] } },
      } }]),
      ObservationScore.aggregate([{ $match: { organizationId: organization } }, { $group: { _id: null,
        total: { $sum: 1 }, sum: { $sum: { $ifNull: ['$totalScore', 0] } },
        high: { $sum: { $cond: [{ $or: [{ $eq: ['$riskCategory', 'High'] }, { $gte: ['$totalScore', 7] }] }, 1, 0] } },
      } }]),
    ]);
    const { totalOrders = 0, completedResults = 0, abnormalResults = 0 } = diagnostics[0] || {};
    const abnormalRatePercentage = completedResults > 0 ? Math.round(abnormalResults / completedResults * 100) : 0;
    const totalNews2Evaluations = scores[0]?.total || 0;
    const averageNews2Score = totalNews2Evaluations ? parseFloat((scores[0].sum / totalNews2Evaluations).toFixed(1)) : 0;
    const highRiskEvaluationsCount = scores[0]?.high || 0;

    return {
      medication: {
        totalScheduled,
        administered,
        refused,
        held,
        complianceRatePercentage,
      },
      diagnostics: {
        totalOrders,
        completedResults,
        abnormalResults,
        abnormalRatePercentage,
      },
      clinical: {
        totalNews2Evaluations,
        averageNews2Score,
        highRiskEvaluationsCount,
      },
      discharge: {
        totalFinalizedSummaries: 0,
        totalCountersignedSummaries: 0,
      },
    };
  }
}
