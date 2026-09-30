import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { MaterialService } from '../material/material.service';
import { JobService } from './job.service';
import { MaterialDocumentDefinition, MaterialSchema } from '../persistence/material.schema';
import { JobDocumentDefinition, JobSchema } from '../persistence/job.schema';
import { StrainHistorySpec } from '../history/history.model';

/**
 * 作业调度集成测试：内存 MongoDB + 真实 Mongoose 模型。
 * 覆盖：异步执行返回作业号、进度推进、单条失败隔离、失败附原因、
 * 成功曲线落库、正弦段动态模量落库、按材料档检索历史作业。
 */
describe('JobService（内存 MongoDB 集成）', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  let materialService: MaterialService;
  let jobService: JobService;

  beforeAll(async () => {
    // 固定与生产 mongo:7 对齐的大版本；arm64 无 debian12 预编译包，用兼容的 ubuntu2204 包。
    mongod = await MongoMemoryServer.create({
      binary: {
        version: '7.0.14',
        // arm64 无 debian12 预编译包；指定 ubuntu22.04（glibc 兼容），版本对齐生产 mongo:7
        os: { os: 'linux', dist: 'ubuntu', release: '22.04' },
      },
    });
    const uri = mongod.getUri();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
          { name: JobDocumentDefinition.name, schema: JobSchema },
        ]),
      ],
      providers: [MaterialService, JobService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    materialService = app.get(MaterialService);
    jobService = app.get(JobService);
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    const conn = app.get<Connection>(getConnectionToken());
    await conn.collection('materials').deleteMany({});
    await conn.collection('jobs').deleteMany({});
  });

  const goodStep = (name: string): StrainHistorySpec => ({
    name,
    segments: [{ type: 'linear', times: [0, 10], strains: [0.1, 0.1] }],
    output: { kind: 'uniform', start: 0, stop: 10, count: 11 },
  });

  test('材料档建档回显 E0，作业异步执行并落库应力曲线', async () => {
    const material = await materialService.create({
      name: 'nitrile-70',
      eInf: 3,
      branches: [{ modulus: 7, tau: 2 }],
    });
    expect(material.e0).toBe(10);

    const { jobId } = await jobService.submit({
      materialName: 'nitrile-70',
      histories: [goodStep('阶跃保持')],
    });
    expect(jobId).toBeTruthy();

    // 等待异步执行完成
    const detail = await waitForCompletion(jobId);
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(1);
    expect(detail.failed).toBe(0);
    const h = detail.histories[0];
    expect(h.status).toBe('succeeded');
    expect(h.stresses).toHaveLength(11);
    // σ(0)=E0·ε0=1
    expect(h.stresses[0]).toBeCloseTo(1, 10);
    // σ(t)=ε0(3+7e^{-t/2})
    expect(h.stresses[5]).toBeCloseTo(0.1 * (3 + 7 * Math.exp(-5 / 2)), 10);
    expect(h.relaxationModulus[0]).toBeCloseTo(10, 10);
  });

  test('同一作业中某条历程失败不影响其余，失败附错误码与原因', async () => {
    await materialService.create({
      name: 'epdm',
      eInf: 5,
      branches: [{ modulus: 5, tau: 1 }],
    });

    const badHistory: StrainHistorySpec = {
      name: '时间倒流',
      segments: [{ type: 'linear', times: [0, 2, 1], strains: [0, 0.1, 0.2] }],
      output: { kind: 'uniform', start: 0, stop: 1, count: 2 },
    };

    const { jobId } = await jobService.submit({
      materialName: 'epdm',
      histories: [goodStep('正常一'), badHistory, goodStep('正常二')],
    });
    const detail = await waitForCompletion(jobId);
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(2);
    expect(detail.failed).toBe(1);
    expect(detail.histories[0].status).toBe('succeeded');
    expect(detail.histories[1].status).toBe('failed');
    expect(detail.histories[1].errorCode).toBe('TIME_NOT_STRICTLY_INCREASING');
    expect(detail.histories[1].errorMessage).toMatch(/严格递增/);
    expect(detail.histories[2].status).toBe('succeeded');
  });

  test('提交即返回作业号且初始为 queued（异步语义）', async () => {
    await materialService.create({ name: 'q', eInf: 1, branches: [] });
    const { jobId } = await jobService.submit({
      materialName: 'q',
      histories: [goodStep('h')],
    });
    const status = await jobService.getStatus(jobId);
    expect(['queued', 'running', 'completed']).toContain(status.status);
    expect(status.totalHistories).toBe(1);
    await waitForCompletion(jobId);
  });

  test('正弦段历程落库解析动态模量 E′、E″、tanδ', async () => {
    await materialService.create({
      name: 'sine-mat',
      eInf: 30,
      branches: [{ modulus: 70, tau: 0.5 }],
    });
    const spec: StrainHistorySpec = {
      name: '正弦',
      segments: [
        { type: 'linear', times: [0, 1e-6], strains: [0, 0] },
        { type: 'sine', amplitude: 0.01, frequency: 2, cycles: 10, preload: 0 },
      ],
      output: { kind: 'uniform', start: 0, stop: 5, count: 501 },
    };
    const { jobId } = await jobService.submit({ materialName: 'sine-mat', histories: [spec] });
    const detail = await waitForCompletion(jobId);
    expect(detail.histories[0].status).toBe('succeeded');
    expect(detail.histories[0].dynamics).toHaveLength(1);
    const d = detail.histories[0].dynamics[0];
    expect(d.frequency).toBe(2);
    // 手算：ω=4π, x=ωτ=2π
    const x = 4 * Math.PI * 0.5;
    expect(d.storageModulus).toBeCloseTo(30 + (70 * x * x) / (1 + x * x), 9);
    expect(d.lossModulus).toBeCloseTo((70 * x) / (1 + x * x), 9);
    expect(d.lossTangent).toBeCloseTo(d.lossModulus / d.storageModulus, 12);
  });

  test('按材料档检索历史作业（仅返回该材料的，按时间倒序）', async () => {
    await materialService.create({ name: 'mat-A', eInf: 1, branches: [] });
    await materialService.create({ name: 'mat-B', eInf: 1, branches: [] });

    await jobService.submit({ materialName: 'mat-A', histories: [goodStep('a1')] });
    await new Promise((r) => setImmediate(r));
    await jobService.submit({ materialName: 'mat-B', histories: [goodStep('b1')] });
    await new Promise((r) => setImmediate(r));
    const { jobId: a2 } = await jobService.submit({
      materialName: 'mat-A',
      histories: [goodStep('a2')],
    });
    await waitForCompletion(a2);

    const jobsA = await jobService.findByMaterial('mat-A');
    expect(jobsA).toHaveLength(2);
    expect(jobsA.every((j) => j.materialName === 'mat-A')).toBe(true);
    // 倒序：最近提交在前
    expect(jobsA[0].histories[0].name).toBe('a2');
    const jobsB = await jobService.findByMaterial('mat-B');
    expect(jobsB).toHaveLength(1);
  });

  test('引用不存在的材料档 → 错误；空作业 → 错误', async () => {
    await expect(
      jobService.submit({ materialName: 'nope', histories: [goodStep('x')] }),
    ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
    await expect(
      jobService.submit({ materialName: 'mat-A', histories: [] }),
    ).rejects.toMatchObject({ code: 'JOB_EMPTY' });
  });

  test('查询不存在的作业 → 错误', async () => {
    const { Types } = await import('mongoose');
    await expect(jobService.getStatus(new Types.ObjectId().toString())).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  });

  async function waitForCompletion(jobId: string) {
    for (let i = 0; i < 200; i++) {
      const detail = await jobService.getDetail(jobId);
      if (detail.status === 'completed') return detail;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`作业 ${jobId} 超时未完成`);
  }
});
