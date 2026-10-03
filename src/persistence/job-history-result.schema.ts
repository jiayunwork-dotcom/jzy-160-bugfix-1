import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * 正弦稳态段解析动态模量（与作业文档内嵌行结构一致）。
 */
@Schema({ _id: false })
export class HistoryDynamicsModel {
  @Prop()
  frequency!: number;

  @Prop()
  omega!: number;

  @Prop()
  storageModulus!: number;

  @Prop()
  lossModulus!: number;

  @Prop()
  lossTangent!: number;

  @Prop()
  complexMagnitude!: number;
}

const HistoryDynamicsSchema = SchemaFactory.createForClass(HistoryDynamicsModel);

/**
 * 单条历程结果文档（集合 job_history_results）。
 *
 * 设计原因见 README「结果存储」一节：一条历程的 times/strains/stresses/
 * relaxationModulus 四条曲线随输出点数线性增长（30000 点约 1MB），
 * 十条以上历程内嵌在同一个 job 文档里会撞上 MongoDB 单文档 16MiB 上限。
 * 拆成“每条历程一个文档”后，任何单文档都只承载一条历程的数据：
 * - 单条历程结果的写入与作业总条数无关，不会再因兄弟历程撑爆文档；
 * - 单文档体积只取决于单条历程点数，远低于上限。
 *
 * 作业文档（jobs 集合）只保留状态行（name/status/error），
 * 完整结果由 (jobId, index) 在读取时合并回作业文档，API 结构不变。
 */
@Schema({ timestamps: true, collection: 'job_history_results' })
export class JobHistoryResultDefinition {
  /** 所属作业（jobs._id） */
  @Prop({ type: Types.ObjectId, required: true })
  jobId!: Types.ObjectId;

  /** 该历程在作业中的下标（与 jobs.histories[].index 对齐） */
  @Prop({ type: Number, required: true })
  index!: number;

  @Prop({ type: [Number], required: true })
  times!: number[];

  @Prop({ type: [Number], required: true })
  strains!: number[];

  @Prop({ type: [Number], required: true })
  stresses!: number[];

  @Prop({ type: [Number], required: true })
  relaxationModulus!: number[];

  @Prop({ type: [HistoryDynamicsSchema], _id: false, default: [] })
  dynamics!: HistoryDynamicsModel[];

  @Prop({ type: Number, default: 1 })
  shiftFactor!: number;
}

export type JobHistoryResultDocument = HydratedDocument<JobHistoryResultDefinition>;
export const JobHistoryResultSchema =
  SchemaFactory.createForClass(JobHistoryResultDefinition);

// 每条历程至多一个结果文档；按作业检索结果时也走该复合索引。
JobHistoryResultSchema.index({ jobId: 1, index: 1 }, { unique: true });
