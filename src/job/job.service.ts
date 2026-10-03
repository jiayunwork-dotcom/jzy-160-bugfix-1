import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ViscoError, ViscoErrorCode } from '../common/errors';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';
import { dynamicModulusAtHz } from '../dynamic/dynamic-modulus.service';
import { MaterialService } from '../material/material.service';
import { JobDocument, JobDocumentDefinition } from '../persistence/job.schema';
import {
  JobHistoryResultDefinition,
  JobHistoryResultDocument,
} from '../persistence/job-history-result.schema';

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

type HistoryStatus = 'pending' | 'succeeded' | 'failed';

/** 单条历程的动态模量结果（GET /jobs/:id/detail）。 */
export interface HistoryDynamics {
  frequency: number;
  omega: number;
  storageModulus: number;
  lossModulus: number;
  lossTangent: number;
  complexMagnitude: number;
}

/** GET /jobs/:id/detail 返回的单条历程（字段结构与旧版逐字段一致）。 */
export interface JobDetailHistory {
  name?: string;
  status: HistoryStatus;
  times: number[];
  strains: number[];
  stresses: number[];
  relaxationModulus: number[];
  dynamics: HistoryDynamics[];
  shiftFactor: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobDetail {
  _id: Types.ObjectId;
  materialName: string;
  materialId: Types.ObjectId;
  status: 'queued' | 'running' | 'completed';
  totalHistories: number;
  succeeded: number;
  failed: number;
  histories: JobDetailHistory[];
  specs: Record<string, unknown>[];
  createdAt?: Date;
  updatedAt?: Date;
}

interface RawHistoryRow {
  index?: number;
  name?: string;
  status: HistoryStatus;
  errorCode?: string;
  errorMessage?: string;
  // 升级前旧文档内嵌的曲线字段（getDetail 合并时兜底使用）
  times?: number[];
  strains?: number[];
  stresses?: number[];
  relaxationModulus?: number[];
  dynamics?: unknown[];
  shiftFactor?: number;
}

interface RawJobDoc {
  _id: Types.ObjectId;
  materialName: string;
  materialId: Types.ObjectId;
  status: 'queued' | 'running' | 'completed';
  totalHistories: number;
  succeeded: number;
  failed: number;
  histories: RawHistoryRow[];
  specs: Record<string, unknown>[];
  createdAt?: Date;
  updatedAt?: Date;
  __v?: number;
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

function toObjectId(jobId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
  }
  return new Types.ObjectId(jobId);
}

/** 内核以外的异常（多为 Type Error）沿用旧语义归为 INVALID_PAYLOAD。 */
function classifyComputeError(err: unknown): { code: ViscoErrorCode; message: string } {
  if (err instanceof ViscoError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: 'INVALID_PAYLOAD',
    message: err instanceof Error ? err.message : String(err),
  };
}

function persistenceErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `结果写入数据库失败：${detail}`;
}

@Injectable()
export class JobService implements OnModuleInit {
  private readonly logger = new Logger(JobService.name);
  /** 本进程内正在执行的作业，防止恢复扫描/重复触发并发执行同一作业。 */
  private readonly runningJobs = new Set<string>();

  constructor(
    @InjectModel(JobDocumentDefinition.name)
    private readonly jobModel: Model<JobDocument>,
    @InjectModel(JobHistoryResultDefinition.name)
    private readonly resultModel: Model<JobHistoryResultDocument>,
    private readonly materialService: MaterialService,
  ) {}

  /**
   * 启动恢复：进程崩溃/被 kill 时可能留下 queued/running 的作业，
   * 升级后重启（包括命名卷里的旧数据）也要把它们继续跑到终态。
   * 执行是幂等可续跑的——已经 succeeded/failed 的行会跳过。
   */
  onModuleInit(): void {
    const connection = this.jobModel.db;
    // runningJobs 去重保证扫描被多次触发也安全。
    const trigger = (): void => {
      void this.recoverStuckJobs().catch((err) =>
        this.logger.error(`启动恢复扫描失败: ${err instanceof Error ? err.stack : err}`),
      );
    };
    // mongoose 建连是异步的：模块初始化时可能已连上（事件错过了），也可能还在连。
    if (connection.readyState === 1) {
      trigger();
    } else {
      connection.once('connected', trigger);
    }
    // 断线重连后再扫一遍，把中断期间未终态的作业续跑掉。
    // mongoose 不同版本重连事件名不一，两类都监听（扫描幂等）。
    connection.on('reconnected', trigger);
    connection.on('connected', trigger);
  }

