import type { FHIRDiagnosticReport } from "../types.ts";
import { CodeSystems } from "../TerminologyResolver.ts";

export class DiagnosticReportMapper {
  public static toFHIR(labOrder: any): FHIRDiagnosticReport {
    const reportId = labOrder._id?.toString() || labOrder.id?.toString() || "unknown";
    const patientId = labOrder.patientId?._id?.toString() || labOrder.patientId?.toString() || "unknown";
    const encounterId = labOrder.encounterId?._id?.toString() || labOrder.encounterId?.toString();

    const testName = labOrder.testId?.name || "Lab Diagnostic Test";
    const testCode = labOrder.testId?.code || "LAB";

    let fhirStatus: FHIRDiagnosticReport["status"] = "preliminary";
    if (labOrder.status === "result-uploaded") {
      fhirStatus = "final";
    }

    const resultValue = labOrder.result?.value || labOrder.resultValue || "";
    const resultUnit = labOrder.result?.unit || "";

    return {
      resourceType: "DiagnosticReport",
      id: reportId,
      status: fhirStatus,
      code: {
        coding: [
          {
            system: CodeSystems.LOINC,
            code: testCode,
            display: testName,
          },
        ],
        text: testName,
      },
      subject: {
        reference: `Patient/${patientId}`,
      },
      ...(encounterId ? { encounter: { reference: `Encounter/${encounterId}` } } : {}),
      effectiveDateTime: labOrder.orderDate ? new Date(labOrder.orderDate).toISOString() : undefined,
      issued: labOrder.resultedAt ? new Date(labOrder.resultedAt).toISOString() : undefined,
      conclusion: resultValue ? `${resultValue}${resultUnit ? " " + resultUnit : ""}` : `Status: ${labOrder.status}`,
    };
  }
}
