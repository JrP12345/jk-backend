import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { HomeRPMRecord } from "../models/HomeRPMRecord.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getHomeRPMRecords(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, carePlanType, vitalAlertSeverity, nurseVisitStatus, search } = req.query as {
      clinicId?: string;
      carePlanType?: string;
      vitalAlertSeverity?: string;
      nurseVisitStatus?: string;
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

    if (carePlanType && carePlanType !== "ALL") query.carePlanType = carePlanType;
    if (vitalAlertSeverity && vitalAlertSeverity !== "ALL") query.vitalAlertSeverity = vitalAlertSeverity;
    if (nurseVisitStatus && nurseVisitStatus !== "ALL") query.nurseVisitStatus = nurseVisitStatus;

    if (search) {
      query.$or = [
        { patientName: { $regex: search, $options: "i" } },
        { deviceSerialNumber: { $regex: search, $options: "i" } },
        { assignedNurse: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
      ];
    }

    const records = await HomeRPMRecord.find(query).sort({ updatedAt: -1 });

    // Metrics
    const totalPatients = records.length;
    const activeNurseVisits = records.filter((r) => r.nurseVisitStatus === "in_transit" || r.nurseVisitStatus === "scheduled").length;
    const criticalVitalAlerts = records.filter((r) => r.vitalAlertSeverity === "critical_alert").length;
    const activeRPMDevices = records.filter((r) => Boolean(r.deviceSerialNumber)).length;

    return reply.code(200).send(
      successResponse({
        records,
        metrics: {
          totalPatients,
          activeNurseVisits,
          criticalVitalAlerts,
          activeRPMDevices,
        },
      })
    );
  } catch (err) {
    console.error("getHomeRPMRecords error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching home RPM records"));
  }
}

export async function createHomeRPMRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      patientId,
      patientName,
      carePlanType,
      assignedNurse,
      deviceSerialNumber,
      latestVitals,
      address,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    const validCarePlans = ["hypertension_management", "diabetes_rpm", "post_op_wound_care", "copd_oxygen_monitoring", "heart_failure_vitals"];
    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId) || !patientName?.trim() || !validCarePlans.includes(carePlanType) || !assignedNurse?.trim() || !deviceSerialNumber?.trim() || !address?.trim()) {
      return reply.code(400).send(errorResponse("patientId, patientName, carePlanType, assignedNurse, deviceSerialNumber, and address are required"));
    }

    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    // Determine initial alert severity
    const vitals = latestVitals || {};
    const hasVitals = Object.keys(vitals).length > 0;
    for (const field of ["systolicBP", "diastolicBP", "spO2Percent", "bloodGlucoseMgDl", "heartRateBpm"]) {
      if (vitals[field] !== undefined && !Number.isFinite(Number(vitals[field]))) {
        return reply.code(400).send(errorResponse(`${field} must be a finite number`));
      }
    }
    const spO2 = Number(vitals.spO2Percent);
    const sysBP = Number(vitals.systolicBP);
    let severity = "normal";
    if (hasVitals && (spO2 < 90 || sysBP > 180)) {
      severity = "critical_alert";
    } else if (hasVitals && (spO2 < 94 || sysBP > 140)) {
      severity = "borderline";
    }

    const newRecord = await HomeRPMRecord.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      patientId: new mongoose.Types.ObjectId(patientId),
      patientName: patientName.trim(),
      carePlanType,
      assignedNurse: assignedNurse.trim(),
      deviceSerialNumber: deviceSerialNumber.trim(),
      ...(hasVitals ? {
        latestVitals: {
          ...(vitals.systolicBP !== undefined ? { systolicBP: Number(vitals.systolicBP) } : {}),
          ...(vitals.diastolicBP !== undefined ? { diastolicBP: Number(vitals.diastolicBP) } : {}),
          ...(vitals.spO2Percent !== undefined ? { spO2Percent: Number(vitals.spO2Percent) } : {}),
          ...(vitals.bloodGlucoseMgDl !== undefined ? { bloodGlucoseMgDl: Number(vitals.bloodGlucoseMgDl) } : {}),
          ...(vitals.heartRateBpm !== undefined ? { heartRateBpm: Number(vitals.heartRateBpm) } : {}),
          lastSyncTimestamp: new Date(),
        },
      } : {}),
      nurseVisitStatus: "scheduled",
      vitalAlertSeverity: severity,
      address: address.trim(),
      notes: notes || "",
    });

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HOME_RPM_RECORD_CREATE",
      targetId: newRecord._id,
      targetModel: "HomeRPMRecord",
      details: { patientName: newRecord.patientName, carePlanType: newRecord.carePlanType }
    });

    return reply.code(201).send(successResponse(newRecord, "Patient enrolled into Home Healthcare & RPM care plan successfully"));
  } catch (err) {
    console.error("createHomeRPMRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating home RPM record"));
  }
}