  async recoverStuckJobs(): Promise<void> {
    const stuck = await this.jobModel
      .find({ status: { $in: ['queued', 'running'] } })
      .select({ _id: 1 })
      .lean()
      .exec();
    for (const doc of stuck) {
      const id = doc._id.toString();
      if (this.runningJobs.has(id)) continue;
      setImmediate(() => {
        void this.execute(id).catch((err) =>
          this.logger.error(`[job ${id}] 恢复执行异常: ${err instanceof Error ? err.stack : err}`),
        );
      });
    }
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
      histories: input.histories.map((h, i) => ({
        index: i,
        name: h.name,
        status: 'pending' as const,
      })),
      // 原始历程规格随作业持久化（体积小），执行器逐条取用
      specs: input.histories as unknown as Record<string, unknown>[],
    });

    // 异步执行：不阻塞提交响应。setImmediate 保证作业号先返回。
    setImmediate(() => {
      void this.execute(doc.id).catch((err) => {
        this.logger.error(`[job ${doc.id}] 执行器异常: ${err instanceof Error ? err.stack : err}`);
      });
    });

    return { jobId: doc.id };
  }

  /**
   * 执行一条作业：逐条处理，单条失败隔离并记录原因。
   *
   * 关键保证：
   * - 每条历程的结果单独写入 job_history_results，作业文档只更新该行状态，
   *   不会因整文档超过 16MiB 而失败（见 README「结果存储」）；
   * - 任何一步出错（计算或落库）该历程都落到 failed 并附原因，其余照常；
   * - 执行器自身异常也会把剩余 pending 行终态化，作业永远落到 completed；
   * - 可重入、可续跑：已终态的行跳过，崩溃重启后从断点继续。
   */
  async execute(jobId: string): Promise<void> {
    if (this.runningJobs.has(jobId)) return;
    this.runningJobs.add(jobId);

    const jobObjectId = toObjectId(jobId);
    try {
      const exists = await this.jobModel.collection.findOne(
        { _id: jobObjectId },
        { projection: { _id: 1 } },
      );
      if (!exists) {
        throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobId}`);
      }

      // 旧版本文档的状态行没有 index；用数组位置补齐（已有 index 不覆盖）。
      await this.backfillRowIndexes(jobObjectId);
      // queued/running → running，幂等。
      await this.jobModel.collection.updateOne({ _id: jobObjectId }, { $set: { status: 'running' } });

      const initial = await this.loadJob(jobObjectId);
      const material = await this.materialService.findByName(initial.materialName);
      const total = initial.totalHistories;

      for (let i = 0; i < total; i++) {
        // 恢复/重复执行时跳过已终态的行（每行开始时读一次最新状态与规格）
        const current = await this.loadJob(jobObjectId);
        const row = current.histories.find((h) => h.index === i);
        if (!row || row.status !== 'pending') continue;

        // 1) 计算（纯 CPU，不碰库）——失败只标记本行
        let computed: {
          times: number[];
          strains: number[];
          stresses: number[];
          relaxationModulus: number[];
          shiftFactor: number;
          dynamics: {
            frequency: number;
            omega: number;
            storageModulus: number;
            lossModulus: number;
            lossTangent: number;
            complexMagnitude: number;
          }[];
        };
        try {
          const spec = current.specs[i] as unknown as StrainHistorySpec;
          if (!spec) {
            throw new ViscoError('INVALID_PAYLOAD', `第 ${i + 1} 条历程的原始规格缺失，无法执行`);
          }
          const resolved = resolveHistory(spec);
          const kernel = runPronyKernel({ material, history: resolved });

          // 正弦稳态段：用 Prony 参数解析计算 E′、E″、tanδ（温度平移后的有效 τ）。
          const dynamics = resolved.segments
            .filter((s): s is Extract<typeof s, { type: 'sine' }> => s.type === 'sine')
            .map((s) => {
              // 温度对动态模量的影响等价于用平移后的 τ；直接构造平移材料。
              const shifted =
                kernel.shiftFactor === 1
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

          computed = {
            times: kernel.times,
            strains: kernel.strains,
            stresses: kernel.stresses,
            relaxationModulus: kernel.relaxationModulus,
            shiftFactor: kernel.shiftFactor,
            dynamics,
          };
        } catch (err) {
          const { code, message } = classifyComputeError(err);
          await this.terminalizeRow(jobObjectId, i, 'failed', code, message);
          continue;
        }

        // 2) 落库（结果文档 + 行状态）——失败只标记本行，不影响其余历程
        try {
          const now = new Date();
          await this.resultModel.replaceOne(
            { jobId: jobObjectId, index: i },
            {
              jobId: jobObjectId,
              index: i,
              times: computed.times,
              strains: computed.strains,
              stresses: computed.stresses,
              relaxationModulus: computed.relaxationModulus,
              dynamics: computed.dynamics,
              shiftFactor: computed.shiftFactor,
              createdAt: now,
              updatedAt: now,
            },
            { upsert: true },
          );
          await this.terminalizeRow(jobObjectId, i, 'succeeded');
        } catch (err) {
          // 结果文档可能已写入但状态没更新：删掉孤儿文档，本行按失败终态处理。
          await this.resultModel.collection
            .deleteOne({ jobId: jobObjectId, index: i })
            .catch(() => undefined);
          await this.terminalizeRow(
            jobObjectId,
            i,
            'failed',
            'RESULT_PERSISTENCE_FAILED',
            persistenceErrorMessage(err),
          );
        }
      }
    } catch (err) {
      // 执行循环之外的致命异常：
      // - 材料档被删除/读不出：无法计算，所有行终态化 failed（附原因）；
      // - 数据库不可用：终态化/收尾会写失败，保持 running，由启动/重连恢复续跑。
      this.logger.error(`[job ${jobId}] 执行致命异常: ${err instanceof Error ? err.stack : err}`);
      await this.failAllPendingRows(jobObjectId, err);
    } finally {
      await this.finalizeJob(jobId, jobObjectId);
      this.runningJobs.delete(jobId);
    }
  }

  /** 作业收尾：以各行状态为准重算 succeeded/failed，并落到 completed 终态。 */
  private async finalizeJob(jobId: string, jobObjectId: Types.ObjectId): Promise<void> {
    try {
      const job = await this.loadJob(jobObjectId);
      let succeeded = 0;
      let failed = 0;
      for (const row of job.histories) {
        if (row.status === 'succeeded') succeeded++;
        else if (row.status === 'failed') failed++;
      }
      await this.jobModel.collection.updateOne(
        { _id: jobObjectId },
        { $set: { status: 'completed' as const, succeeded, failed } },
      );
    } catch (err) {
      // 连库都失败时无法收尾：保持 running，等启动/重连恢复（onModuleInit）续跑。
      this.logger.error(
        `[job ${jobId}] 收尾失败，等待恢复: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** 把仍 pending 的行全部标记 failed（致命异常兜底）。 */
  private async failAllPendingRows(jobObjectId: Types.ObjectId, cause: unknown): Promise<void> {
    // 可识别的领域错误（如材料档被删）保留其具体错误码；其余归为执行中断。
    const errorCode =
      cause instanceof ViscoError ? cause.code : 'JOB_EXECUTION_FAILED';
    const message =
      cause instanceof ViscoError
        ? cause.message
        : `作业执行异常中断：${cause instanceof Error ? cause.message : String(cause)}`;
    let job: RawJobDoc | null;
    try {
      job = await this.loadJob(jobObjectId);
    } catch {
      return; // 读不出来（通常是库不可用），等恢复
    }
    for (const row of job.histories) {
      if (row.status !== 'pending') continue;
      try {
        await this.terminalizeRow(
          jobObjectId,
          row.index ?? -1,
          'failed',
          errorCode,
          message,
        );
      } catch (err) {
        this.logger.error(
          `[job ${jobObjectId.toHexString()}] 行 ${row.index} 终态化失败: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  /**
   * 原子更新某一行的状态（按 index 定位，且只允许 pending → 终态）。
   * 用聚合管道 $map 在服务端改内嵌数组，作业文档不再整体 save，
   * 因此更新体积与曲线无关，旧版大文档也能被正常更新。
   */
  private async terminalizeRow(
    jobObjectId: Types.ObjectId,
    index: number,
    status: 'succeeded',
  ): Promise<void>;
  private async terminalizeRow(
    jobObjectId: Types.ObjectId,
    index: number,
    status: 'failed',
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  private async terminalizeRow(
    jobObjectId: Types.ObjectId,
    index: number,
    status: HistoryStatus,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    const patch: Record<string, unknown> =
      status === 'failed'
        ? { status: 'failed' as const, errorCode, errorMessage }
        : { status: 'succeeded' as const };
    const pipeline = [
      {
        $set: {
          histories: {
            $map: {
              input: '$histories',
              as: 'h',
              in: {
                $mergeObjects: [
                  '$$h',
                  {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$$h.index', index] },
                          { $eq: ['$$h.status', 'pending'] },
                        ],
                      },
                      patch,
                      {},
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ];
    await this.jobModel.collection.updateOne({ _id: jobObjectId }, pipeline as never);
    // 进度计数随每条历程即时推进（只做字段级 $inc，不触碰曲线、不整体保存）。
    await this.jobModel.collection.updateOne(
      { _id: jobObjectId },
      { $inc: { [status === 'failed' ? 'failed' : 'succeeded']: 1 } },
    );
  }

  /**
   * 旧版本文档的状态行没有 index 字段。用数组位置补上
   * （新文档的行已有 index，$mergeObjects 中以行内已有值为准，不会被改写）。
   */
  private async backfillRowIndexes(jobObjectId: Types.ObjectId): Promise<void> {
    const pipeline = [
      {
        $set: {
          histories: {
            $map: {
              input: { $range: [0, { $size: { $ifNull: ['$histories', []] } }] },
              as: 'i',
              in: {
                $mergeObjects: [
                  { index: '$$i' },
                  { $arrayElemAt: [{ $ifNull: ['$histories', []] }, '$$i'] },
                ],
              },
            },
          },
        },
      },
    ];
    await this.jobModel.collection.updateOne({ _id: jobObjectId }, pipeline as never);
  }

  private async loadJob(jobObjectId: Types.ObjectId): Promise<RawJobDoc> {
    const job = (await this.jobModel.collection.findOne({ _id: jobObjectId })) as RawJobDoc | null;
    if (!job) {
      throw new ViscoError('JOB_NOT_FOUND', `作业不存在：${jobObjectId.toHexString()}`);
    }
    return job;
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
   * 曲线来自 job_history_results，按 index 合并进作业文档的状态行；
   * 升级前内嵌曲线的旧文档直接回退读旧字段。输出结构与旧版逐字段一致。
   */
  async getDetail(jobId: string): Promise<JobDetail> {
    const jobObjectId = toObjectId(jobId);
    const job = await this.loadJob(jobObjectId);

    const resultDocs = await this.resultModel
      .find({ jobId: jobObjectId })
      .sort({ index: 1 })
      .lean()
      .exec();
    const resultByIndex = new Map<number, (typeof resultDocs)[number]>(
      resultDocs.map((r) => [r.index, r]),
    );

    const histories: JobDetailHistory[] = job.histories.map((row, arrayPos) => {
      const index = typeof row.index === 'number' ? row.index : arrayPos;
      const merged: JobDetailHistory = {
        name: row.name,
        status: row.status,
        times: [],
        strains: [],
        stresses: [],
        relaxationModulus: [],
        dynamics: [],
        shiftFactor: 1,
      };
      if (row.status === 'succeeded') {
        const result = resultByIndex.get(index);
        if (result) {
          merged.times = result.times;
          merged.strains = result.strains;
          merged.stresses = result.stresses;
          merged.relaxationModulus = result.relaxationModulus;
          merged.dynamics = result.dynamics ?? [];
          merged.shiftFactor = result.shiftFactor ?? 1;
        } else {
          // 旧版本作业：曲线仍内嵌在作业文档状态行里
          merged.times = row.times ?? [];
          merged.strains = row.strains ?? [];
          merged.stresses = row.stresses ?? [];
          merged.relaxationModulus = row.relaxationModulus ?? [];
          merged.dynamics = (row.dynamics as HistoryDynamics[]) ?? [];
          merged.shiftFactor = row.shiftFactor ?? 1;
        }
      } else {
        // pending / failed：与旧版字段集保持一致（空曲线 + shiftFactor）
        merged.times = [];
        merged.strains = [];
        merged.stresses = [];
        merged.relaxationModulus = [];
        merged.dynamics = [];
        merged.shiftFactor = 1;
        if (row.status === 'failed') {
          merged.errorCode = row.errorCode;
          merged.errorMessage = row.errorMessage;
        }
      }
      return merged;
    });

    return {
      _id: job._id,
      materialName: job.materialName,
      materialId: job.materialId,
      status: job.status,
      totalHistories: job.totalHistories,
      succeeded: job.succeeded,
      failed: job.failed,
      histories,
      specs: job.specs ?? [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
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
