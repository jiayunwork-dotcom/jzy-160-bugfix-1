import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * 单条历程的计算结果曲线，独立成文档存放（集合 job_results）。
 *
 * 为什么拆出来：MongoDB 单文档有 16MB BSON 上限。结果曲线若全部内嵌在
 * 作业文档里，上限按"整个作业"计算（10 条 × 3 万点 × 4 条曲线的 BSON
 * 约 17.5MB，直接超限）；拆成每条历程一个文档后，上限按"单条历程"计算
 * （3 万点 ≈ 1.8MB，余量约 8 倍），作业包含多少条历程都不再受限。
 *
 * 每个结果文档由 (jobId, historyIndex) 唯一标识，写入用 upsert：
 * 崩溃恢复重跑同一历程时幂等覆盖，不会产生重复文档。
 */
@Schema({ timestamps: true, collection: 'job_results' })
export class JobResultDocumentDefinition {
  /** 所属作业（jobs._id） */
  @Prop({ type: Types.ObjectId, required: true })
  jobId!: Types.ObjectId;

  /** 历程在作业内的序号（与 jobs.histories / jobs.specs 的下标一致） */
  @Prop({ required: true })
  historyIndex!: number;

  /** 冗余历程名，便于排查孤儿文档；读取路径不依赖它 */
  @Prop()
  name?: string;

  @Prop({ type: [Number], default: [] })
  times!: number[];

  @Prop({ type: [Number], default: [] })
  strains!: number[];

  @Prop({ type: [Number], default: [] })
  stresses!: number[];

  @Prop({ type: [Number], default: [] })
  relaxationModulus!: number[];

  /** 各正弦稳态段的解析动态模量（与 job.schema 内嵌结构一致，按段顺序） */
  @Prop({
    type: [
      {
        frequency: Number,
        omega: Number,
        storageModulus: Number,
        lossModulus: Number,
        lossTangent: Number,
        complexMagnitude: Number,
      },
    ],
    _id: false,
    default: [],
  })
  dynamics!: {
    frequency: number;
    omega: number;
    storageModulus: number;
    lossModulus: number;
    lossTangent: number;
    complexMagnitude: number;
  }[];

  @Prop({ default: 1 })
  shiftFactor!: number;
}

export type JobResultDocument = HydratedDocument<JobResultDocumentDefinition>;
export const JobResultSchema = SchemaFactory.createForClass(JobResultDocumentDefinition);

// 一条历程一个结果文档：唯一索引保证 upsert 幂等；getDetail 按 jobId 一次取回。
JobResultSchema.index({ jobId: 1, historyIndex: 1 }, { unique: true });
