import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class WlfParamsModel {
  @Prop({ required: true })
  tRef!: number;

  @Prop({ required: true })
  c1!: number;

  @Prop({ required: true })
  c2!: number;
}

@Schema({ _id: false })
export class PronyBranchModel {
  @Prop({ required: true })
  modulus!: number;

  @Prop({ required: true })
  tau!: number;
}

@Schema({ timestamps: true, collection: 'materials' })
export class MaterialDocumentDefinition {
  @Prop({ required: true, unique: true })
  name!: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  eInf!: number;

  @Prop({ required: true, default: 0 })
  e0!: number;

  @Prop({ type: [PronyBranchModel], default: [] })
  branches!: PronyBranchModel[];

  @Prop({ type: WlfParamsModel, required: false, _id: false })
  wlf?: WlfParamsModel | null;
}

export type MaterialDocument = HydratedDocument<MaterialDocumentDefinition>;
export const MaterialSchema = SchemaFactory.createForClass(MaterialDocumentDefinition);
