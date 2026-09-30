import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ViscoError } from '../common/errors';
import { StoredMaterial, ViscoMaterial, validateMaterial } from './material.model';
import { MaterialDocument, MaterialDocumentDefinition } from '../persistence/material.schema';

function toDomain(doc: MaterialDocument): StoredMaterial {
  return {
    name: doc.name,
    description: doc.description,
    eInf: doc.eInf,
    e0: doc.e0,
    branches: doc.branches.map((b) => ({ modulus: b.modulus, tau: b.tau })),
    wlf: doc.wlf ? { tRef: doc.wlf.tRef, c1: doc.wlf.c1, c2: doc.wlf.c2 } : null,
  };
}

@Injectable()
export class MaterialService {
  constructor(
    @InjectModel(MaterialDocumentDefinition.name)
    private readonly materialModel: Model<MaterialDocument>,
  ) {}

  /** 建档：校验参数，计算并回显 E0；重名返回错误。 */
  async create(input: ViscoMaterial): Promise<StoredMaterial> {
    const validated = validateMaterial(input);
    try {
      const doc = await this.materialModel.create({
        name: validated.name,
        description: validated.description,
        eInf: validated.eInf,
        e0: validated.e0,
        branches: validated.branches,
        wlf: validated.wlf ?? undefined,
      });
      return toDomain(doc);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        throw new ViscoError('DUPLICATE_MATERIAL_NAME', `材料档名称已存在：${input.name}`);
      }
      throw err;
    }
  }

  async findByName(name: string): Promise<StoredMaterial> {
    const doc = await this.materialModel.findOne({ name }).exec();
    if (!doc) {
      throw new ViscoError('MATERIAL_NOT_FOUND', `材料档不存在：${name}`);
    }
    return toDomain(doc);
  }

  /** 供作业引用：返回材料文档 ObjectId 的字符串形式。 */
  async findIdByName(name: string): Promise<string> {
    const doc = await this.materialModel.findOne({ name }, { _id: 1 }).exec();
    if (!doc) {
      throw new ViscoError('MATERIAL_NOT_FOUND', `材料档不存在：${name}`);
    }
    return doc._id.toString();
  }

  async list(): Promise<StoredMaterial[]> {
    const docs = await this.materialModel.find().sort({ name: 1 }).exec();
    return docs.map(toDomain);
  }
}
