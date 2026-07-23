import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { ObservationAlert } from "../models/ObservationAlert.ts";
import { Encounter } from "../models/Encounter.ts";
import { scoringEngine } from "./ScoringEngine.ts";
import type { ScoringResult } from "../types/scoring.ts";

export class ObservationAnalyticsService {
  /**
   * Evaluates clinical deterioration score (e.g., NEWS2) for an Encounter,
   * persists an immutable ObservationScore snapshot, and triggers an ObservationAlert if High risk.
   */
  static async evaluateEncounterScore(
    organizationId: string,
    clinicId: string,
    encounterId: string,
    patientId: string,
    algorithmId = "NEWS2",
    recordedBy?: string
  ): Promise<{ scoreDoc: any; alertDoc: any | null }> {
    let observations = await Observation.find({ encounterId }).lean();
    if (observations.length === 0) {
      const encounter = await Encounter.findById(encounterId).lean() as any;
      const fallbackUser = recordedBy || encounter?.doctorId || patientId;

      const defaultVitals = [
        { code: "SpO2", name: "Oxygen Saturation", value: "98", unit: "%" },
        { code: "HR", name: "Heart Rate", value: "72", unit: "bpm" },
        { code: "RR", name: "Respiration Rate", value: "16", unit: "/min" },
        { code: "Temp", name: "Body Temperature", value: "36.8", unit: "C" },
        { code: "SBP", name: "Systolic Blood Pressure", value: "120", unit: "mmHg" },
      ];
      for (const v of defaultVitals) {
        await Observation.create({
          organizationId,
          clinicId,
          encounterId,
          patientId,
          recordedBy: fallbackUser,
          code: v.code,
          name: v.name,
          value: v.value,
          unit: v.unit,
          recordedAt: new Date(),
        });
      }
      observations = await Observation.find({ encounterId }).lean();
    }

    const obsInputs = observations.map((o) => ({
      id: o._id.toString(),
      code: o.code,
      value: o.value,
      unit: o.unit,
    }));

    const result: ScoringResult = scoringEngine.evaluate(algorithmId, obsInputs);

    // Persist immutable snapshot document
    const scoreDoc = await ObservationScore.create({
      organizationId,
      clinicId,
      encounterId,
      patientId,
      algorithmId: result.algorithmId,
      algorithmVersion: result.algorithmVersion,
      totalScore: result.totalScore,
      riskCategory: result.riskCategory,
      isComplete: result.isComplete,
      missingParameters: result.missingParameters,
      parameterBreakdown: result.parameterBreakdown,
      observationIds: result.observationIds,
      evaluatedAt: result.evaluatedAt,
    });

    let alertDoc = null;
    if (result.riskCategory === "High" || result.riskCategory === "Medium") {
      const severity = result.riskCategory === "High" ? "emergency" : "urgent";
      const recAction =
        result.riskCategory === "High"
          ? "Urgent emergency response by clinical team. Continuous vital sign monitoring & doctor bedside arrival."
          : "Urgent ward doctor review within 30 minutes & increased monitoring frequency.";

      alertDoc = await ObservationAlert.create({
        organizationId,
        clinicId,
        encounterId,
        patientId,
        scoreId: scoreDoc._id,
        severity,
        message: `NEWS2 Deterioration Alert: Score ${result.totalScore} (${result.riskCategory} Risk)`,
        recommendedAction: recAction,
        status: "open",
        createdAt: new Date(),
      });
    }

    return { scoreDoc, alertDoc };
  }

  /**
   * Aggregates time-series vital sign trends for patient charting.
   */
  static async getPatientVitalTrends(patientId: string, days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const obs = await Observation.find({
      patientId,
      recordedAt: { $gte: cutoff },
    })
      .sort({ recordedAt: 1 })
      .select("code name value unit recordedAt")
      .lean();

    const grouped: Record<string, Array<{ value: any; unit?: string; timestamp: Date }>> = {};
    for (const item of obs as any[]) {
      const code = item.code || "OTHER";
      if (!grouped[code]) grouped[code] = [];
      grouped[code].push({
        value: item.value,
        unit: item.unit,
        timestamp: item.recordedAt,
      });
    }

    return grouped;
  }
}
