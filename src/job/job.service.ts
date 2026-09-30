import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ViscoError } from '../common/errors';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';
import { dynamicModulusAtHz } from '../dynamic/dynamic-modulus.service';
import { MaterialService } from '../material/material.service';
import { JobDocument, JobDocumentDefinition } from '../persistence/job.schema';

export interface SubmitJobInput {
  materialName: string;
  histories: StrainHistorySpec[];
}

export interface JobSummary {
  id: string;
  materialName: string;
  status: 'queued' | 'running' | 'completed';
  totalHistories: number;
  succeeded: number;
  failed: number;
  histories: Array<{
    name?: string;
    status: 'pending' | 'succeeded' | 'failed';
    errorCode?: string;
    errorMessage?: string;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
}

function summarize(doc: JobDocument): JobSummary {
  return {
    id: doc.id,
    materialName: doc.materialName,
    status: doc.status,
    totalHistories: doc.totalHistories,
    succeeded: doc.succeeded,
    failed: doc.failed,
    histories: doc.histories.map((h) => ({
      name: h.name,
      status: h.status,
      errorCode: h.errorCode,
      errorMessage: h.errorMessage,
    })),
    createdAt: doc.get('createdAt') as Date | undefined,
    updatedAt: doc.get('updatedAt') as Date | undefined,
  };
}

@Injectable()
export class JobService {
  constructor(
    @InjectModel(JobDocumentDefinition.name)
    private readonly jobModel: Model<JobDocument>,
    private readonly materialService: MaterialService,
  ) {}

  /** 提交作业：材料档必须存在、历程列表非空；随后异步执行，立即返回作业号。 */
  async submit(input: SubmitJobInput): Promise<{ jobId: string }> {
    if (!Array.isArray(input.histories) || input.histories.length === 0) {
      throw new ViscoError('JOB_EMPTY', '作业至少要包含一条应变历程');
    }
    const material = await this.materialService.findByName(input.materialName);
    const materialId = await this.materialService.findIdByName(input.materialName);

    const doc = await this.jobModel.create({
      materialName: material.name,
      materialId: new Types.ObjectId(materialId),
      status: 'queued',
      totalHistories: input.histories.length,
      succeeded: 0,
      failed: 0,
      histories: input.histories.map((h) => ({
        name: h.name,
        status: 'pending' as const,
        times: [],
        strains: [],
        stresses: [],
        relaxationModulus: [],
        dynamics: [],
        shiftFactor: 1,
      })),
      // 原始历程规格随作业持久化，执行器逐条取用
      specs: input.histories as unknown as Record<string, unknown>[],
    });

    // 异步执行：不阻塞提交响应。setImmediate 保证作业号先返回。
    setImmediate(() => {
      void this.execute(doc.id).catch((err) => {
        // 兜底：执行循环本身异常不应让作业永久 queued
        console.error(`[job ${doc.id}] 执行器异常:`, err);
      });
    });

    return { jobId: doc.id };
  }

  /** 执行一条作业：逐条处理，单条失败隔离并记录原因。 */
  async execute(jobId: string): Promise<void> {
    const job = await this.jobModel.findById(jobId).exec();
    if (!job) {
      throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
    }
    if (job.status !== 'queued') {
      return; // 防重复执行
    }
    job.status = 'running';
    await job.save();

    const material = await this.materialService.findByName(job.materialName);
    const specs = job.get('specs') as unknown as StrainHistorySpec[];

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      try {
        const resolved = resolveHistory(spec);
        const kernel = runPronyKernel({ material, history: resolved });

        // 正弦稳态段：用 Prony 参数解析计算 E′、E″、tanδ（温度平移后的有效 τ）。
        const dynamics = resolved.segments
          .filter((s): s is Extract<typeof s, { type: 'sine' }> => s.type === 'sine')
          .map((s) => {
            // 温度对动态模量的影响等价于用平移后的 τ；直接构造平移材料。
            const shifted = kernel.shiftFactor === 1
              ? material
              : {
                  ...material,
                  branches: material.branches.map((b) => ({
                    modulus: b.modulus,
                    tau: b.tau * kernel.shiftFactor,
                  })),
                };
            return {
              frequency: s.frequency,
              ...dynamicModulusAtHz(shifted, s.frequency),
            };
          });

        const row = job.histories[i];
        row.status = 'succeeded';
        row.times = kernel.times;
        row.strains = kernel.strains;
        row.stresses = kernel.stresses;
        row.relaxationModulus = kernel.relaxationModulus;
        row.dynamics = dynamics;
        row.shiftFactor = kernel.shiftFactor;
        succeeded++;
      } catch (err) {
        const row = job.histories[i];
        row.status = 'failed';
        if (err instanceof ViscoError) {
          row.errorCode = err.code;
          row.errorMessage = err.message;
        } else {
          row.errorCode = 'INVALID_PAYLOAD';
          row.errorMessage = err instanceof Error ? err.message : String(err);
        }
        failed++;
      }
      // 每条处理完即落库，进度查询可见
      job.succeeded = succeeded;
      job.failed = failed;
      await job.save();
    }

    job.status = 'completed';
    job.succeeded = succeeded;
    job.failed = failed;
    await job.save();
  }

  async getStatus(jobId: string): Promise<JobSummary> {
    const doc = await this.jobModel.findById(jobId).exec();
    if (!doc) {
      throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
    }
    return summarize(doc);
  }

  /** 取完整结果（含曲线数组）。 */
  async getDetail(jobId: string) {
    const doc = await this.jobModel.findById(jobId).exec();
    if (!doc) {
      throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
    }
    return doc.toObject({ versionKey: false });
  }

  /** 按材料档检索历史作业。 */
  async findByMaterial(materialName: string): Promise<JobSummary[]> {
    const docs = await this.jobModel
      .find({ materialName })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map(summarize);
  }
}
