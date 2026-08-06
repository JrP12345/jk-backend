import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DietOrder } from "../models/DietOrder.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getDietOrders(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, ward, mealTime, deliveryStatus, dietType } = req.query as {
      clinicId?: string;
      ward?: string;
      mealTime?: string;
      deliveryStatus?: string;
      dietType?: string;
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

    if (ward && ward !== "ALL") query.ward = ward;
    if (mealTime && mealTime !== "ALL") query.mealTime = mealTime;
    if (deliveryStatus && deliveryStatus !== "ALL") query.deliveryStatus = deliveryStatus;
    if (dietType && dietType !== "ALL") query.dietType = dietType;

    const orders = await DietOrder.find(query).sort({ createdAt: -1 });

    // KPI Summary
    const totalOrders = orders.length;
    const preparingCount = orders.filter((o) => o.deliveryStatus === "preparing").length;
    const deliveredCount = orders.filter((o) => o.deliveryStatus === "delivered").length;
    const npoHeldCount = orders.filter((o) => o.deliveryStatus === "npo_held" || o.dietType === "npo_nothing_by_mouth").length;
    const allergyCount = orders.filter((o) => o.allergies && o.allergies.length > 0).length;

    return reply.code(200).send(
      successResponse({
        orders,
        metrics: {
          totalOrders,
          preparingCount,
          deliveredCount,
          npoHeldCount,
          allergyCount,
        },
      })
    );
  } catch (err) {
    console.error("getDietOrders error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching dietary meal orders"));
  }
}

export async function createDietOrder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      patientId,
      patientName,
      bedNumber,
      ward,
      dietType,
      caloricTarget,
      allergies,
      specialInstructions,
      mealTime,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!patientName?.trim() || !bedNumber?.trim() || !ward?.trim()) {
      return reply.code(400).send(errorResponse("patientName, bedNumber, and ward are required"));
    }

    const order = await DietOrder.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      patientId: patientId && mongoose.Types.ObjectId.isValid(patientId) ? new mongoose.Types.ObjectId(patientId) : undefined,
      patientName: patientName.trim(),
      bedNumber: bedNumber.trim(),
      ward: ward.trim(),
      dietType: dietType || "regular",
      caloricTarget: caloricTarget || 2000,
      allergies: Array.isArray(allergies) ? allergies : [],
      specialInstructions: specialInstructions || "",
      mealTime: mealTime || "lunch",
      deliveryStatus: dietType === "npo_nothing_by_mouth" ? "npo_held" : "ordered",
      prescribedBy: user!.id,
    });

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "DIET_ORDER_CREATE",
      targetId: order._id,
      targetModel: "DietOrder",
      details: { patientName, dietType, ward, mealTime }
    });

    return reply.code(201).send(successResponse(order, "Clinical diet order created successfully"));
  } catch (err) {
    console.error("createDietOrder error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating diet order"));
  }
}

export async function updateDietStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { deliveryStatus, intakePercentage } = req.body as {
      deliveryStatus?: string;
      intakePercentage?: number;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid diet order ID"));
    }

    const order = await DietOrder.findById(id);
    if (!order || order.deletedAt) {
      return reply.code(404).send(errorResponse("Diet order not found"));
    }
    const scope = await checkOperationalRecordAccess(req, order);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (deliveryStatus) {
      order.deliveryStatus = deliveryStatus as any;
      if (deliveryStatus === "delivered") {
        order.deliveredAt = new Date();
      }
    }
    if (typeof intakePercentage === "number") {
      order.intakePercentage = intakePercentage;
    }

    await order.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "DIET_ORDER_STATUS_UPDATE",
      targetId: order._id,
      targetModel: "DietOrder",
      details: { patientName: order.patientName, deliveryStatus: order.deliveryStatus, intakePercentage }
    });

    return reply.code(200).send(successResponse(order, "Diet order delivery status updated successfully"));
  } catch (err) {
    console.error("updateDietStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating diet status"));
  }
}

export async function deleteDietOrder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid diet order ID"));
    }

    const order = await DietOrder.findById(id);
    if (!order || order.deletedAt) {
      return reply.code(404).send(errorResponse("Diet order not found"));
    }
    const scope = await checkOperationalRecordAccess(req, order);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    order.deletedAt = new Date();
    await order.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "DIET_ORDER_DELETE",
      targetId: order._id,
      targetModel: "DietOrder",
      details: { patientName: order.patientName, dietType: order.dietType }
    });

    return reply.code(200).send(successResponse(order, "Diet order deleted successfully"));
  } catch (err) {
    console.error("deleteDietOrder error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting diet order"));
  }
}
