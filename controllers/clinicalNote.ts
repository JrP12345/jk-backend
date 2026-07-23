import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { Prescription } from "../models/Prescription.ts";
import { Appointment } from "../models/Appointment.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function createEncounterController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const userId = req.user?.id;
    const { clinicId, appointmentId, patientId, doctorId, encounterType } = req.body as {
      clinicId: string;
      appointmentId?: string;
      patientId: string;
      doctorId?: string;
      encounterType?: string;
    };

    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));

    let finalClinicId = clinicId;
    let finalPatientId = patientId;

    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      const appt = await Appointment.findById(appointmentId).lean() as any;
      if (appt) {
        if (!finalClinicId || !mongoose.Types.ObjectId.isValid(finalClinicId)) {
          finalClinicId = appt.clinicId?._id?.toString() || appt.clinicId?.toString() || appt.clinicId;
        }
        if (!finalPatientId || !mongoose.Types.ObjectId.isValid(finalPatientId)) {
          finalPatientId = appt.patientId?._id?.toString() || appt.patientId?.toString() || appt.patientId;
        }
      }
    }

    if (!finalClinicId || !mongoose.Types.ObjectId.isValid(finalClinicId) || !finalPatientId || !mongoose.Types.ObjectId.isValid(finalPatientId)) {
      return reply.code(400).send(errorResponse("Valid clinicId and patientId are required"));
    }

    // Reuse existing active (in_progress) encounter for this appointment/patient session
    const existingFilter: any = { status: "in_progress" };
    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      existingFilter.appointmentId = appointmentId;
    } else {
      existingFilter.patientId = finalPatientId;
      existingFilter.clinicId = finalClinicId;
    }

    const existingEncounter = await Encounter.findOne(existingFilter).sort({ createdAt: -1 });
    if (existingEncounter) {
      return reply.code(200).send(successResponse(existingEncounter, "Active encounter retrieved"));
    }

    const encounter = await Encounter.create({
      organizationId: orgId,
      clinicId: finalClinicId,
      appointmentId: appointmentId || null,
      patientId: finalPatientId,
      doctorId: doctorId || userId,
      encounterType: (encounterType as any) || "opd",
      status: "in_progress",
      startedAt: new Date(),
    });

    return reply.code(201).send(successResponse(encounter, "Encounter started successfully"));
  } catch (err) {
    console.error("createEncounterController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function saveDraftClinicalNoteController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const userId = req.user?.id;
    const {
      clinicId,
      encounterId,
      patientId,
      chiefComplaint,
      historyOfPresentIllness,
      symptoms,
      physicalExamination,
      diagnoses,
      severity,
      treatmentPlan,
      vitals,
      prescriptions,
      followUpDate,
      followUpInstructions,
    } = req.body as any;

    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));
    if (!encounterId || !patientId || !chiefComplaint) {
      return reply.code(400).send(errorResponse("encounterId, patientId, and chiefComplaint are required"));
    }

    // 1. Record Generic Observations (vitals)
    const observationIds: mongoose.Types.ObjectId[] = [];
    if (vitals && typeof vitals === "object") {
      const vitalCodes: Array<{ code: string; name: string; value: any; unit: string; range: string }> = [
        { code: "BP", name: "Blood Pressure", value: vitals.bpSystolic && vitals.bpDiastolic ? `${vitals.bpSystolic}/${vitals.bpDiastolic}` : null, unit: "mmHg", range: "< 120/80" },
        { code: "HR", name: "Heart Rate", value: vitals.pulseRate, unit: "bpm", range: "60-100" },
        { code: "SPO2", name: "Oxygen Saturation", value: vitals.spO2, unit: "%", range: "95-100" },
        { code: "TEMP", name: "Temperature", value: vitals.temperatureF, unit: "°F", range: "97-99" },
        { code: "RR", name: "Respiratory Rate", value: vitals.respiratoryRate, unit: "bpm", range: "12-20" },
      ];

      for (const v of vitalCodes) {
        if (v.value !== null && v.value !== undefined && v.value !== "") {
          const obs = await Observation.create({
            organizationId: orgId,
            clinicId,
            encounterId,
            patientId,
            recordedBy: userId,
            code: v.code,
            name: v.name,
            value: String(v.value),
            unit: v.unit,
            referenceRange: v.range,
          });
          observationIds.push(obs._id as mongoose.Types.ObjectId);
        }
      }
    }

    // 2. Record Catalog Prescriptions
    const prescriptionIds: mongoose.Types.ObjectId[] = [];
    if (Array.isArray(prescriptions)) {
      for (const rx of prescriptions) {
        if (rx.name && rx.dosage && rx.duration) {
          const rxDoc = await Prescription.create({
            organizationId: orgId,
            clinicId,
            encounterId,
            patientId,
            doctorId: userId,
            medicineId: rx.medicineId || null,
            medicineName: rx.name,
            dosage: rx.dosage,
            frequency: rx.frequency || "1-0-1",
            duration: rx.duration,
            instructions: rx.instructions || "",
          });
          prescriptionIds.push(rxDoc._id as mongoose.Types.ObjectId);
        }
      }
    }

    // 3. Create or update draft ClinicalNote
    let note = await ClinicalNote.findOne({ encounterId, status: "draft", isLatest: true });
    if (note) {
      note.subjective = { chiefComplaint, historyOfPresentIllness: historyOfPresentIllness || "", symptoms: symptoms || [] };
      note.objective = { observationIds, physicalExamination: physicalExamination || "" };
      note.assessment = { diagnoses: diagnoses || [], severity: severity || "moderate" };
      note.plan = { treatmentPlan: treatmentPlan || "", prescriptionIds, labOrderIds: [], followUpDate: followUpDate ? new Date(followUpDate) : undefined, followUpInstructions: followUpInstructions || "" };
      await note.save();
    } else {
      note = await ClinicalNote.create({
        organizationId: orgId,
        clinicId,
        encounterId,
        patientId,
        doctorId: userId,
        version: 1,
        isLatest: true,
        subjective: { chiefComplaint, historyOfPresentIllness: historyOfPresentIllness || "", symptoms: symptoms || [] },
        objective: { observationIds, physicalExamination: physicalExamination || "" },
        assessment: { diagnoses: diagnoses || [], severity: severity || "moderate" },
        plan: { treatmentPlan: treatmentPlan || "", prescriptionIds, labOrderIds: [], followUpDate: followUpDate ? new Date(followUpDate) : undefined, followUpInstructions: followUpInstructions || "" },
        status: "draft",
      });
    }

    return reply.code(200).send(successResponse(note, "Draft clinical note saved"));
  } catch (err) {
    console.error("saveDraftClinicalNoteController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function signClinicalNoteController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user?.id;
    const userName = (req.user as any)?.name || "Attending Physician";

    const note = await ClinicalNote.findById(id);
    if (!note) return reply.code(404).send(errorResponse("Clinical note not found"));

    if (note.status !== "draft" && note.status !== "under_review") {
      return reply.code(400).send(errorResponse(`Cannot sign note in status '${note.status}'`));
    }

    note.status = "signed";
    note.signature = {
      signerId: userId as any,
      signerName: userName,
      signedAt: new Date(),
      signingMethod: "RS256_JWT",
    };
    await note.save();

    // Complete Encounter
    await Encounter.findByIdAndUpdate(note.encounterId, { status: "completed", endedAt: new Date() });

    return reply.code(200).send(successResponse(note, "Clinical note signed and locked"));
  } catch (err) {
    console.error("signClinicalNoteController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function amendClinicalNoteController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user?.id;
    const userName = (req.user as any)?.name || "Attending Physician";
    const { amendmentReason, subjective, objective, assessment, plan } = req.body as any;

    if (!amendmentReason) {
      return reply.code(400).send(errorResponse("amendmentReason is required for amending signed notes"));
    }

    const parentNote = await ClinicalNote.findById(id);
    if (!parentNote) return reply.code(404).send(errorResponse("Parent clinical note not found"));

    if (parentNote.status !== "signed" && parentNote.status !== "amended") {
      return reply.code(400).send(errorResponse("Only signed or amended notes can be amended"));
    }

    // Mark parent as no longer latest
    parentNote.isLatest = false;
    parentNote.status = "amended";
    await parentNote.save();

    // Create new versioned note
    const newVersion = parentNote.version + 1;
    const amendedNote = await ClinicalNote.create({
      organizationId: parentNote.organizationId,
      clinicId: parentNote.clinicId,
      encounterId: parentNote.encounterId,
      patientId: parentNote.patientId,
      doctorId: userId,
      version: newVersion,
      parentNoteId: parentNote._id,
      isLatest: true,
      subjective: subjective || parentNote.subjective,
      objective: objective || parentNote.objective,
      assessment: assessment || parentNote.assessment,
      plan: plan || parentNote.plan,
      status: "signed",
      amendmentReason,
      signature: {
        signerId: userId as any,
        signerName: userName,
        signedAt: new Date(),
        signingMethod: "RS256_JWT",
      },
    });

    return reply.code(201).send(successResponse(amendedNote, `Clinical note amended to version ${newVersion}`));
  } catch (err) {
    console.error("amendClinicalNoteController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getClinicalNoteHistoryController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string }; // patientId
    const orgId = req.user?.organization_id;

    const notes = await ClinicalNote.find({ patientId: id, organizationId: orgId })
      .populate("doctorId", "name email")
      .populate("objective.observationIds")
      .populate("plan.prescriptionIds")
      .sort({ version: -1 })
      .lean();

    return reply.code(200).send(successResponse(notes));
  } catch (err) {
    console.error("getClinicalNoteHistoryController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
