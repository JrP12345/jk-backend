import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { LabOrder } from "../models/LabOrder.ts";

export class FhirR4ConverterService {
  public static toFhirPatient(patientDoc: any): any {
    const user = patientDoc.userId || {};
    return {
      resourceType: "Patient",
      id: patientDoc.id || patientDoc._id?.toString(),
      identifier: [
        {
          system: "https://healthos.ananta.org/patient-id",
          value: patientDoc.id || patientDoc._id?.toString(),
        },
      ],
      active: true,
      name: [
        {
          use: "official",
          text: user.name || "Unknown Patient",
        },
      ],
      telecom: [
        { system: "phone", value: user.phone || "" },
        { system: "email", value: user.email || "" },
      ],
      gender: patientDoc.gender || "unknown",
      birthDate: patientDoc.dob ? new Date(patientDoc.dob).toISOString().split("T")[0] : undefined,
    };
  }

  public static toFhirObservation(encounterDoc: any): any {
    const vitals = encounterDoc.vitals || {};
    return {
      resourceType: "Observation",
      id: `obs-${encounterDoc.id || encounterDoc._id?.toString()}`,
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs",
              display: "Vital Signs",
            },
          ],
        },
      ],
      code: {
        coding: [
          {
            system: "http://loinc.org",
            code: "85354-9",
            display: "Blood pressure panel with all children optional",
          },
        ],
        text: "Vital Signs Panel",
      },
      subject: {
        reference: `Patient/${encounterDoc.patientId?.toString() || "unknown"}`,
      },
      effectiveDateTime: encounterDoc.createdAt ? new Date(encounterDoc.createdAt).toISOString() : new Date().toISOString(),
      component: [
        {
          code: { coding: [{ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }] },
          valueQuantity: { value: vitals.systolic || 120, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
        },
        {
          code: { coding: [{ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" }] },
          valueQuantity: { value: vitals.diastolic || 80, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
        },
      ],
    };
  }

  public static toFhirDiagnosticReport(labOrderDoc: any): any {
    return {
      resourceType: "DiagnosticReport",
      id: labOrderDoc.id || labOrderDoc._id?.toString(),
      status: labOrderDoc.status === "result-uploaded" ? "final" : "registered",
      code: {
        coding: [
          {
            system: "http://loinc.org",
            code: labOrderDoc.testId?.code || "LAB-001",
            display: labOrderDoc.testId?.name || "Diagnostic Test",
          },
        ],
        text: labOrderDoc.testId?.name || "Diagnostic Test",
      },
      subject: {
        reference: `Patient/${labOrderDoc.patientId?.toString() || "unknown"}`,
      },
      issued: labOrderDoc.completedDate ? new Date(labOrderDoc.completedDate).toISOString() : new Date().toISOString(),
      conclusion: labOrderDoc.resultValue || labOrderDoc.result?.value || "Pending",
    };
  }
}
