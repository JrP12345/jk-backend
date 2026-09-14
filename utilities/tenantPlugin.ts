import mongoose, { Schema } from "mongoose";
import { requestContextStore } from "./context.ts";

export interface TenantPluginOptions {
  tenantField?: string;
}

/**
 * Mongoose Multi-Tenant Scoping Plugin (Row-Level Security)
 *
 * Automatically scopes all queries and mutations to the authenticated caller's
 * active organizationId from the AsyncLocalStorage request context.
 *
 * Prevents accidental cross-tenant data leaks across all model queries without
 * requiring manual `{ organizationId }` filtering in every individual controller.
 *
 * Bypass options:
 * - `query.setOptions({ bypassTenantFilter: true })`
 * - Running as Root Super-Admin (`context.isRoot === true`)
 * - Internal / non-HTTP tasks without an active RequestContext
 */
export function tenantPlugin(schema: Schema, options: TenantPluginOptions = {}) {
  const tenantField = options.tenantField || "organizationId";

  // Ensure the tenantField is defined and indexed on the schema
  if (!schema.path(tenantField)) {
    schema.add({
      [tenantField]: {
        type: Schema.Types.ObjectId,
        ref: "Organization",
        index: true,
        default: null,
      },
    });
  }

  function shouldApplyTenantFilter(query: any): { apply: boolean; orgId?: mongoose.Types.ObjectId } {
    if (query.getOptions?.()?.bypassTenantFilter) {
      return { apply: false };
    }

    const context = requestContextStore.getStore();
    if (!context || !context.organizationId || context.isRoot) {
      return { apply: false };
    }

    if (!mongoose.Types.ObjectId.isValid(context.organizationId)) {
      return { apply: false };
    }

    return {
      apply: true,
      orgId: new mongoose.Types.ObjectId(context.organizationId),
    };
  }

  const queryMethods = [
    "find",
    "findOne",
    "findOneAndUpdate",
    "findOneAndDelete",
    "findOneAndReplace",
    "countDocuments",
    "deleteMany",
    "deleteOne",
    "updateMany",
    "updateOne",
  ] as const;

  for (const method of queryMethods) {
    schema.pre(method, function (this: any) {
      const { apply, orgId } = shouldApplyTenantFilter(this);
      if (!apply || !orgId) return;

      const currentFilter = this.getFilter() || {};

      // If filter specifies another tenant, force active tenant to prevent cross-tenant queries
      if (currentFilter[tenantField] !== undefined) {
        if (String(currentFilter[tenantField]) !== String(orgId)) {
          this.where({ [tenantField]: orgId });
        }
      } else {
        this.where({ [tenantField]: orgId });
      }
    });
  }

  // Pre-save document hook: automatically inject organizationId if omitted
  schema.pre("save", function (this: any) {
    const context = requestContextStore.getStore();
    if (context?.organizationId && !context.isRoot) {
      if (!this.get(tenantField)) {
        this.set(tenantField, new mongoose.Types.ObjectId(context.organizationId));
      }
    }
  });
}
