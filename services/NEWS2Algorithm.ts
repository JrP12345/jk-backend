import type {
  ClinicalScoringAlgorithm,
  ParameterSubScore,
  ScoringResult,
} from "../types/scoring.ts";

export class NEWS2Algorithm implements ClinicalScoringAlgorithm {
  id = "NEWS2";
  name = "National Early Warning Score 2 (NEWS2)";
  version = "1.0.0";

  evaluate(observations: Array<{ id?: string; code: string; value: any; unit?: string }>): ScoringResult {
    const obsMap = new Map<string, { value: any; unit?: string; id?: string }>();
    const obsIds: string[] = [];

    for (const obs of observations) {
      const code = obs.code?.toUpperCase();
      if (code) {
        obsMap.set(code, obs);
        if (obs.id) obsIds.push(obs.id);
      }
    }

    const requiredParams = ["RR", "SPO2", "OXYGEN", "BP_SYS", "PULSE", "AVPU", "TEMP"];
    const missingParameters: string[] = [];
    const parameterBreakdown: ParameterSubScore[] = [];

    let totalScore = 0;

    // 1. Respiration Rate (RR)
    const rrObs = obsMap.get("RR") || obsMap.get("RESPIRATION_RATE");
    if (rrObs && typeof Number(rrObs.value) === "number" && !isNaN(Number(rrObs.value))) {
      const val = Number(rrObs.value);
      let sub = 0;
      if (val <= 8 || val >= 25) sub = 3;
      else if (val >= 21 && val <= 24) sub = 2;
      else if (val >= 9 && val <= 11) sub = 1;
      else sub = 0;

      totalScore += sub;
      parameterBreakdown.push({
        parameter: "Respiration Rate",
        rawValue: val,
        normalizedValue: val,
        unit: "breaths/min",
        subScore: sub,
      });
    } else {
      missingParameters.push("Respiration Rate");
    }

    // 2. SpO2 Scale 1
    const spo2Obs = obsMap.get("SPO2") || obsMap.get("OXYGEN_SATURATION");
    if (spo2Obs && typeof Number(spo2Obs.value) === "number" && !isNaN(Number(spo2Obs.value))) {
      const val = Number(spo2Obs.value);
      let sub = 0;
      if (val <= 91) sub = 3;
      else if (val >= 92 && val <= 93) sub = 2;
      else if (val >= 94 && val <= 95) sub = 1;
      else sub = 0;

      totalScore += sub;
      parameterBreakdown.push({
        parameter: "SpO2 Scale 1",
        rawValue: val,
        normalizedValue: val,
        unit: "%",
        subScore: sub,
      });
    } else {
      missingParameters.push("SpO2");
    }

    // 3. Air or Supplemental Oxygen
    const o2Obs = obsMap.get("OXYGEN") || obsMap.get("AIR_OR_OXYGEN");
    if (o2Obs) {
      const valStr = String(o2Obs.value).toLowerCase();
      const isOxygen = valStr.includes("oxygen") || valStr.includes("o2") || valStr === "true" || valStr === "yes";
      const sub = isOxygen ? 2 : 0;

      totalScore += sub;
      parameterBreakdown.push({
        parameter: "Air or Supplemental Oxygen",
        rawValue: o2Obs.value,
        normalizedValue: isOxygen ? "Supplemental Oxygen" : "Air",
        unit: "",
        subScore: sub,
      });
    } else {
      // Default to Air if not explicitly specified
      parameterBreakdown.push({
        parameter: "Air or Supplemental Oxygen",
        rawValue: "Air",
        normalizedValue: "Air",
        unit: "",
        subScore: 0,
      });
    }

    // 4. Systolic Blood Pressure
    const bpObs = obsMap.get("BP_SYS") || obsMap.get("SYSTOLIC_BP") || obsMap.get("BP");
    if (bpObs) {
      let sysVal = Number(bpObs.value);
      if (isNaN(sysVal) && typeof bpObs.value === "string" && bpObs.value.includes("/")) {
        sysVal = Number(bpObs.value.split("/")[0]);
      }

      if (!isNaN(sysVal)) {
        let sub = 0;
        if (sysVal <= 90 || sysVal >= 220) sub = 3;
        else if (sysVal >= 91 && sysVal <= 100) sub = 2;
        else if (sysVal >= 101 && sysVal <= 110) sub = 1;
        else sub = 0;

        totalScore += sub;
        parameterBreakdown.push({
          parameter: "Systolic Blood Pressure",
          rawValue: bpObs.value,
          normalizedValue: sysVal,
          unit: "mmHg",
          subScore: sub,
        });
      } else {
        missingParameters.push("Systolic Blood Pressure");
      }
    } else {
      missingParameters.push("Systolic Blood Pressure");
    }

    // 5. Pulse / Heart Rate
    const hrObs = obsMap.get("PULSE") || obsMap.get("HEART_RATE") || obsMap.get("HR");
    if (hrObs && typeof Number(hrObs.value) === "number" && !isNaN(Number(hrObs.value))) {
      const val = Number(hrObs.value);
      let sub = 0;
      if (val <= 40 || val >= 131) sub = 3;
      else if (val >= 111 && val <= 130) sub = 2;
      else if ((val >= 41 && val <= 50) || (val >= 91 && val <= 110)) sub = 1;
      else sub = 0;

      totalScore += sub;
      parameterBreakdown.push({
        parameter: "Pulse Rate",
        rawValue: val,
        normalizedValue: val,
        unit: "bpm",
        subScore: sub,
      });
    } else {
      missingParameters.push("Pulse Rate");
    }

    // 6. Consciousness (AVPU)
    const avpuObs = obsMap.get("AVPU") || obsMap.get("CONSCIOUSNESS");
    if (avpuObs) {
      const valStr = String(avpuObs.value).toUpperCase().trim();
      const isAlert = valStr === "A" || valStr === "ALERT";
      const sub = isAlert ? 0 : 3;

      totalScore += sub;
      parameterBreakdown.push({
        parameter: "Consciousness (AVPU)",
        rawValue: avpuObs.value,
        normalizedValue: isAlert ? "Alert (A)" : `Confusion/Voice/Pain/Unresponsive (${valStr})`,
        unit: "",
        subScore: sub,
      });
    } else {
      // Default to Alert if omitted
      parameterBreakdown.push({
        parameter: "Consciousness (AVPU)",
        rawValue: "Alert",
        normalizedValue: "Alert (A)",
        unit: "",
        subScore: 0,
      });
    }

    // 7. Temperature (°F -> °C normalization)
    const tempObs = obsMap.get("TEMP") || obsMap.get("TEMPERATURE");
    if (tempObs && typeof Number(tempObs.value) === "number" && !isNaN(Number(tempObs.value))) {
      let valC = Number(tempObs.value);
      const unit = (tempObs.unit || "F").toUpperCase();

      // Normalize °F -> °C
      if (unit.includes("F") || valC > 50) {
        valC = Math.round(((valC - 32) * (5 / 9)) * 10) / 10;
      }

      let sub = 0;
      if (valC <= 35.0) sub = 3;
      else if (valC >= 39.1) sub = 2;
      else if ((valC >= 35.1 && valC <= 36.0) || (valC >= 38.1 && valC <= 39.0)) sub = 1;
      else sub = 0;

      totalScore += sub;
      parameterBreakdown.push({
        parameter: "Temperature",
        rawValue: tempObs.value,
        normalizedValue: valC,
        unit: "°C",
        subScore: sub,
      });
    } else {
      missingParameters.push("Temperature");
    }

    // Determine Risk Tier according to Royal College of Physicians NEWS2 Guidelines
    let riskCategory: "Low" | "Low-Medium" | "Medium" | "High" = "Low";
    const hasSingleExtreme3 = parameterBreakdown.some((p) => p.subScore === 3);

    if (totalScore >= 7 || hasSingleExtreme3) {
      riskCategory = "High";
    } else if (totalScore >= 5 && totalScore <= 6) {
      riskCategory = "Medium";
    } else if (totalScore >= 1 && totalScore <= 4) {
      riskCategory = hasSingleExtreme3 ? "Low-Medium" : "Low";
    }

    return {
      algorithmId: this.id,
      algorithmVersion: this.version,
      totalScore,
      riskCategory,
      isComplete: missingParameters.length === 0,
      missingParameters,
      parameterBreakdown,
      observationIds: obsIds,
      evaluatedAt: new Date(),
    };
  }
}
