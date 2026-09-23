import matrixJson from "./tenantOwnershipMatrix.json" with { type: "json" };
import mongoose from "mongoose";

export type ModelClassification = "tenant" | "platform" | "user_cross_tenant" | "auth_ephemeral" | "public";

export interface ModelOwnershipMetadata {
  classification: ModelClassification;
  ownershipField: string | null;
  clinicField: string | null;
  allowedPrivilegedJobs: string[];
  accessingControllers: string[];
  queryMethods: string[];
  requiredConstraints: {
    organizationId: boolean;
    clinicId: boolean;
  };
}

export interface TenantOwnershipMatrix {
  version: string;
  generatedAt: string;
  description: string;
  models: Record<string, ModelOwnershipMetadata>;
}

export const tenantOwnershipMatrix: TenantOwnershipMatrix = matrixJson as TenantOwnershipMatrix;

/**
 * Check if a given model is classified as tenant-owned.
 */
export function isTenantOwnedModel(modelName: string): boolean {
  const meta = tenantOwnershipMatrix.models[modelName];
  return meta?.classification === "tenant";
}

/**
 * Retrieve metadata for a model in the ownership matrix.
 */
export function getModelOwnershipMetadata(modelName: string): ModelOwnershipMetadata | undefined {
  return tenantOwnershipMatrix.models[modelName];
}

/**
 * Validates whether a caller's query constraints satisfy the model's required tenant isolation rules.
 * Throws a descriptive Error if tenant constraints are missing or bypassed illegally.
 */
export function assertValidTenantQuery(
  modelName: string,
  context: { organizationId?: string | mongoose.Types.ObjectId; isRoot?: boolean; jobName?: string },
  queryFilter: Record<string, any> = {}
): void {
  const meta = getModelOwnershipMetadata(modelName);
  if (!meta) {
    return; // Model not tracked in matrix
  }

  // Privileged background job bypass
  if (context.jobName) {
    if (meta.allowedPrivilegedJobs.includes("*") || meta.allowedPrivilegedJobs.includes(context.jobName)) {
      return;
    }
    throw new Error(
      `[TenantSecurityError] Job '${context.jobName}' is NOT authorized to execute unscoped operations on tenant model '${modelName}'.`
    );
  }

  // Platform root operator bypass (explicit audit logging required)
  if (context.isRoot) {
    return;
  }

  // Tenant-owned model constraint enforcement
  if (meta.classification === "tenant" && meta.requiredConstraints.organizationId) {
    const orgId = context.organizationId;
    if (!orgId || !mongoose.Types.ObjectId.isValid(String(orgId))) {
      throw new Error(
        `[TenantSecurityError] Fail-closed: Missing or invalid organizationId context for tenant model '${modelName}'.`
      );
    }

    const filterOrgId = queryFilter[meta.ownershipField || "organizationId"];
    if (filterOrgId && String(filterOrgId) !== String(orgId)) {
      throw new Error(
        `[TenantSecurityError] Cross-tenant query attempt detected on '${modelName}'. Context Org: ${orgId}, Filter Org: ${filterOrgId}`
      );
    }
  }
}
