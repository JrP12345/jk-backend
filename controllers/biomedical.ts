import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { BiomedicalAsset } from "../models/BiomedicalAsset.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getBiomedicalAssets(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, department, category, operationalStatus, riskClassification } = req.query as {
      clinicId?: string;
      department?: string;
      category?: string;
      operationalStatus?: string;
      riskClassification?: string;
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

    if (department && department !== "ALL") query.department = department;
    if (category && category !== "ALL") query.category = category;
    if (operationalStatus && operationalStatus !== "ALL") query.operationalStatus = operationalStatus;
    if (riskClassification && riskClassification !== "ALL") query.riskClassification = riskClassification;

    const assets = await BiomedicalAsset.find(query).sort({ nextCalibrationDueDate: 1 });

    // KPI Metrics calculation
    const totalAssets = assets.length;
    const operationalCount = assets.filter((a) => a.operationalStatus === "operational").length;
    const maintenanceCount = assets.filter((a) => a.operationalStatus === "under_maintenance").length;
    const calibrationDueCount = assets.filter((a) => a.operationalStatus === "calibration_due").length;
    const highRiskCount = assets.filter((a) => a.riskClassification === "high_risk_critical").length;

    return reply.code(200).send(
      successResponse({
        assets,
        metrics: {
          totalAssets,
          operationalCount,
          maintenanceCount,
          calibrationDueCount,
          highRiskCount,
        },
      })
    );
  } catch (err) {
    console.error("getBiomedicalAssets error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching biomedical equipment assets"));
  }
}

export async function createBiomedicalAsset(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      assetTag,
      deviceName,
      category,
      serialNumber,
      manufacturer,
      department,
      location,
      operationalStatus,
      lastCalibrationDate,
      nextCalibrationDueDate,
      riskClassification,
      maintenanceContact,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId) || !deviceName?.trim() || !serialNumber?.trim() || !manufacturer?.trim() || !department?.trim() || !location?.trim() || !maintenanceContact?.trim() || !nextCalibrationDueDate) {
      return reply.code(400).send(errorResponse("clinicId, deviceName, serialNumber, manufacturer, department, location, maintenanceContact, and nextCalibrationDueDate are required"));
    }

    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    const generatedTag = assetTag || `BMED-${Date.now().toString().slice(-6)}`;

    const asset = await BiomedicalAsset.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(clinicId),
      assetTag: generatedTag,
      deviceName: deviceName.trim(),
      category: category || "life_support",
      serialNumber: serialNumber.trim(),
      manufacturer: manufacturer.trim(),
      department: department.trim(),
      location: location.trim(),
      operationalStatus: operationalStatus || "operational",
      lastCalibrationDate: lastCalibrationDate ? new Date(lastCalibrationDate) : new Date(),
      nextCalibrationDueDate: new Date(nextCalibrationDueDate),
      riskClassification: riskClassification || "high_risk_critical",
      maintenanceContact: maintenanceContact.trim(),
      notes: notes || "",
    });

    return reply.code(201).send(successResponse(asset, "Biomedical device asset registered successfully"));
  } catch (err) {
    console.error("createBiomedicalAsset error:", err);
    return reply.code(500).send(errorResponse("Internal server error registering biomedical device asset"));
  }
}

export async function updateAssetStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { operationalStatus, lastCalibrationDate, nextCalibrationDueDate, notes } = req.body as {
      operationalStatus?: string;
      lastCalibrationDate?: string;
      nextCalibrationDueDate?: string;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid asset ID"));
    }

    const asset = await BiomedicalAsset.findById(id);
    if (!asset || asset.deletedAt) {
      return reply.code(404).send(errorResponse("Biomedical asset entry not found"));
    }

    const scope = await checkOperationalRecordAccess(req, asset);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (operationalStatus) asset.operationalStatus = operationalStatus as any;
    if (lastCalibrationDate) asset.lastCalibrationDate = new Date(lastCalibrationDate);
    if (nextCalibrationDueDate) asset.nextCalibrationDueDate = new Date(nextCalibrationDueDate);
    if (notes !== undefined) asset.notes = notes;

    await asset.save();
    return reply.code(200).send(successResponse(asset, "Biomedical asset maintenance status updated successfully"));
  } catch (err) {
    console.error("updateAssetStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating biomedical asset status"));
  }
}

export async function deleteBiomedicalAsset(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid asset ID"));
    }

    const asset = await BiomedicalAsset.findById(id);
    if (!asset || asset.deletedAt) {
      return reply.code(404).send(errorResponse("Biomedical asset entry not found"));
    }

    const scope = await checkOperationalRecordAccess(req, asset);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    asset.deletedAt = new Date();
    await asset.save();

    return reply.code(200).send(successResponse(asset, "Biomedical asset deleted successfully"));
  } catch (err) {
    console.error("deleteBiomedicalAsset error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting biomedical asset"));
  }
}
