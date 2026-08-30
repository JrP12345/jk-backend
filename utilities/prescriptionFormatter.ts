export interface PrintPrescriptionData {
  clinicName: string;
  clinicAddress: string;
  clinicPhone: string;
  doctorName: string;
  doctorSpecialty: string;
  doctorLicenseNumber?: string;
  patientName: string;
  patientAge?: number;
  patientGender?: string;
  patientAddress?: string;
  encounterDate: string;
  chiefComplaint?: string;
  diagnoses: string[];
  vitals?: { bp?: string; pulse?: number; temp?: string; weight?: string };
  medications: Array<{
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string;
  }>;
  doctorSignatureUrl?: string;
}

export function generatePrintablePrescriptionHtml(data: PrintPrescriptionData): string {
  const medsRows = data.medications
    .map(
      (m, i) => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${i + 1}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: bold;">${m.medicineName}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${m.dosage}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${m.frequency}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${m.duration}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${m.instructions || "-"}</td>
    </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Prescription - ${data.patientName}</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1f2937; margin: 0; padding: 24px; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 16px; }
    .clinic-title { font-size: 20px; font-weight: bold; color: #1e40af; }
    .doctor-title { font-size: 16px; font-weight: bold; color: #1f2937; text-align: right; }
    .patient-bar { background: #f3f4f6; padding: 12px; rounded: 8px; margin-bottom: 20px; border-radius: 6px; display: flex; justify-content: space-between; }
    .rx-symbol { font-size: 28px; font-weight: bold; color: #2563eb; margin: 12px 0 6px 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { background: #eff6ff; color: #1e40af; text-align: left; padding: 10px 8px; border-bottom: 2px solid #bfdbfe; font-size: 12px; text-transform: uppercase; }
    .footer { margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end; }
    .signature-box { text-align: center; width: 200px; }
    .signature-line { border-top: 1px solid #9ca3af; margin-top: 40px; padding-top: 4px; font-size: 12px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="clinic-title">${data.clinicName}</div>
      <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${data.clinicAddress} | Tel: ${data.clinicPhone}</div>
    </div>
    <div class="doctor-title">
      ${data.doctorName}<br>
      <span style="font-size: 12px; font-weight: normal; color: #4b5563;">${data.doctorSpecialty} ${data.doctorLicenseNumber ? `(Reg: ${data.doctorLicenseNumber})` : ""}</span>
    </div>
  </div>

  <div class="patient-bar">
    <div>
      <strong>Patient:</strong> ${data.patientName} &nbsp;|&nbsp; 
      <strong>Age/Gender:</strong> ${data.patientAge || "N/A"} / ${data.patientGender || "N/A"}
    </div>
    <div>
      <strong>Date:</strong> ${data.encounterDate}
    </div>
  </div>

  ${data.diagnoses && data.diagnoses.length > 0 ? `<div style="margin-bottom: 16px; font-size: 13px;"><strong>Diagnoses:</strong> ${data.diagnoses.join(", ")}</div>` : ""}

  <div class="rx-symbol">Rx</div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Medicine Name</th>
        <th>Dosage</th>
        <th>Frequency</th>
        <th>Duration</th>
        <th>Instructions</th>
      </tr>
    </thead>
    <tbody>
      ${medsRows}
    </tbody>
  </table>

  <div class="footer">
    <div style="font-size: 11px; color: #6b7280;">
      ANANT Digital Health Record &bull; Generated on ${new Date().toLocaleString()}
    </div>
    <div class="signature-box">
      ${data.doctorSignatureUrl ? `<img src="${data.doctorSignatureUrl}" style="max-height: 40px; margin-bottom: 4px;">` : ""}
      <div class="signature-line">${data.doctorName}</div>
    </div>
  </div>
</body>
</html>
  `;
}
