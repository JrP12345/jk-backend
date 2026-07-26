import type { FastifyInstance } from "fastify";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Clinic } from "../models/Clinic.ts";
import { authenticate } from "../middleware/auth.ts";
import { generatePrintablePrescriptionHtml } from "../utilities/prescriptionFormatter.ts";

export default async function prescriptionPrintRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/api/v1/encounters/:encounterId/prescription/print",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { encounterId } = request.params as { encounterId: string };

      try {
        const note = await ClinicalNote.findOne({ encounterId, isLatest: true })
          .populate("patientId")
          .populate("doctorId", "name role")
          .populate("clinicId", "name address phone")
          .lean() as any;

        const prescriptions = await Prescription.find({ encounterId }).lean() as any[];

        if (!note && prescriptions.length === 0) {
          return reply.code(404).send({ error: "Prescription or Encounter not found" });
        }

        const patientUser = note?.patientId?.userId ? await User.findById(note.patientId.userId).lean() : null;
        const doctorUser = note?.doctorId;
        const clinic = note?.clinicId;

        const html = generatePrintablePrescriptionHtml({
          clinicName: clinic?.name || "ANANTA Healthcare Clinic",
          clinicAddress: clinic?.address || "Main Street Branch",
          clinicPhone: clinic?.phone || "+91-800-000-0000",
          doctorName: doctorUser?.name || "Dr. Rajesh Sharma",
          doctorSpecialty: "General Medicine & Primary Care",
          patientName: patientUser?.name || "Valued Patient",
          patientAge: note?.patientId?.dob ? new Date().getFullYear() - new Date(note.patientId.dob).getFullYear() : undefined,
          patientGender: note?.patientId?.gender || "Other",
          encounterDate: note?.createdAt ? new Date(note.createdAt).toLocaleDateString() : new Date().toLocaleDateString(),
          diagnoses: note?.assessment?.diagnoses?.map((d: any) => d.description || d.code) || [],
          medications: prescriptions.map((p) => ({
            medicineName: p.medicineName,
            dosage: p.dosage,
            frequency: p.frequency,
            duration: p.duration,
            instructions: p.instructions,
          })),
        });

        reply.type("text/html").send(html);
      } catch (err: any) {
        fastify.log.error("Failed to generate printable prescription HTML:", err);
        return reply.code(500).send({ error: "Internal server error generating prescription PDF" });
      }
    }
  );
}
