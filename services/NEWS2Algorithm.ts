import type { ClinicalScoringAlgorithm, ScoringResult, ParameterSubScore } from "../types/scoring.ts";

export class NEWS2Algorithm implements ClinicalScoringAlgorithm {
  id = "NEWS2";
  name = "National Early Warning Score 2";
  version = "2.0.0";

  evaluate(observations: Array<{ id?: string; code: string; value: any; unit?: string }>): ScoringResult {
    const obsMap = new Map<string, { id?: string; value: any; unit?: string }>();
    const observationIds: string[] = [];

    observations.forEach((o) => {
      const codeUpper = (o.code || "").toUpperCase();
      obsMap.set(codeUpper, o);
      if (o.id) observationIds.push(o.id);
    });

    const breakdown: ParameterSubScore[] = [];
    const missing: string[] = [];
    let totalScore = 0;

    // 1. Respiration Rate (RR)
    const rrObs = obsMap.get("RR") || obsMap.get("RESPIRATION_RATE") || obsMap.get("RESPIRATORY_RATE");
    if (rrObs !== undefined && rrObs.value !== undefined) {
      const rr = Number(rrObs.value);
      let sub = 0;
      if (rr <= 8) sub = 3;
      else if (rr >= 9 && rr <= 11) sub = 1;
      else if (rr >= 12 && rr <= 20) sub = 0;
      else if (rr >= 21 && rr <= 24) sub = 2;
      else if (rr >= 25) sub = 3;

      breakdown.push({
        parameter: "Respiration Rate",
        rawValue: rrObs.value,
        normalizedValue: rr,
        unit: rrObs.unit || "bpm",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      missing.push("Respiration Rate");
    }

    // 2. SpO2 Scale 1
    const spo2Obs = obsMap.get("SPO2") || obsMap.get("OXYGEN_SATURATION");
    if (spo2Obs !== undefined && spo2Obs.value !== undefined) {
      const spo2 = Number(spo2Obs.value);
      let sub = 0;
      if (spo2 <= 91) sub = 3;
      else if (spo2 >= 92 && spo2 <= 93) sub = 2;
      else if (spo2 >= 94 && spo2 <= 95) sub = 1;
      else if (spo2 >= 96) sub = 0;

      breakdown.push({
        parameter: "Oxygen Saturation (SpO2)",
        rawValue: spo2Obs.value,
        normalizedValue: spo2,
        unit: spo2Obs.unit || "%",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      missing.push("Oxygen Saturation");
    }

    // 3. Supplemental Oxygen
    const o2Obs = obsMap.get("O2_DELIVERY") || obsMap.get("SUPPLEMENTAL_O2") || obsMap.get("O2");
    if (o2Obs !== undefined && o2Obs.value !== undefined) {
      const isSupp = typeof o2Obs.value === "boolean" ? o2Obs.value : String(o2Obs.value).toLowerCase() === "yes" || String(o2Obs.value).toLowerCase() === "true";
      const sub = isSupp ? 2 : 0;
      breakdown.push({
        parameter: "Supplemental Oxygen",
        rawValue: o2Obs.value,
        normalizedValue: isSupp ? "Yes" : "No",
        unit: "",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      // Default to air (0)
      breakdown.push({
        parameter: "Supplemental Oxygen",
        rawValue: "Air",
        normalizedValue: "No",
        unit: "",
        subScore: 0,
      });
    }

    // 4. Systolic Blood Pressure (SBP)
    const sbpObs = obsMap.get("SBP") || obsMap.get("SYSTOLIC_BP") || obsMap.get("BP_SYSTOLIC");
    if (sbpObs !== undefined && sbpObs.value !== undefined) {
      const sbp = Number(sbpObs.value);
      let sub = 0;
      if (sbp <= 90) sub = 3;
      else if (sbp >= 91 && sbp <= 100) sub = 2;
      else if (sbp >= 101 && sbp <= 110) sub = 1;
      else if (sbp >= 111 && sbp <= 219) sub = 0;
      else if (sbp >= 220) sub = 3;

      breakdown.push({
        parameter: "Systolic Blood Pressure",
        rawValue: sbpObs.value,
        normalizedValue: sbp,
        unit: sbpObs.unit || "mmHg",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      missing.push("Systolic Blood Pressure");
    }

    // 5. Pulse / Heart Rate (HR)
    const hrObs = obsMap.get("HR") || obsMap.get("PULSE") || obsMap.get("HEART_RATE");
    if (hrObs !== undefined && hrObs.value !== undefined) {
      const hr = Number(hrObs.value);
      let sub = 0;
      if (hr <= 40) sub = 3;
      else if (hr >= 41 && hr <= 50) sub = 1;
      else if (hr >= 51 && hr <= 90) sub = 0;
      else if (hr >= 91 && hr <= 110) sub = 1;
      else if (hr >= 111 && hr <= 130) sub = 2;
      else if (hr >= 131) sub = 3;

      breakdown.push({
        parameter: "Pulse Rate",
        rawValue: hrObs.value,
        normalizedValue: hr,
        unit: hrObs.unit || "bpm",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      missing.push("Pulse Rate");
    }

    // 6. Consciousness (Alert / CVPU)
    const conObs = obsMap.get("CONSCIOUSNESS") || obsMap.get("AVPU") || obsMap.get("GCS");
    if (conObs !== undefined && conObs.value !== undefined) {
      const val = String(conObs.value).toUpperCase();
      const isAlert = val === "A" || val === "ALERT" || val === "NORMAL";
      const sub = isAlert ? 0 : 3;
      breakdown.push({
        parameter: "Consciousness Level",
        rawValue: conObs.value,
        normalizedValue: isAlert ? "Alert" : "CVPU",
        unit: "",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      // Default to Alert (0)
      breakdown.push({
        parameter: "Consciousness Level",
        rawValue: "Alert",
        normalizedValue: "Alert",
        unit: "",
        subScore: 0,
      });
    }

    // 7. Temperature
    const tempObs = obsMap.get("TEMP") || obsMap.get("TEMPERATURE");
    if (tempObs !== undefined && tempObs.value !== undefined) {
      const temp = Number(tempObs.value);
      let sub = 0;
      if (temp <= 35.0) sub = 3;
      else if (temp >= 35.1 && temp <= 36.0) sub = 1;
      else if (temp >= 36.1 && temp <= 38.0) sub = 0;
      else if (temp >= 38.1 && temp <= 39.0) sub = 1;
      else if (temp >= 39.1) sub = 2;

      breakdown.push({
        parameter: "Temperature",
        rawValue: tempObs.value,
        normalizedValue: temp,
        unit: tempObs.unit || "°C",
        subScore: sub,
      });
      totalScore += sub;
    } else {
      missing.push("Temperature");
    }

    // Determine Risk Category based on Royal College of Physicians standards
    let riskCategory: "Low" | "Low-Medium" | "Medium" | "High" = "Low";
    const hasSingleScore3 = breakdown.some((b) => b.subScore === 3);

    if (totalScore >= 7) {
      riskCategory = "High";
    } else if (totalScore >= 5 || hasSingleScore3) {
      riskCategory = totalScore >= 5 ? "Medium" : "Low-Medium";
    } else if (totalScore >= 1) {
      riskCategory = "Low";
    }

    return {
      algorithmId: this.id,
      algorithmVersion: this.version,
      totalScore,
      riskCategory,
      isComplete: missing.length === 0,
      missingParameters: missing,
      parameterBreakdown: breakdown,
      observationIds,
      evaluatedAt: new Date(),
    };
  }
}
