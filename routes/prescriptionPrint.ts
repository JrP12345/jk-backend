import type { FastifyInstance } from "fastify";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { generatePrintablePrescriptionHtml } from "../utilities/prescriptionFormatter.ts";
import { checkOperationalRecordAccess } from "../utilities/tenant.ts";

export default async function prescriptionPrintRoutes(fastify: FastifyInstance) {
  const printPrescription = {
    preHandler: [
      authenticate,
      requireModule("consultations"),
      checkAnyPermission("VIEW_EHR", "MANAGE_CLINICAL_NOTES"),
    ],
  };

  fastify.get(
    "/api/v1/encounters/:encounterId/prescription/print",
    printPrescription,
    async (request, reply) => {
      const { encounterId } = request.params as { encounterId: string };

      try {
        const note = await ClinicalNote.findOne({ encounterId, isLatest: true })
          .populate("patientId")
          .populate("doctorId", "name role")
          .populate("clinicId", "name address phone")
          .lean() as any;

        const prescriptions = await Prescription.find({ encounterId, deletedAt: null })
          .populate("patientId")
          .populate("doctorId", "name role")
          .populate("clinicId", "name address phone")
          .lean() as any[];

        if (!note && prescriptions.length === 0) {
          return reply.code(404).send({ error: "Prescription or Encounter not found" });
        }

        const scopedRecord = note || prescriptions[0];
        const access = await checkOperationalRecordAccess(request, scopedRecord);
        if (!access.allowed) return reply.code(access.statusCode).send({ error: access.message });

        const patient = note?.patientId || prescriptions[0]?.patientId;
        const doctorUser = note?.doctorId || prescriptions[0]?.doctorId;
        const clinic = note?.clinicId || prescriptions[0]?.clinicId;
        if (!patient || !doctorUser || !clinic) {
          return reply.code(422).send({ error: "Prescription is missing patient, clinician, or clinic identity" });
        }
        const patientUser = patient.userId ? await User.findById(patient.userId).lean() : null;
        if (!patientUser?.name || !doctorUser.name || !clinic.name) {
          return reply.code(422).send({ error: "Prescription identity references are incomplete" });
        }

        const html = generatePrintablePrescriptionHtml({
          clinicName: clinic.name,
          clinicAddress: clinic.address || "",
          clinicPhone: clinic.phone || "",
          doctorName: doctorUser.name,
          doctorSpecialty: "General Medicine & Primary Care",
          patientName: patientUser.name,
          patientAge: patient.dob ? new Date().getFullYear() - new Date(patient.dob).getFullYear() : undefined,
          patientGender: patient.gender,
          encounterDate: note?.createdAt ? new Date(note.createdAt).toLocaleDateString() : "",
          diagnoses: note?.assessment?.diagnoses?.map((d: any) => d.description || d.code) || [],
          medications: prescriptions.map((p) => ({
            medicineName: p.medicineName,
            dosage: p.dosage,
            frequency: p.frequency,
            duration: p.duration,
            instructions: p.instructions,
          })),
        });

        reply
          .type("text/html; charset=utf-8")
          .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: https:; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none';")
          .header("X-Content-Type-Options", "nosniff")
          .header("Referrer-Policy", "no-referrer")
          .send(html);
      } catch (err: any) {
        fastify.log.error("Failed to generate printable prescription HTML:", err);
        return reply.code(500).send({ error: "Internal server error generating prescription PDF" });
      }
    }
  );
}