export async function updateRPMVitals(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { systolicBP, diastolicBP, spO2Percent, bloodGlucoseMgDl, heartRateBpm, notes } = req.body as {
      systolicBP?: number;
      diastolicBP?: number;
      spO2Percent?: number;
      bloodGlucoseMgDl?: number;
      heartRateBpm?: number;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid record ID"));
    }

    const record = await HomeRPMRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Home RPM record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const currentVitals = record.latestVitals || ({} as any);
    if ([systolicBP, diastolicBP, spO2Percent, bloodGlucoseMgDl, heartRateBpm].every((value) => value === undefined)) {
      return reply.code(400).send(errorResponse("At least one vital measurement is required"));
    }
    for (const [field, value] of Object.entries({ systolicBP, diastolicBP, spO2Percent, bloodGlucoseMgDl, heartRateBpm })) {
      if (value !== undefined && !Number.isFinite(Number(value))) {
        return reply.code(400).send(errorResponse(`${field} must be a finite number`));
      }
    }
    const newSysBP = systolicBP !== undefined ? Number(systolicBP) : currentVitals.systolicBP;
    const newDiaBP = diastolicBP !== undefined ? Number(diastolicBP) : currentVitals.diastolicBP;
    const newSpO2 = spO2Percent !== undefined ? Number(spO2Percent) : currentVitals.spO2Percent;
    const newGlucose = bloodGlucoseMgDl !== undefined ? Number(bloodGlucoseMgDl) : currentVitals.bloodGlucoseMgDl;
    const newHR = heartRateBpm !== undefined ? Number(heartRateBpm) : currentVitals.heartRateBpm;

    let severity: "normal" | "borderline" | "critical_alert" = "normal";
    if (newSpO2 < 90 || newSysBP > 180) {
      severity = "critical_alert";
    } else if (newSpO2 < 94 || newSysBP > 140) {
      severity = "borderline";
    }

    record.latestVitals = {
      systolicBP: newSysBP,
      diastolicBP: newDiaBP,
      spO2Percent: newSpO2,
      bloodGlucoseMgDl: newGlucose,
      heartRateBpm: newHR,
      lastSyncTimestamp: new Date(),
    };
    record.vitalAlertSeverity = severity;
    if (notes) record.notes = notes;

    await record.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HOME_RPM_VITALS_SYNC",
      targetId: record._id,
      targetModel: "HomeRPMRecord",
      details: { patientName: record.patientName, vitalAlertSeverity: severity }
    });

    return reply.code(200).send(successResponse(record, "Cellular RPM vitals synced & alert severity updated"));
  } catch (err) {
    console.error("updateRPMVitals error:", err);
    return reply.code(500).send(errorResponse("Internal server error syncing RPM vitals"));
  }
}

export async function updateNurseVisitStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { nurseVisitStatus, assignedNurse, notes } = req.body as {
      nurseVisitStatus?: string;
      assignedNurse?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid record ID"));
    }

    const record = await HomeRPMRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Home RPM record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (nurseVisitStatus && !["scheduled", "in_transit", "completed", "cancelled"].includes(nurseVisitStatus)) {
      return reply.code(400).send(errorResponse("Invalid nurse visit status"));
    }
    if (assignedNurse !== undefined && !assignedNurse.trim()) {
      return reply.code(400).send(errorResponse("assignedNurse cannot be empty"));
    }
    if (nurseVisitStatus) record.nurseVisitStatus = nurseVisitStatus as any;
    if (assignedNurse !== undefined) record.assignedNurse = assignedNurse.trim();
    if (notes !== undefined) record.notes = notes;

    await record.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HOME_RPM_VISIT_STATUS_UPDATE",
      targetId: record._id,
      targetModel: "HomeRPMRecord",
      details: { patientName: record.patientName, nurseVisitStatus: record.nurseVisitStatus }
    });

    return reply.code(200).send(successResponse(record, "Home nurse dispatch visit status updated"));
  } catch (err) {
    console.error("updateNurseVisitStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating nurse visit status"));
  }
}

export async function deleteHomeRPMRecord(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid record ID"));
    }

    const record = await HomeRPMRecord.findById(id);
    if (!record || record.deletedAt) {
      return reply.code(404).send(errorResponse("Home RPM record not found"));
    }
    const scope = await checkOperationalRecordAccess(req, record);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    record.deletedAt = new Date();
    await record.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "HOME_RPM_RECORD_DELETE",
      targetId: record._id,
      targetModel: "HomeRPMRecord",
      details: { patientName: record.patientName }
    });

    return reply.code(200).send(successResponse(record, "Home RPM record deleted successfully"));
  } catch (err) {
    console.error("deleteHomeRPMRecord error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting home RPM record"));
  }
}
