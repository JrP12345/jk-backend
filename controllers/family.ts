import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { successResponse, errorResponse, normalizePhone } from "../utilities/helpers.ts";
import { patientMatchingService } from "../services/PatientMatchingService.ts";
import { otpService } from "../services/OtpService.ts";

// ─── GET /api/family — List all family members managed by authenticated user ───
export async function getFamilyMembers(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;

    // Fetch active family relationships
    const relationships = await FamilyRelationship.find({
      userId,
      status: "active",
    }).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone avatar" },
    });

    const formatted = relationships.map((rel: any) => {
      const p = rel.patientId?.toJSON ? rel.patientId.toJSON() : rel.patientId;
      return {
        relationshipId: rel._id.toString(),
        relationship: rel.relationship,
        patient: p,
      };
    });

    return reply.code(200).send(successResponse(formatted));
  } catch (err) {
    console.error("getFamilyMembers error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/family — Add a new family member / dependent ───────────
export async function addFamilyMember(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { name, dob, gender, bloodGroup, relationship, allergies, conditions, medicalNotes } = req.body as {
      name: string;
      dob?: string;
      gender?: "male" | "female" | "other";
      bloodGroup?: string;
      relationship: "mother" | "father" | "son" | "daughter" | "spouse" | "guardian" | "other";
      allergies?: string[];
      conditions?: string[];
      medicalNotes?: string;
    };

    if (!name || !name.trim()) {
      return reply.code(400).send(errorResponse("Family member name is required"));
    }

    if (!relationship) {
      return reply.code(400).send(errorResponse("Relationship type is required"));
    }

    const allowedRels = ["mother", "father", "son", "daughter", "spouse", "guardian", "other"];
    if (!allowedRels.includes(relationship)) {
      return reply.code(400).send(errorResponse("Invalid relationship type"));
    }

    const orgId = req.user?.organization_id;

    // Create the Dependent Patient record (no User account needed)
    const newPatient: any = await Patient.create({
      name: name.trim(),
      accountType: "dependent",
      createdBy: userId,
      organizationId: orgId ? new mongoose.Types.ObjectId(orgId) : undefined,
      dob: dob ? new Date(dob) : undefined,
      gender: gender || undefined,
      bloodGroup: (bloodGroup as any) || undefined,
      allergies: allergies || [],
      conditions: conditions || [],
      medicalNotes: medicalNotes || undefined,
    });

    // Create FamilyRelationship linking User to Dependent Patient
    const familyRel = await FamilyRelationship.create({
      userId,
      patientId: newPatient._id,
      relationship,
      status: "active",
    });

    const populatedPatient = await Patient.findById(newPatient._id);

    return reply.code(201).send(
      successResponse(
        {
          relationshipId: familyRel._id.toString(),
          relationship: familyRel.relationship,
          patient: populatedPatient,
        },
        "Family member added successfully"
      )
    );
  } catch (err: any) {
    console.error("addFamilyMember error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── PATCH /api/family/:id — Update relationship details ─────────────
export async function updateFamilyMember(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string }; // relationshipId
    const { relationship, name, dob, gender, bloodGroup, allergies, conditions } = req.body as any;

    const familyRel = await FamilyRelationship.findOne({ _id: id, userId, status: "active" });
    if (!familyRel) {
      return reply.code(404).send(errorResponse("Family member relationship not found"));
    }

    if (relationship) {
      familyRel.relationship = relationship;
      await familyRel.save();
    }

    const patient = await Patient.findById(familyRel.patientId);
    if (patient) {
      if (name) patient.name = name.trim();
      if (dob) patient.dob = new Date(dob);
      if (gender) patient.gender = gender;
      if (bloodGroup) patient.bloodGroup = bloodGroup;
      if (allergies) patient.allergies = allergies;
      if (conditions) patient.conditions = conditions;
      await patient.save();
    }

    return reply.code(200).send(successResponse(null, "Family member updated successfully"));
  } catch (err) {
    console.error("updateFamilyMember error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── DELETE /api/family/:id — Revoke family relationship ──────────────
export async function removeFamilyMember(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string }; // relationshipId

    const familyRel = await FamilyRelationship.findOne({ _id: id, userId });
    if (!familyRel) {
      return reply.code(404).send(errorResponse("Family relationship not found"));
    }

    if (familyRel.relationship === "self") {
      return reply.code(400).send(errorResponse("Cannot remove self relationship"));
    }

    familyRel.status = "revoked";
    await familyRel.save();

    return reply.code(200).send(successResponse(null, "Family member relationship removed"));
  } catch (err) {
    console.error("removeFamilyMember error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/family/claim — Claim an existing walk-in patient record ───
export async function claimPatientRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { patientId } = req.body as { patientId: string };

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient record not found"));
    }

    // Ensure record is not already claimed by another user
    if (patient.userId && patient.userId.toString() !== userId) {
      return reply.code(409).send(errorResponse("This patient record is already linked to another online account"));
    }

    const { otp } = req.body as { patientId: string; otp?: string };
    const user = await User.findById(userId);
    const normUserPhone = normalizePhone(user?.phone || "");
    const normPatientPhone = normalizePhone(patient.phone || "");

    const isPhoneMatched = Boolean(normUserPhone && normPatientPhone && normUserPhone === normPatientPhone);
    const isCreator = patient.createdBy?.toString() === userId;

    if (!isPhoneMatched && !isCreator) {
      if (!otp) {
        return reply.code(403).send(errorResponse("Phone verification required to claim this medical record."));
      }
      const otpResult = await otpService.verifyOtp(patient.phone || "", otp, "record_claim");
      if (!otpResult.verified) {
        return reply.code(403).send(errorResponse(otpResult.message || "Invalid OTP for record claim"));
      }
    }

    // Link Patient to User
    patient.userId = new mongoose.Types.ObjectId(userId);
    patient.accountType = "self";
    await patient.save();

    // Create or update FamilyRelationship for self
    await FamilyRelationship.findOneAndUpdate(
      { userId, patientId: patient._id },
      { relationship: "self", status: "active" },
      { upsert: true }
    );

    return reply.code(200).send(successResponse(patient, "Patient record linked to your account successfully!"));
  } catch (err) {
    console.error("claimPatientRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
