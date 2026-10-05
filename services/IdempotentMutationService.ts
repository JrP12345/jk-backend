import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { OperationReceipt } from "../models/OperationReceipt.ts";

export function mutationKey(req: FastifyRequest): string {
  const value = req.headers["idempotency-key"] || (req.body as any)?.idempotencyKey;
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{8,128}$/.test(value)) {
    throw Object.assign(new Error("A stable Idempotency-Key is required for this operation"), { statusCode: 428 });
  }
  return value;
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => key !== "idempotencyKey").map(key => [key, canonical(value[key])]));
  return value;
}

export async function claimMutation(scope: string, key: string, body: unknown) {
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
  const existing = await OperationReceipt.findOne({ scope, key });
  if (existing) {
    if (existing.requestHash !== requestHash) throw Object.assign(new Error("Idempotency-Key was already used with different input"), { statusCode: 409 });
    if (!existing.resultId) throw Object.assign(new Error("Operation is in progress; retry with the same key"), { statusCode: 409 });
    return { receipt: existing, replay: true };
  }
  try {
    return { receipt: await OperationReceipt.create({ scope, key, requestHash }), replay: false };
  } catch (error: any) {
    if (error.code === 11000) throw Object.assign(new Error("Operation is in progress; retry with the same key"), { statusCode: 409 });
    throw error;
  }
}
