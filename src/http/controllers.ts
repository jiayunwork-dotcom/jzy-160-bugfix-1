import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CreateMaterialDto, SubmitJobDto } from './dto';
import { MaterialService } from '../material/material.service';
import { JobService } from '../job/job.service';

@Controller('materials')
export class MaterialController {
  constructor(private readonly materialService: MaterialService) {}

  /** 建立材料档；响应回显计算出的瞬时模量 E0。 */
  @Post()
  async create(@Body() dto: CreateMaterialDto) {
    return this.materialService.create(dto);
  }

  @Get()
  async list() {
    return this.materialService.list();
  }

  @Get(':name')
  async get(@Param('name') name: string) {
    return this.materialService.findByName(name);
  }
}

@Controller('jobs')
export class JobController {
  constructor(private readonly jobService: JobService) {}

  /** 提交作业，异步执行，立即返回作业号。 */
  @Post()
  async submit(@Body() dto: SubmitJobDto) {
    // DTO 的段为宽联合，经领域层 resolveHistory 做判别式严校验
    return this.jobService.submit(dto as unknown as Parameters<JobService['submit']>[0]);
  }

  /** 查询作业进度与各历程状态。 */
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.jobService.getStatus(id);
  }

  /** 取完整结果（含应力/模量曲线）。 */
  @Get(':id/detail')
  async detail(@Param('id') id: string) {
    return this.jobService.getDetail(id);
  }

  /** 按材料档检索历史作业：GET /jobs?materialName=xxx */
  @Get()
  async byMaterial(@Query('materialName') materialName: string) {
    return this.jobService.findByMaterial(materialName);
  }
}
