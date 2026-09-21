import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { InsuranceTariff } from "../models/InsuranceTariff.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

export async function upsertTariff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization context missing"));
    }

    const { tpaName, serviceCode, serviceName, agreedRate, isDisallowed, disallowedReason, coPayPercentage } = req.body as {
      tpaName: string;
      serviceCode: string;
      serviceName: string;
      agreedRate: number;
      isDisallowed?: boolean;
      disallowedReason?: string;
      coPayPercentage?: number;
    };

    if (!tpaName || !serviceCode || !serviceName || agreedRate === undefined) {
      return reply.code(400).send(errorResponse("tpaName, serviceCode, serviceName, and agreedRate are required"));
    }
    if (!Number.isFinite(agreedRate) || agreedRate < 0 || (coPayPercentage !== undefined && (!Number.isFinite(coPayPercentage) || coPayPercentage < 0 || coPayPercentage > 100))) {
      return reply.code(400).send(errorResponse("Tariff rates must be non-negative and co-pay percentage must be between 0 and 100"));
    }

    const tariff = await InsuranceTariff.findOneAndUpdate(
      {
        organizationId: orgId,
        tpaName: tpaName.trim(),
        serviceCode: serviceCode.trim().toUpperCase(),
      },
      {
        serviceName: serviceName.trim(),
        agreedRate,
        isDisallowed: !!isDisallowed,
        disallowedReason: disallowedReason?.trim(),
        coPayPercentage: coPayPercentage || 0,
        isActive: true,
      },
      { returnDocument: "after", upsert: true }
    );

    return reply.code(200).send(successResponse(tariff, "Insurance tariff rate updated successfully"));
  } catch (err) {
    console.error("upsertTariff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getTariffs(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const { tpaName, search, page, limit } = req.query as any;

    const filter: any = {};
    if (orgId && req.user?.role !== "root") filter.organizationId = orgId;
    if (tpaName) filter.tpaName = new RegExp(escapeRegex(tpaName), "i");
    if (search) {
      const safeSearch = escapeRegex(search);
      filter.$or = [
        { serviceCode: new RegExp(safeSearch, "i") },
        { serviceName: new RegExp(safeSearch, "i") },
        { tpaName: new RegExp(safeSearch, "i") },
      ];
    }

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalCount = await InsuranceTariff.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const tariffs = await InsuranceTariff.find(filter)
      .sort({ tpaName: 1, serviceCode: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(tariffs));
  } catch (err) {
    console.error("getTariffs error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function evaluateTariff(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const { tpaName, items } = req.body as {
      tpaName: string;
      items: Array<{ serviceCode: string; amount: number; quantity: number }>;
    };

    if (!tpaName || !items || !Array.isArray(items)) {
      return reply.code(400).send(errorResponse("tpaName and items array are required"));
    }
    if (!orgId && req.user?.role !== "root") return reply.code(403).send(errorResponse("Organization context missing"));

    const evaluatedItems = [];
    let totalClaimableAmount = 0;
    let totalDisallowedAmount = 0;
    let totalCoPayAmount = 0;

    for (const item of items) {
      if (!item.serviceCode || !Number.isFinite(item.amount) || item.amount < 0 || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        return reply.code(400).send(errorResponse("Each tariff item requires a non-negative amount and positive integer quantity"));
      }
      const tariffRule = await InsuranceTariff.findOne({
        organizationId: orgId,
        tpaName: tpaName.trim(),
        serviceCode: item.serviceCode.trim().toUpperCase(),
        isActive: true,
      });

      const qty = item.quantity || 1;
      const baseLine = item.amount * qty;

      if (!tariffRule) {
        evaluatedItems.push({
          serviceCode: item.serviceCode,
          originalAmount: baseLine,
          approvedRate: item.amount,
          claimableAmount: baseLine,
          isDisallowed: false,
          coPayAmount: 0,
          status: "STANDARD_RATE",
        });
        totalClaimableAmount += baseLine;
      } else if (tariffRule.isDisallowed) {
        evaluatedItems.push({
          serviceCode: item.serviceCode,
          originalAmount: baseLine,
          approvedRate: 0,
          claimableAmount: 0,
          isDisallowed: true,
          disallowedReason: tariffRule.disallowedReason || "Excluded service under insurer policy",
          coPayAmount: 0,
          status: "DISALLOWED",
        });
        totalDisallowedAmount += baseLine;
      } else {
        const approvedRate = tariffRule.agreedRate;
        const agreedLine = approvedRate * qty;
        const coPayPercent = tariffRule.coPayPercentage || 0;
        const coPayAmount = Number((agreedLine * (coPayPercent / 100)).toFixed(2));
        const claimableLine = Math.max(0, agreedLine - coPayAmount);

        evaluatedItems.push({
          serviceCode: item.serviceCode,
          originalAmount: baseLine,
          approvedRate,
          agreedLine,
          coPayPercentage: coPayPercent,
          coPayAmount,
          claimableAmount: claimableLine,
          isDisallowed: false,
          status: "TARIFF_APPLIED",
        });

        totalClaimableAmount += claimableLine;
        totalCoPayAmount += coPayAmount;
      }
    }

    return reply.code(200).send(
      successResponse({
        tpaName,
        evaluatedItems,
        summary: {
          totalClaimableAmount,
          totalDisallowedAmount,
          totalCoPayAmount,
        },
      })
    );
  } catch (err) {
    console.error("evaluateTariff error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
