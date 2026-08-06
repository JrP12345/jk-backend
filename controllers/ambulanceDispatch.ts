import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { AmbulanceDispatch } from "../models/AmbulanceDispatch.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getAmbulanceDispatches(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, callPriority, dispatchStatus, vehicleType, search } = req.query as {
      clinicId?: string;
      callPriority?: string;
      dispatchStatus?: string;
      vehicleType?: string;
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

    if (callPriority && callPriority !== "ALL") query.callPriority = callPriority;
    if (dispatchStatus && dispatchStatus !== "ALL") query.dispatchStatus = dispatchStatus;
    if (vehicleType && vehicleType !== "ALL") query.vehicleType = vehicleType;

    if (search) {
      query.$or = [
        { vehicleNumber: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
        { pickupLocation: { $regex: search, $options: "i" } },
        { paramedicLead: { $regex: search, $options: "i" } },
      ];
    }

    const dispatches = await AmbulanceDispatch.find(query).sort({ updatedAt: -1 });

    // Metrics
    const totalDispatches = dispatches.length;
    const activeDispatches = dispatches.filter(
      (d) => d.dispatchStatus !== "arrived_er" && d.dispatchStatus !== "available_in_bay"
    ).length;
    const codeRedCritical = dispatches.filter((d) => d.callPriority === "code_red_critical").length;
    const availableFleet = dispatches.filter((d) => d.dispatchStatus === "available_in_bay").length;

    return reply.code(200).send(
      successResponse({
        dispatches,
        metrics: {
          totalDispatches,
          activeDispatches,
          codeRedCritical,
          availableFleet,
        },
      })
    );
  } catch (err) {
    console.error("getAmbulanceDispatches error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching ambulance dispatches"));
  }
}

export async function createAmbulanceDispatch(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      vehicleNumber,
      vehicleType,
      callPriority,
      patientName,
      pickupLocation,
      destinationHospitalUnit,
      paramedicLead,
      driverName,
      fuelPercent,
      gpsCoordinates,
      notes,
    } = req.body as any;

    if (
      !clinicId || !mongoose.Types.ObjectId.isValid(clinicId) ||
      !vehicleNumber?.trim() || !vehicleType || !callPriority || !patientName?.trim() ||
      !pickupLocation?.trim() || !destinationHospitalUnit?.trim() ||
      !paramedicLead?.trim() || !driverName?.trim()
    ) {
      return reply.code(400).send(errorResponse(
        "clinicId, vehicleNumber, vehicleType, callPriority, patientName, pickupLocation, destinationHospitalUnit, paramedicLead, and driverName are required"
      ));
    }

    if (fuelPercent !== undefined && (!Number.isFinite(Number(fuelPercent)) || Number(fuelPercent) < 0 || Number(fuelPercent) > 100)) {
      return reply.code(400).send(errorResponse("fuelPercent must be between 0 and 100"));
    }

    if (gpsCoordinates !== undefined && (
      !Number.isFinite(Number(gpsCoordinates?.latitude)) ||
      !Number.isFinite(Number(gpsCoordinates?.longitude))
    )) {
      return reply.code(400).send(errorResponse("gpsCoordinates must include numeric latitude and longitude"));
    }

    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const newDispatch = await AmbulanceDispatch.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(clinicId),
      vehicleNumber: vehicleNumber.trim(),
      vehicleType,
      callPriority,
      patientName: patientName.trim(),
      pickupLocation: pickupLocation.trim(),
      destinationHospitalUnit: destinationHospitalUnit.trim(),
      paramedicLead: paramedicLead.trim(),
      driverName: driverName.trim(),
      dispatchStatus: "dispatched",
      gpsCoordinates: gpsCoordinates
        ? {
            latitude: Number(gpsCoordinates.latitude),
            longitude: Number(gpsCoordinates.longitude),
            lastGpsUpdate: new Date(),
          }
        : {
            latitude: 12.9716 + (Math.random() - 0.5) * 0.05,
            longitude: 77.5946 + (Math.random() - 0.5) * 0.05,
            lastGpsUpdate: new Date(),
          },
      ...(fuelPercent !== undefined ? { fuelPercent: Number(fuelPercent) } : {}),
      notes: notes || "",
    });

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "AMBULANCE_DISPATCH_CREATE",
      targetId: newDispatch._id,
      targetModel: "AmbulanceDispatch",
      details: { vehicleNumber: newDispatch.vehicleNumber, callPriority, pickupLocation }
    });

    return reply.code(201).send(successResponse(newDispatch, "Emergency ambulance unit dispatched successfully"));
  } catch (err) {
    console.error("createAmbulanceDispatch error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating ambulance dispatch"));
  }
}

