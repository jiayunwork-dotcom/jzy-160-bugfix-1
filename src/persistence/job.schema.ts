import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * 单条历程在作业文档中的“状态行”。
 *
 * 只承载小字段（名字、状态、失败原因与下标）。曲线数组（times/strains/
 * stresses/relaxationModulus/dynamics/shiftFactor）拆到独立集合
 * job_history_results，见 job-history-result.schema.ts 与 README「结果存储」。
 *
 * 升级前写入的旧文档里仍带有内嵌曲线字段；读取使用 lean() 取原始数据，
 * 旧字段不会被剥离，getDetail 会与新集合结果合并，因此旧作业完整兼容。
 */
@Schema({ _id: false })
export class HistoryResultModel {
  /** 该历程在作业中的下标（执行器原子更新状态时按它定位）。 */
  @Prop({ type: Number, required: true })
  index!: number;

  @Prop()
  name?: string;

  @Prop({ required: true, default: 'pending' })
  status!: 'pending' | 'succeeded' | 'failed';

  // 失败时的原因（成功时不输出这两个字段）
  @Prop()
  errorCode?: string;

  @Prop()
  errorMessage?: string;
}

const HistoryResultSchema = SchemaFactory.createForClass(HistoryResultModel);

@Schema({ timestamps: true, collection: 'jobs' })
export class JobDocumentDefinition {
  @Prop({ required: true, index: true })
  materialName!: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  materialId!: Types.ObjectId;

  @Prop({ required: true, default: 'queued' })
  status!: 'queued' | 'running' | 'completed';

  @Prop({ required: true, default: 0 })
  totalHistories!: number;

  @Prop({ required: true, default: 0 })
  succeeded!: number;

  @Prop({ required: true, default: 0 })
  failed!: number;

  @Prop({ type: [HistoryResultSchema], default: [] })
  histories!: HistoryResultModel[];

  /** 提交时的原始历程规格（执行器逐条取用），按宽松结构持久化。 */
  @Prop({ type: [Object], default: [], required: true })
  specs!: Record<string, unknown>[];
}

export type JobDocument = HydratedDocument<JobDocumentDefinition>;
export const JobSchema = SchemaFactory.createForClass(JobDocumentDefinition);
