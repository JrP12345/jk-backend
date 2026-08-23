import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { Prescription } from "../models/Prescription.ts";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

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

    if (appointmentId && !mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      const appt = await Appointment.findById(appointmentId).lean() as any;
      if (!appt) return reply.code(404).send(errorResponse("Appointment not found"));
      const appointmentAccess = await checkOperationalRecordAccess(req, appt);
      if (!appointmentAccess.allowed) return sendTenantError(reply, appointmentAccess);
      if (finalClinicId && mongoose.Types.ObjectId.isValid(finalClinicId) && finalClinicId !== appt.clinicId?.toString()) {
        return reply.code(400).send(errorResponse("Appointment clinic does not match clinicId"));
      }
      if (finalPatientId && mongoose.Types.ObjectId.isValid(finalPatientId) && finalPatientId !== appt.patientId?.toString()) {
        return reply.code(400).send(errorResponse("Appointment patient does not match patientId"));
      }
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

    const clinicAccess = await checkClinicAccess(req, finalClinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
    const patient = await Patient.findById(finalPatientId);
    if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
    if (patient.organizationId && clinicAccess.organizationId && patient.organizationId.toString() !== clinicAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (!patient.organizationId && clinicAccess.organizationId) {
      patient.organizationId = new mongoose.Types.ObjectId(clinicAccess.organizationId);
      await patient.save();
    }

    // Reuse existing active (in_progress) encounter for this appointment/patient session
    const existingFilter: any = { status: "in_progress" };
    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      existingFilter.appointmentId = appointmentId;
    } else {
      existingFilter.patientId = finalPatientId;
      existingFilter.clinicId = finalClinicId;
    }
    existingFilter.organizationId = clinicAccess.organizationId;

    const existingEncounter = await Encounter.findOne(existingFilter).sort({ createdAt: -1 });
    if (existingEncounter) {
      return reply.code(200).send(successResponse(existingEncounter, "Active encounter retrieved"));
    }

    const encounter = await Encounter.create({
      organizationId: clinicAccess.organizationId || orgId,
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

    if (!mongoose.Types.ObjectId.isValid(encounterId) || !mongoose.Types.ObjectId.isValid(patientId)) {
      return reply.code(400).send(errorResponse("Invalid encounter or patient ID"));
    }
    const encounter = await Encounter.findById(encounterId).lean() as any;
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
    const encounterAccess = await checkOperationalRecordAccess(req, encounter);
    if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
    if (encounter.patientId.toString() !== patientId) return reply.code(400).send(errorResponse("Encounter patient does not match patientId"));
    if (clinicId && encounter.clinicId.toString() !== clinicId) return reply.code(400).send(errorResponse("Encounter clinic does not match clinicId"));
    const effectiveClinicId = encounter.clinicId.toString();

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
            clinicId: effectiveClinicId,
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
            clinicId: effectiveClinicId,
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

    // 3. Normalize structured diagnoses
    const formattedDiagnoses = Array.isArray(diagnoses)
      ? diagnoses.map((d: any) =>
          typeof d === "string"
            ? { code: "ICD-10", description: d, status: "active" }
            : { code: d.code || "ICD-10", description: d.description || d.name || "Diagnosis", status: d.status || "active" }
        )
      : [];

    // 4. Create or update draft ClinicalNote
    let note = await ClinicalNote.findOne({ encounterId, organizationId: orgId, status: "draft", isLatest: true });
    if (note) {
      note.subjective = { chiefComplaint, historyOfPresentIllness: historyOfPresentIllness || "", symptoms: symptoms || [] };
      note.objective = { observationIds, physicalExamination: physicalExamination || "" };
      note.assessment = { diagnoses: formattedDiagnoses as any, severity: severity || "moderate" };
      note.plan = { treatmentPlan: treatmentPlan || "", prescriptionIds, labOrderIds: [], followUpDate: followUpDate ? new Date(followUpDate) : undefined, followUpInstructions: followUpInstructions || "" };
      await note.save();
    } else {
      note = await ClinicalNote.create({
        organizationId: orgId,
        clinicId: effectiveClinicId,
        encounterId,
        patientId,
        doctorId: userId,
        version: 1,
        isLatest: true,
        subjective: { chiefComplaint, historyOfPresentIllness: historyOfPresentIllness || "", symptoms: symptoms || [] },
        objective: { observationIds, physicalExamination: physicalExamination || "" },
        assessment: { diagnoses: formattedDiagnoses, severity: severity || "moderate" },
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

    const noteAccess = await checkOperationalRecordAccess(req, note);
    if (!noteAccess.allowed) return sendTenantError(reply, noteAccess);
    if (req.user?.role === "doctor" && note.doctorId.toString() !== userId) {
      return reply.code(403).send(errorResponse("Only the assigned doctor can sign this clinical note"));
    }

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

    // Complete Encounter and linked Appointment
    const updatedEncounter = await Encounter.findOneAndUpdate(
      { _id: note.encounterId, organizationId: note.organizationId, clinicId: note.clinicId },
      { status: "completed", endedAt: new Date() },
      { new: true }
    );

    if (updatedEncounter?.appointmentId) {
      const { Appointment } = await import("../models/Appointment.ts");
      await Appointment.findByIdAndUpdate(updatedEncounter.appointmentId, { status: "completed" });
    }

    if (updatedEncounter) {
      const orgId = note.organizationId?.toString();
      const billingEnabled = orgId
        ? await (await import("../utilities/moduleAccess.ts")).isModuleEnabledForOrganization(orgId, "billing")
        : false;
      if (billingEnabled) {
        try {
          const { autoGenerateEncounterInvoice } = await import("../services/ChargeCaptureService.ts");
          await autoGenerateEncounterInvoice(updatedEncounter._id.toString(), userId);
        } catch (billingErr) {
          console.error("Auto encounter invoice on sign failed:", billingErr);
        }
      }
    }

    let followUpCreationFailed = false;
    // Auto-create Follow-up Appointment if followUpDate is set
    if (note.plan?.followUpDate) {
      try {
        const { Appointment } = await import("../models/Appointment.ts");
        const encounterDoc = await Encounter.findById(note.encounterId);
        const targetFollowUpId = encounterDoc?.appointmentId || note.encounterId;
        const existingFollowUp = await Appointment.findOne({ followUpForAppointmentId: targetFollowUpId });

        if (!existingFollowUp) {
          const requestedDate = new Date(note.plan.followUpDate);
          const dateStr = requestedDate.toISOString().slice(0, 10);
          const counterKey = `token_${note.clinicId}_${note.doctorId}_${dateStr}`;
          const tokenNumber = await getNextAtomicSequence(counterKey);

          await Appointment.create({
            organizationId: note.organizationId || undefined,
            clinicId: note.clinicId,
            doctorId: note.doctorId,
            patientId: note.patientId,
            appointmentTime: requestedDate,
            appointmentType: "walk-in",
            status: "confirmed",
            tokenNumber,
            queuePosition: tokenNumber,
            notes: note.plan.followUpInstructions || "Follow-up consultation",
            followUpRecommended: true,
            followUpForAppointmentId: targetFollowUpId
          });
        }
      } catch (followUpErr) {
        console.error("Auto follow-up creation failed:", followUpErr);
        followUpCreationFailed = true;
      }
    }

    const message = followUpCreationFailed
      ? "Clinical note signed and locked, but the requested follow-up could not be scheduled"
      : "Clinical note signed and locked (Follow-up scheduled)";
    return reply.code(200).send(successResponse(note, message));
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

    const noteAccess = await checkOperationalRecordAccess(req, parentNote);
    if (!noteAccess.allowed) return sendTenantError(reply, noteAccess);
    if (req.user?.role === "doctor" && parentNote.doctorId.toString() !== userId) {
      return reply.code(403).send(errorResponse("Only the assigned doctor can amend this clinical note"));
    }

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

    if (!mongoose.Types.ObjectId.isValid(id)) return reply.code(400).send(errorResponse("Invalid patient ID"));
    const patient = await Patient.findById(id).lean() as any;
    if (!patient) return reply.code(404).send(errorResponse("Patient not found"));
    if (req.user?.role === "patient" && patient.userId.toString() !== req.user.id) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }
    if (patient.organizationId && orgId && patient.organizationId.toString() !== orgId) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }
    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));

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