export async function updateDispatchStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { dispatchStatus, fuelPercent, notes, gpsCoordinates } = req.body as {
      dispatchStatus?: string;
      fuelPercent?: number;
      notes?: string;
      gpsCoordinates?: { latitude?: number; longitude?: number };
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid dispatch ID"));
    }

    const dispatch = await AmbulanceDispatch.findById(id);
    if (!dispatch || dispatch.deletedAt) {
      return reply.code(404).send(errorResponse("Ambulance dispatch record not found"));
    }

    const scope = await checkOperationalRecordAccess(req, dispatch);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (dispatchStatus) dispatch.dispatchStatus = dispatchStatus as any;
    if (fuelPercent !== undefined) dispatch.fuelPercent = Number(fuelPercent);
    if (notes !== undefined) dispatch.notes = notes;

    if (fuelPercent !== undefined && (!Number.isFinite(Number(fuelPercent)) || Number(fuelPercent) < 0 || Number(fuelPercent) > 100)) {
      return reply.code(400).send(errorResponse("fuelPercent must be between 0 and 100"));
    }

    if (gpsCoordinates !== undefined) {
      if (!Number.isFinite(Number(gpsCoordinates.latitude)) || !Number.isFinite(Number(gpsCoordinates.longitude))) {
        return reply.code(400).send(errorResponse("gpsCoordinates must include numeric latitude and longitude"));
      }
      dispatch.gpsCoordinates = {
        latitude: Number(gpsCoordinates.latitude),
        longitude: Number(gpsCoordinates.longitude),
        lastGpsUpdate: new Date(),
      };
    }

    await dispatch.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "AMBULANCE_DISPATCH_STATUS_UPDATE",
      targetId: dispatch._id,
      targetModel: "AmbulanceDispatch",
      details: { vehicleNumber: dispatch.vehicleNumber, dispatchStatus: dispatch.dispatchStatus }
    });

    return reply.code(200).send(successResponse(dispatch, "Ambulance dispatch updated"));
  } catch (err) {
    console.error("updateDispatchStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating ambulance dispatch status"));
  }
}

export async function deleteAmbulanceDispatch(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid dispatch ID"));
    }

    const dispatch = await AmbulanceDispatch.findById(id);
    if (!dispatch || dispatch.deletedAt) {
      return reply.code(404).send(errorResponse("Ambulance dispatch record not found"));
    }

    const scope = await checkOperationalRecordAccess(req, dispatch);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    dispatch.deletedAt = new Date();
    await dispatch.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "AMBULANCE_DISPATCH_DELETE",
      targetId: dispatch._id,
      targetModel: "AmbulanceDispatch",
      details: { vehicleNumber: dispatch.vehicleNumber }
    });

    return reply.code(200).send(successResponse(dispatch, "Ambulance dispatch record deleted successfully"));
  } catch (err) {
    console.error("deleteAmbulanceDispatch error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting ambulance dispatch"));
  }
}

export async function updateDispatchTelemetry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { latitude, longitude, speedKmh, oxygenLevelPercent, fuelPercent, etaMinutes, vitalsEnroute } = req.body as {
      latitude?: number;
      longitude?: number;
      speedKmh?: number;
      oxygenLevelPercent?: number;
      fuelPercent?: number;
      etaMinutes?: number;
      vitalsEnroute?: { hr?: number; bp?: string; spo2?: number };
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid dispatch ID"));
    }

    const dispatch = await AmbulanceDispatch.findById(id);
    if (!dispatch || dispatch.deletedAt) {
      return reply.code(404).send(errorResponse("Ambulance dispatch record not found"));
    }

    if (latitude !== undefined && longitude !== undefined) {
      dispatch.gpsCoordinates = {
        latitude: Number(latitude),
        longitude: Number(longitude),
        lastGpsUpdate: new Date(),
      };
    }
    if (speedKmh !== undefined) dispatch.speedKmh = Number(speedKmh);
    if (oxygenLevelPercent !== undefined) dispatch.oxygenLevelPercent = Number(oxygenLevelPercent);
    if (fuelPercent !== undefined) dispatch.fuelPercent = Number(fuelPercent);
    if (etaMinutes !== undefined) dispatch.etaMinutes = Number(etaMinutes);
    if (vitalsEnroute) dispatch.vitalsEnroute = vitalsEnroute;

    await dispatch.save();
    return reply.code(200).send(successResponse(dispatch, "Telemetry updated successfully"));
  } catch (err) {
    console.error("updateDispatchTelemetry error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating telemetry"));
  }
}
