import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { LabOrder } from "../models/LabOrder.ts";

export class FhirR4ConverterService {
  public static toFhirPatient(patientDoc: any): any {
    const user = patientDoc.userId || {};
    const fullName = user.name || "Patient name unavailable";
    const nameParts = fullName.split(" ");
    const family = nameParts.length > 1 ? nameParts[nameParts.length - 1] : fullName;
    const given = nameParts.length > 1 ? nameParts.slice(0, -1) : [fullName];

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
          text: fullName,
          family,
          given,
        },
      ],
      telecom: [
        { system: "phone", value: user.phone || "" },
        { system: "email", value: user.email || "" },
      ],
      ...(patientDoc.gender ? { gender: patientDoc.gender } : {}),
      ...(patientDoc.dob ? { birthDate: new Date(patientDoc.dob).toISOString().split("T")[0] } : {}),
    };
  }

  public static toFhirEncounter(encounterDoc: any): any {
    const encType = (encounterDoc.encounterType || encounterDoc.type || "opd").toLowerCase();
    const isIpd = encType === "ipd" || encType === "inpatient";

    return {
      resourceType: "Encounter",
      id: encounterDoc.id || encounterDoc._id?.toString(),
      status: encounterDoc.status === "completed" || encounterDoc.status === "discharged" ? "finished" : "in-progress",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: isIpd ? "IMP" : "AMB",
        display: isIpd ? "inpatient encounter" : "ambulatory",
      },
      ...(encounterDoc.patientId ? { subject: { reference: `Patient/${encounterDoc.patientId.toString()}` } } : {}),
      ...(encounterDoc.createdAt ? { period: { start: new Date(encounterDoc.createdAt).toISOString() } } : {}),
    };
  }

  public static toFhirObservation(encounterDoc: any): any {
    const vitals = encounterDoc.vitals || {};
    const encId = encounterDoc.encounterId ? encounterDoc.encounterId.toString() : (encounterDoc.id || encounterDoc._id?.toString());
    const resource: any = {
      resourceType: "Observation",
      id: encounterDoc.id || encounterDoc._id?.toString(),
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
      ...(encounterDoc.code ? { code: { coding: [{ system: "http://loinc.org", code: encounterDoc.code, display: encounterDoc.name || encounterDoc.code }], text: encounterDoc.name || encounterDoc.code } } : {}),
      ...(encounterDoc.patientId ? { subject: { reference: `Patient/${encounterDoc.patientId.toString()}` } } : {}),
      ...(encId ? { encounter: { reference: `Encounter/${encId}` } } : {}),
      ...(encounterDoc.createdAt ? { effectiveDateTime: new Date(encounterDoc.createdAt).toISOString() } : {}),
    };
    const components: any[] = [];
    if (vitals.systolic !== undefined) components.push({ code: { coding: [{ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }] }, valueQuantity: { value: vitals.systolic, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } });
    if (vitals.diastolic !== undefined) components.push({ code: { coding: [{ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" }] }, valueQuantity: { value: vitals.diastolic, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } });
    if (encounterDoc.value !== undefined && encounterDoc.value !== "") {
      const numericValue = Number(encounterDoc.value);
      const hasNumericValue = Number.isFinite(numericValue);
      resource[hasNumericValue ? "valueQuantity" : "valueString"] = hasNumericValue
        ? { value: numericValue, ...(encounterDoc.unit ? { unit: encounterDoc.unit } : {}) }
        : String(encounterDoc.value);
    }
    if (components.length) resource.component = components;
    return resource;
  }

  public static toFhirDiagnosticReport(labOrderDoc: any): any {
    const report: any = {
      resourceType: "DiagnosticReport",
      id: labOrderDoc.id || labOrderDoc._id?.toString(),
      status: labOrderDoc.status === "result-uploaded" || labOrderDoc.status === "completed" ? "final" : "registered",
      ...(labOrderDoc.testId?.code ? { code: { coding: [{ system: "http://loinc.org", code: labOrderDoc.testId.code, display: labOrderDoc.testId.name || labOrderDoc.testId.code }], text: labOrderDoc.testId.name || labOrderDoc.testId.code } } : {}),
      ...(labOrderDoc.patientId ? { subject: { reference: `Patient/${labOrderDoc.patientId.toString()}` } } : {}),
      ...(labOrderDoc.completedDate ? { issued: new Date(labOrderDoc.completedDate).toISOString() } : {}),
    };
    const conclusion = labOrderDoc.resultValue || labOrderDoc.result?.value;
    if (conclusion) report.conclusion = conclusion;
    return report;
  }

  public static toFhirMedicationAdministration(marDoc: any): any {
    const isCompleted = marDoc.status === "given" || marDoc.status === "completed" || marDoc.status === "administered";
    return {
      resourceType: "MedicationAdministration",
      id: marDoc.id || marDoc._id?.toString(),
      status: isCompleted ? "completed" : "in-progress",
      ...(marDoc.patientId ? { subject: { reference: `Patient/${marDoc.patientId.toString()}` } } : {}),
      ...(marDoc.administeredTime || marDoc.scheduledTime ? { effectiveDateTime: new Date(marDoc.administeredTime || marDoc.scheduledTime).toISOString() } : {}),
      medicationCodeableConcept: {
        text: marDoc.medicineName,
      },
      dosage: {
        route: {
          coding: [
            {
              system: "http://snomed.info/sct",
              code: marDoc.route,
              display: marDoc.route,
            },
          ],
        },
      },
    };
  }

  public static toFhirComposition(encounterDoc: any): any {
    const composition: any = {
      resourceType: "Composition",
      id: encounterDoc.id || encounterDoc._id?.toString(),
      status: "final",
      type: {
        coding: [
          {
            system: "http://loinc.org",
            code: "11503-6",
            display: "Medical records",
          },
        ],
        text: "Clinical Note & Encounter Summary",
      },
      subject: {
        reference: `Patient/${encounterDoc.patientId?.toString() || "unknown"}`,
      },
      date: encounterDoc.createdAt ? new Date(encounterDoc.createdAt).toISOString() : new Date().toISOString(),
      title: "ANANTA Clinical Encounter Summary",
      extension: [],
    };

    if (encounterDoc.snapshotHash) {
      composition.extension.push({
        url: "https://healthos.ananta.org/fhir/StructureDefinition/snapshot-hash",
        valueString: encounterDoc.snapshotHash,
      });
    } else {
      delete composition.extension;
    }

    return composition;
  }

  public static toFhirBundle(patientDoc: any, encounters: any[] = [], labOrders: any[] = [], mars: any[] = [], notes: any[] = []): any {
    const patientResource = this.toFhirPatient(patientDoc);
    const entries = [
      { resource: patientResource },
      ...encounters.map((e) => ({ resource: this.toFhirEncounter(e) })),
      ...encounters.map((e) => ({ resource: this.toFhirObservation(e) })),
      ...labOrders.map((l) => ({ resource: this.toFhirDiagnosticReport(l) })),
      ...mars.map((m) => ({ resource: this.toFhirMedicationAdministration(m) })),
      ...(notes.length > 0 ? notes.map((n) => ({ resource: this.toFhirComposition(n) })) : encounters.map((e) => ({ resource: this.toFhirComposition(e) }))),
    ];

    return {
      resourceType: "Bundle",
      id: `bundle-${patientDoc.id || patientDoc._id?.toString()}`,
      type: "document",
      total: entries.length,
      entry: entries,
    };
  }
}
