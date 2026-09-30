import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** 单条历程结果在作业文档中的内嵌结构。 */
@Schema({ _id: false })
export class HistoryResultModel {
  @Prop()
  name?: string;

  @Prop({ required: true, default: 'pending' })
  status!: 'pending' | 'succeeded' | 'failed';

  // 成功时的结果
  @Prop({ type: [Number], default: [] })
  times!: number[];

  @Prop({ type: [Number], default: [] })
  strains!: number[];

  @Prop({ type: [Number], default: [] })
  stresses!: number[];

  @Prop({ type: [Number], default: [] })
  relaxationModulus!: number[];

  /** 各正弦稳态段的解析动态模量（按段顺序） */
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

  // 失败时的原因
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
