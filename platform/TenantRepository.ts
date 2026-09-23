import mongoose, { type Model, type FilterQuery, type UpdateQuery, type QueryOptions, type PipelineStage } from "mongoose";
import { requestContextStore } from "../utilities/context.ts";
import { logger } from "../utilities/logger.ts";

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

export class TenantIsolationViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationViolationError";
  }
}

export interface TenantRepoOptions {
  organizationId?: string | mongoose.Types.ObjectId;
  tenantField?: string;
}

/**
 * Fail-Closed Tenant Repository Helper.
 * Guarantees that every query, mutation, aggregation, and bulk write is strictly scoped
 * to a verified organizationId context. Throws on missing or mismatched tenant context.
 */
export class TenantRepository<T extends mongoose.Document | any> {
  private model: Model<T>;
  private tenantField: string;

  constructor(model: Model<T>, defaultTenantField: string = "organizationId") {
    this.model = model;
    this.tenantField = defaultTenantField;
  }

  /**
   * Resolves and validates the active organizationId.
   * Throws TenantContextError if missing or malformed (fail-closed).
   */
  private resolveOrgId(explicitOrgId?: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
    const candidate = explicitOrgId || requestContextStore.getStore()?.organizationId;
    if (!candidate || !mongoose.Types.ObjectId.isValid(String(candidate))) {
      throw new TenantContextError(
        `[Fail-Closed TenantRepo] Operation on model '${this.model.modelName}' rejected: Missing or invalid organizationId context.`
      );
    }
    return new mongoose.Types.ObjectId(String(candidate));
  }

  /**
   * Enforces that the filter contains the mandatory organizationId,
   * preventing cross-tenant filter collisions or overrides.
   */
  private scopeFilter(filter: FilterQuery<T> = {}, explicitOrgId?: string | mongoose.Types.ObjectId): FilterQuery<T> {
    const orgId = this.resolveOrgId(explicitOrgId);
    const existingOrgId = (filter as any)[this.tenantField];

    if (existingOrgId !== undefined && existingOrgId !== null) {
      if (String(existingOrgId) !== String(orgId)) {
        throw new TenantIsolationViolationError(
          `[TenantSecurityError] Cross-tenant query attempt detected on model '${this.model.modelName}'. Context Org: ${orgId}, Filter Org: ${existingOrgId}`
        );
      }
    }

    return {
      ...filter,
      [this.tenantField]: orgId,
    };
  }

  async find(filter: FilterQuery<T> = {}, projection?: any, options?: QueryOptions & TenantRepoOptions): Promise<T[]> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.find(scoped, projection, options).exec();
  }

  async findOne(filter: FilterQuery<T> = {}, projection?: any, options?: QueryOptions & TenantRepoOptions): Promise<T | null> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.findOne(scoped, projection, options).exec();
  }

  async findById(id: string | mongoose.Types.ObjectId, projection?: any, options?: QueryOptions & TenantRepoOptions): Promise<T | null> {
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
      return null;
    }
    const filter = { _id: new mongoose.Types.ObjectId(String(id)) } as FilterQuery<T>;
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.findOne(scoped, projection, options).exec();
  }

  async countDocuments(filter: FilterQuery<T> = {}, options?: QueryOptions & TenantRepoOptions): Promise<number> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.countDocuments(scoped, options).exec();
  }

  async create(docs: any | any[], options?: TenantRepoOptions): Promise<any> {
    const orgId = this.resolveOrgId(options?.organizationId);

    if (Array.isArray(docs)) {
      const scopedDocs = docs.map((doc) => {
        if (doc[this.tenantField] && String(doc[this.tenantField]) !== String(orgId)) {
          throw new TenantIsolationViolationError(`[TenantSecurityError] Cannot create doc with mismatched organizationId.`);
        }
        return { ...doc, [this.tenantField]: orgId };
      });
      return this.model.create(scopedDocs as any);
    }

    if (docs[this.tenantField] && String(docs[this.tenantField]) !== String(orgId)) {
      throw new TenantIsolationViolationError(`[TenantSecurityError] Cannot create doc with mismatched organizationId.`);
    }

    return this.model.create({ ...docs, [this.tenantField]: orgId });
  }

  async updateOne(filter: FilterQuery<T>, update: UpdateQuery<T>, options?: QueryOptions & TenantRepoOptions): Promise<any> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.updateOne(scoped, update, options).exec();
  }

  async updateMany(filter: FilterQuery<T>, update: UpdateQuery<T>, options?: QueryOptions & TenantRepoOptions): Promise<any> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.updateMany(scoped, update, options).exec();
  }

  async findOneAndUpdate(filter: FilterQuery<T>, update: UpdateQuery<T>, options?: QueryOptions & TenantRepoOptions): Promise<T | null> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.findOneAndUpdate(scoped, update, options).exec();
  }

  async deleteOne(filter: FilterQuery<T>, options?: QueryOptions & TenantRepoOptions): Promise<any> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.deleteOne(scoped, options).exec();
  }

  async deleteMany(filter: FilterQuery<T>, options?: QueryOptions & TenantRepoOptions): Promise<any> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.deleteMany(scoped, options).exec();
  }

  async findOneAndDelete(filter: FilterQuery<T>, options?: QueryOptions & TenantRepoOptions): Promise<T | null> {
    const scoped = this.scopeFilter(filter, options?.organizationId);
    return this.model.findOneAndDelete(scoped, options).exec();
  }

  /**
   * Fail-closed tenant scoped aggregation.
   * Forces a leading $match stage targeting the resolved organizationId.
   */
  async aggregate(pipeline: PipelineStage[] = [], options?: TenantRepoOptions): Promise<any[]> {
    const orgId = this.resolveOrgId(options?.organizationId);
    const tenantStage: PipelineStage = {
      $match: { [this.tenantField]: orgId },
    };
    return this.model.aggregate([tenantStage, ...pipeline]).exec();
  }

  /**
   * Fail-closed bulk write operation helper.
   * Asserts every write operation belongs strictly to the active tenant.
   */
  async bulkWrite(ops: any[], options?: TenantRepoOptions): Promise<any> {
    const orgId = this.resolveOrgId(options?.organizationId);
    const scopedOps = ops.map((op) => {
      const opKey = Object.keys(op)[0];
      const payload = op[opKey];
      if (payload.filter) {
        payload.filter = { ...payload.filter, [this.tenantField]: orgId };
      }
      if (payload.document) {
        payload.document = { ...payload.document, [this.tenantField]: orgId };
      }
      return { [opKey]: payload };
    });
    return this.model.bulkWrite(scopedOps);
  }

  getModel(): Model<T> {
    return this.model;
  }
}

/**
 * Factory helper to construct a fail-closed tenant repository.
 */
export function createTenantRepository<T extends mongoose.Document | any>(
  model: Model<T>,
  tenantField: string = "organizationId"
): TenantRepository<T> {
  return new TenantRepository<T>(model, tenantField);
}
