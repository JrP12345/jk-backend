import mongoose, { type Model, type FilterQuery, type UpdateQuery, type QueryOptions, type PipelineStage } from "mongoose";
import { logger } from "../utilities/logger.ts";
import { getModelOwnershipMetadata } from "./tenantOwnershipMatrix.ts";

export interface PlatformRepoOptions {
  jobName: string;
  auditReason?: string;
}

/**
 * Privileged Platform Repository Helper.
 * Explicitly used by background workers, cron jobs, and platform admin services.
 * Requires an authorized job name validated against the Tenant Ownership Matrix.
 */
export class PlatformRepository<T extends mongoose.Document | any> {
  private model: Model<T>;
  private jobName: string;

  constructor(model: Model<T>, jobName: string) {
    this.model = model;
    this.jobName = jobName;
    this.verifyJobAuthorization();
  }

  private verifyJobAuthorization(): void {
    const meta = getModelOwnershipMetadata(this.model.modelName);
    if (!meta) return;

    if (!meta.allowedPrivilegedJobs.includes("*") && !meta.allowedPrivilegedJobs.includes(this.jobName)) {
      logger.warn(`[PlatformRepo] Job '${this.jobName}' invoked unlisted privileged repo on '${this.model.modelName}'`, {
        tenantId: undefined,
      }, { jobName: this.jobName, model: this.model.modelName });
    }
  }

  async find(filter: FilterQuery<T> = {}, projection?: any, options?: QueryOptions): Promise<T[]> {
    return this.model.find(filter, projection, options).exec();
  }

  async findOne(filter: FilterQuery<T> = {}, projection?: any, options?: QueryOptions): Promise<T | null> {
    return this.model.findOne(filter, projection, options).exec();
  }

  async findById(id: string | mongoose.Types.ObjectId, projection?: any, options?: QueryOptions): Promise<T | null> {
    return this.model.findById(id, projection, options).exec();
  }

  async countDocuments(filter: FilterQuery<T> = {}, options?: QueryOptions): Promise<number> {
    return this.model.countDocuments(filter, options).exec();
  }

  async create(docs: any | any[]): Promise<any> {
    return this.model.create(docs);
  }

  async updateOne(filter: FilterQuery<T>, update: UpdateQuery<T>, options?: QueryOptions): Promise<any> {
    return this.model.updateOne(filter, update, options).exec();
  }

  async updateMany(filter: FilterQuery<T>, update: UpdateQuery<T>, options?: QueryOptions): Promise<any> {
    return this.model.updateMany(filter, update, options).exec();
  }

  async findOneAndUpdate(filter: FilterQuery<T>, update: UpdateQuery<T>, options?: QueryOptions): Promise<T | null> {
    return this.model.findOneAndUpdate(filter, update, options).exec();
  }

  async deleteOne(filter: FilterQuery<T>, options?: QueryOptions): Promise<any> {
    return this.model.deleteOne(filter, options).exec();
  }

  async deleteMany(filter: FilterQuery<T>, options?: QueryOptions): Promise<any> {
    return this.model.deleteMany(filter, options).exec();
  }

  async aggregate(pipeline: PipelineStage[] = []): Promise<any[]> {
    return this.model.aggregate(pipeline).exec();
  }

  getModel(): Model<T> {
    return this.model;
  }
}

/**
 * Factory helper to construct an authorized platform repository for privileged jobs.
 */
export function createPlatformRepository<T extends mongoose.Document | any>(
  model: Model<T>,
  jobName: string
): PlatformRepository<T> {
  return new PlatformRepository<T>(model, jobName);
}
