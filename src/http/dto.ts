import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

function IsFiniteNumber(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: 'isFiniteNumber',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'number' && Number.isFinite(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} 必须是有限数值`;
        },
      },
    });
  };
}

export class WlfParamsDto {
  @IsFiniteNumber()
  tRef!: number;

  @IsFiniteNumber()
  c1!: number;

  @IsFiniteNumber()
  c2!: number;
}

export class PronyBranchDto {
  @IsFiniteNumber()
  modulus!: number;

  @IsFiniteNumber()
  tau!: number;
}

export class CreateMaterialDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsFiniteNumber()
  eInf!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PronyBranchDto)
  branches!: PronyBranchDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WlfParamsDto)
  wlf?: WlfParamsDto;
}

export class OutputGridDto {
  @IsIn(['points', 'uniform'])
  kind!: 'points' | 'uniform';

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMinSize(1)
  times?: number[];

  @IsOptional()
  @IsFiniteNumber()
  start?: number;

  @IsOptional()
  @IsFiniteNumber()
  stop?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  count?: number;
}

class SineSegmentDto {
  @IsIn(['sine'])
  type!: 'sine';

  @IsFiniteNumber()
  amplitude!: number;

  @IsFiniteNumber()
  frequency!: number;

  @IsFiniteNumber()
  cycles!: number;

  @IsOptional()
  @IsFiniteNumber()
  preload?: number;
}

class LinearSegmentDto {
  @IsIn(['linear'])
  type!: 'linear';

  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMinSize(2)
  times!: number[];

  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMinSize(2)
  strains!: number[];
}

/** 联合类型段：按 type 区分，两者字段都标可选，最终由领域层严校验。 */
export class SegmentDto {
  @IsIn(['linear', 'sine'])
  type!: 'linear' | 'sine';

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  times?: number[];

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  strains?: number[];

  @IsOptional()
  @IsFiniteNumber()
  amplitude?: number;

  @IsOptional()
  @IsFiniteNumber()
  frequency?: number;

  @IsOptional()
  @IsFiniteNumber()
  cycles?: number;

  @IsOptional()
  @IsFiniteNumber()
  preload?: number;
}

export class HistorySpecDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsDefined()
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments!: SegmentDto[];

  @IsOptional()
  @IsFiniteNumber()
  temperature?: number;

  @ValidateNested()
  @Type(() => OutputGridDto)
  @IsDefined()
  output!: OutputGridDto;
}

export class SubmitJobDto {
  @IsString()
  materialName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => HistorySpecDto)
  histories!: HistorySpecDto[];
}

// 保留 LinearSegmentDto / SineSegmentDto 的导出以免未使用告警（文档参考用）
export type { LinearSegmentDto, SineSegmentDto };
