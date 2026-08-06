import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { MortuaryEntry } from "../models/MortuaryEntry.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getMortuaryEntries(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, releaseStatus, autopsyStatus, search } = req.query as {
      clinicId?: string;
      releaseStatus?: string;
      autopsyStatus?: string;
      search?: string;
    };

    const query: any = {
      deletedAt: null,
    };

    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      query.clinicId = new mongoose.Types.ObjectId(clinicId);
    } else if (user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      query.organizationId = new mongoose.Types.ObjectId(orgId);
    }

    if (releaseStatus && releaseStatus !== "ALL") query.releaseStatus = releaseStatus;
    if (autopsyStatus && autopsyStatus !== "ALL") query.autopsyStatus = autopsyStatus;

    if (search) {
      query.$or = [
        { deceasedName: { $regex: search, $options: "i" } },
        { tagNumber: { $regex: search, $options: "i" } },
        { mortuaryCompartment: { $regex: search, $options: "i" } },
      ];
    }

    const entries = await MortuaryEntry.find(query).sort({ dateOfDeath: -1 });

    // KPI Metrics
    const totalEntries = entries.length;
    const currentOccupancy = entries.filter((e) => e.releaseStatus !== "released_to_kin" && e.releaseStatus !== "transferred_to_coroner").length;
    const autopsiesPending = entries.filter((e) => e.autopsyStatus === "scheduled" || e.autopsyStatus === "in_progress").length;
    const certificatesIssued = entries.filter((e) => e.deathCertificateNumber && e.deathCertificateNumber.length > 0).length;
    const releasedCount = entries.filter((e) => e.releaseStatus === "released_to_kin").length;

    return reply.code(200).send(
      successResponse({
        entries,
        metrics: {
          totalEntries,
          currentOccupancy,
          autopsiesPending,
          certificatesIssued,
          releasedCount,
        },
      })
    );
  } catch (err) {
    console.error("getMortuaryEntries error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching mortuary entries"));
  }
}

export async function createMortuaryEntry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      tagNumber,
      deceasedName,
      age,
      gender,
      dateOfDeath,
      causeOfDeath,
      deathCertificateNumber,
      mortuaryCompartment,
      temperatureCelsius,
      autopsyRequired,
      autopsyStatus,
      releaseStatus,
      nextOfKinName,
      nextOfKinContact,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!deceasedName || !causeOfDeath || !mortuaryCompartment) {
      return reply.code(400).send(errorResponse("deceasedName, causeOfDeath, and mortuaryCompartment are required"));
    }

    const generatedTag = tagNumber || `MORT-${Date.now().toString().slice(-6)}`;
    const certNum = deathCertificateNumber || `DC-2026-${Date.now().toString().slice(-5)}`;

    const newEntry = await MortuaryEntry.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      tagNumber: generatedTag,
      deceasedName,
      age: Number(age) || 50,
      gender: gender || "male",
      dateOfDeath: dateOfDeath ? new Date(dateOfDeath) : new Date(),
      causeOfDeath,
      deathCertificateNumber: certNum,
      mortuaryCompartment: mortuaryCompartment || "Cold Bay Bay-01",
      temperatureCelsius: temperatureCelsius !== undefined ? Number(temperatureCelsius) : -4.0,
      autopsyRequired: Boolean(autopsyRequired),
      autopsyStatus: autopsyStatus || (autopsyRequired ? "scheduled" : "not_required"),
      releaseStatus: releaseStatus || "admitted",
      nextOfKinName: nextOfKinName || "",
      nextOfKinContact: nextOfKinContact || "",
      notes: notes || "",
    });

    return reply.code(201).send(successResponse(newEntry, "Mortuary entry created & tag issued successfully"));
  } catch (err) {
    console.error("createMortuaryEntry error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating mortuary entry"));
  }
}

export async function updateReleaseStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { releaseStatus, autopsyStatus, deathCertificateNumber, nextOfKinName, nextOfKinContact, notes } = req.body as {
      releaseStatus?: string;
      autopsyStatus?: string;
      deathCertificateNumber?: string;
      nextOfKinName?: string;
      nextOfKinContact?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid mortuary entry ID"));
    }

    const entry = await MortuaryEntry.findById(id);
    if (!entry || entry.deletedAt) {
      return reply.code(404).send(errorResponse("Mortuary entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, entry);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (releaseStatus) {
      entry.releaseStatus = releaseStatus as any;
      if (releaseStatus === "released_to_kin") {
        entry.releasedDate = new Date();
      }
    }
    if (autopsyStatus) entry.autopsyStatus = autopsyStatus as any;
    if (deathCertificateNumber) entry.deathCertificateNumber = deathCertificateNumber;
    if (nextOfKinName) entry.nextOfKinName = nextOfKinName;
    if (nextOfKinContact) entry.nextOfKinContact = nextOfKinContact;
    if (notes !== undefined) entry.notes = notes;

    await entry.save();
    return reply.code(200).send(successResponse(entry, "Mortuary status updated successfully"));
  } catch (err) {
    console.error("updateReleaseStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating mortuary entry status"));
  }
}

export async function deleteMortuaryEntry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid mortuary entry ID"));
    }

    const entry = await MortuaryEntry.findById(id);
    if (!entry || entry.deletedAt) {
      return reply.code(404).send(errorResponse("Mortuary entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, entry);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    entry.deletedAt = new Date();
    await entry.save();

    return reply.code(200).send(successResponse(entry, "Mortuary entry deleted successfully"));
  } catch (err) {
    console.error("deleteMortuaryEntry error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting mortuary entry"));
  }
}
