import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Error as MongooseError, Model, Types } from 'mongoose';
import { ViscoError, ViscoErrorCode } from '../common/errors';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';
import { dynamicModulusAtHz } from '../dynamic/dynamic-modulus.service';
import { MaterialService } from '../material/material.service';
import { StoredMaterial } from '../material/material.model';
import { JobDocument, JobDocumentDefinition } from '../persistence/job.schema';
import { JobResultDocument, JobResultDocumentDefinition } from '../persistence/job-result.schema';

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

/** 判断异常是否来自数据库写路径（Mongoose 或 MongoDB 驱动）。 */
function isPersistenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // MongooseError 涵盖 ODM 校验/转换错误；驱动错误类名均以 Mongo 开头
  // （MongoServerError、MongoNetworkError、MongoServerSelectionError …）。
  return err instanceof MongooseError || err.name.startsWith('Mongo');
}

/** 执行器级异常的归一化（兜底终态用）：领域错误保留原码，写库失败单独成码。 */
function toHistoryError(err: unknown): { code: ViscoErrorCode; message: string } {
  if (err instanceof ViscoError) {
    return { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isPersistenceError(err)) {
    return { code: 'RESULT_PERSISTENCE_FAILED', message: `结果写入数据库失败：${message}` };
  }
  return { code: 'INVALID_PAYLOAD', message };
}

@Injectable()
export class JobService implements OnModuleInit {
  constructor(
    @InjectModel(JobDocumentDefinition.name)
    private readonly jobModel: Model<JobDocument>,
    @InjectModel(JobResultDocumentDefinition.name)
    private readonly resultModel: Model<JobResultDocument>,
    private readonly materialService: MaterialService,
  ) {}

  /**
   * 进程重启（崩溃、部署）后，queued/running 都不是终态，说明执行被中断。
   * 启动时统一重新入队执行，保证没有任何作业永远挂在中间态。
   * 后台执行，不阻塞服务监听。
   */
  onModuleInit(): void {
    void this.recoverInterruptedJobs().catch((err) => {
      console.error('[job] 启动恢复扫描失败:', err);
    });
  }

  /**
   * 恢复扫描：把中断的作业翻回 queued 并重新执行。
   * 内核是纯函数、结果文档按 (jobId, historyIndex) upsert，重跑完全幂等；
   * 已 succeeded 的历程会被跳过，不重算也不覆盖其已落库的结果。
   */
  async recoverInterruptedJobs(): Promise<void> {
    const stuck = await this.jobModel
      .find({ status: { $in: ['queued', 'running'] } }, { _id: 1 })
      .exec();
    for (const doc of stuck) {
      await this.jobModel
        .updateOne({ _id: doc._id }, { $set: { status: 'queued' } })
        .exec();
    }
    await Promise.all(
      stuck.map((doc) =>
        this.execute(doc._id.toString()).catch((err) => {
          // execute 内部已有终态兜底，这里只是最后一道保险
          console.error(`[job ${doc._id.toString()}] 恢复执行异常:`, err);
        }),
      ),
    );
  }

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

  /**
   * 执行一条作业：逐条处理，单条失败（含结果写库失败）隔离并记录原因。
   *
   * 落库顺序与终态保证：
   * - 每条历程：先 upsert 结果文档，再翻状态行 —— status=succeeded 蕴含结果已存在；
   * - 每条历程分"计算 / 落库"两个阶段分别捕获：计算失败按参数/历程类错误码记录，
   *   落库失败（含 BSON 超限）记 RESULT_PERSISTENCE_FAILED；其余历程照常继续；
   * - 执行器级异常（材料被删、状态写库失败等）由 finalizeTerminal 兜底：
   *   未完成的历程标 failed，作业翻到 completed，绝不停留在 running。
   */
  async execute(jobId: string): Promise<void> {
    // 原子认领：只有 queued 作业会被执行，防重复/并发执行。
    const claim = await this.jobModel
      .updateOne({ _id: jobId, status: 'queued' }, { $set: { status: 'running' } })
      .exec();
    if (claim.modifiedCount === 0) {
      const exists = await this.jobModel.exists({ _id: jobId });
      if (!exists) {
        throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
      }
      return; // 已在运行或已到终态
    }

    try {
      const job = await this.jobModel.findById(jobId).exec();
      if (!job) {
        throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
      }
      const material = await this.materialService.findByName(job.materialName);
      const specs = job.get('specs') as unknown as StrainHistorySpec[];

      // 计数从当前行状态重建：恢复执行时已完成的历程直接跳过、不被重算。
      let succeeded = job.histories.filter((h) => h.status === 'succeeded').length;
      let failed = job.histories.filter((h) => h.status === 'failed').length;

      for (let i = 0; i < specs.length; i++) {
        const row = job.histories[i];
        if (!row || row.status !== 'pending') {
          continue;
        }

        // 阶段一：计算（纯函数，不碰数据库）。失败按参数/历程类错误码记录。
        let result: ReturnType<JobService['computeHistory']>;
        try {
          result = this.computeHistory(material, specs[i]);
        } catch (err) {
          failed++;
          const code: ViscoErrorCode = err instanceof ViscoError ? err.code : 'INVALID_PAYLOAD';
          const message = err instanceof Error ? err.message : String(err);
          await this.markHistoryFailed(job._id, i, code, message, succeeded, failed);
          continue;
        }

        // 阶段二：落库。先写结果文档（upsert 幂等），再翻状态行 —— succeeded
        // 蕴含结果已落库。这一阶段的任何异常（BSON 超限、网络抖动…）都意味着
        // "结果写不进库"，统一记 RESULT_PERSISTENCE_FAILED，不影响其余历程。
        try {
          await this.resultModel
            .updateOne(
              { jobId: job._id, historyIndex: i },
              {
                $set: {
                  name: row.name,
                  times: result.times,
                  strains: result.strains,
                  stresses: result.stresses,
                  relaxationModulus: result.relaxationModulus,
                  dynamics: result.dynamics,
                  shiftFactor: result.shiftFactor,
                },
              },
              { upsert: true },
            )
            .exec();
          succeeded++;
          // 小负载定点更新：进度查询每条落库后立即可见。
          await this.jobModel
            .updateOne(
              { _id: job._id },
              { $set: { [`histories.${i}.status`]: 'succeeded', succeeded, failed } },
            )
            .exec();
        } catch (err) {
          failed++;
          // 结果文档可能已部分写入（如网络抖动）：尽力清理，避免孤儿文档。
          await this.resultModel
            .deleteOne({ jobId: job._id, historyIndex: i })
            .exec()
            .catch(() => undefined);
          const message = err instanceof Error ? err.message : String(err);
          await this.markHistoryFailed(
            job._id,
            i,
            'RESULT_PERSISTENCE_FAILED',
            `结果写入数据库失败：${message}`,
            succeeded,
            failed,
          );
        }
      }

      await this.jobModel
        .updateOne({ _id: job._id }, { $set: { status: 'completed', succeeded, failed } })
        .exec();
    } catch (err) {
      await this.finalizeTerminal(jobId, err);
    }
  }

  /**
   * 把一条历程标为 failed 并附原因（同步刷新计数，进度查询立即可见）。
   * 该写库本身失败时异常向外抛，由 finalizeTerminal 兜底整个作业的终态。
   */
  private async markHistoryFailed(
    jobId: Types.ObjectId,
    index: number,
    code: ViscoErrorCode,
    message: string,
    succeeded: number,
    failed: number,
  ): Promise<void> {
    await this.jobModel
      .updateOne(
        { _id: jobId },
        {
          $set: {
            [`histories.${index}.status`]: 'failed',
            [`histories.${index}.errorCode`]: code,
            [`histories.${index}.errorMessage`]: message,
            succeeded,
            failed,
          },
        },
      )
      .exec();
  }

  /**
   * 终态兜底：执行器任何环节异常逃出时，尽最大努力把作业写进终态 ——
   * 未完成的历程标 failed 并附原因，已完成的保留结果，状态翻 completed。
   * 数据库持续不可写时重试若干次后放弃并告警（此时已无任何办法落库）。
   */
  private async finalizeTerminal(jobId: string, cause: unknown): Promise<void> {
    console.error(`[job ${jobId}] 执行器异常，尝试写入终态:`, cause);
    const { code, message } = toHistoryError(cause);
    const attempt = async (): Promise<void> => {
      const job = await this.jobModel.findById(jobId).exec();
      if (!job || job.status === 'completed') {
        return;
      }
      const set: Record<string, unknown> = { status: 'completed' };
      let succeeded = 0;
      job.histories.forEach((h, i) => {
        if (h.status === 'succeeded') {
          succeeded++;
          return;
        }
        // 已 failed 的保留原始原因；其余（pending）一律标 failed 并附本次原因。
        if (h.status !== 'failed') {
          set[`histories.${i}.status`] = 'failed';
          set[`histories.${i}.errorCode`] = code;
          set[`histories.${i}.errorMessage`] = message;
        }
      });
      set.succeeded = succeeded;
      set.failed = job.totalHistories - succeeded;
      await this.jobModel.updateOne({ _id: jobId }, { $set: set }).exec();
    };
    for (let retry = 0; retry < 3; retry++) {
      try {
        await attempt();
        return;
      } catch (err) {
        console.error(`[job ${jobId}] 终态写入失败（第 ${retry + 1} 次）:`, err);
        await new Promise((r) => setTimeout(r, 200 * (retry + 1)));
      }
    }
    console.error(`[job ${jobId}] 终态写入多次失败，作业可能停留在非终态，请人工核查`);
  }

  /** 计算单条历程：内核推进 + 正弦稳态段解析动态模量（纯计算，不碰数据库）。 */
  private computeHistory(material: StoredMaterial, spec: StrainHistorySpec) {
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

    return {
      times: kernel.times,
      strains: kernel.strains,
      stresses: kernel.stresses,
      relaxationModulus: kernel.relaxationModulus,
      dynamics,
      shiftFactor: kernel.shiftFactor,
    };
  }

  async getStatus(jobId: string): Promise<JobSummary> {
    const doc = await this.jobModel.findById(jobId).exec();
    if (!doc) {
      throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
    }
    return summarize(doc);
  }

  /**
   * 取完整结果（含曲线数组）。
   *
   * 双轨读取，对调用方透明：
   * - 新作业：曲线在 job_results 集合，按 historyIndex 合并回各历程行；
   * - 升级前的老作业：曲线内嵌在作业文档里、没有结果文档，原样返回内嵌值。
   * 两种情况下响应结构与字段完全一致。
   */
  async getDetail(jobId: string) {
    const doc = await this.jobModel.findById(jobId).exec();
    if (!doc) {
      throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
    }
    const obj = doc.toObject({ versionKey: false });
    const results = await this.resultModel.find({ jobId: doc._id }).lean().exec();
    const byIndex = new Map(results.map((r) => [r.historyIndex, r]));
    obj.histories = obj.histories.map((row, i) => {
      if (row.status !== 'succeeded') {
        return row; // 失败/未完成的历程没有曲线，与旧行为一致
      }
      const result = byIndex.get(i);
      if (!result) {
        return row; // 老作业：曲线内嵌在作业文档里
      }
      return {
        ...row,
        times: result.times,
        strains: result.strains,
        stresses: result.stresses,
        relaxationModulus: result.relaxationModulus,
        dynamics: result.dynamics,
        shiftFactor: result.shiftFactor,
      };
    });
    return obj;
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
