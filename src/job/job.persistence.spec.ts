import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { INestApplication } from '@nestjs/common';
import { MaterialService } from '../material/material.service';
import { JobService } from './job.service';
import { MaterialDocumentDefinition, MaterialSchema } from '../persistence/material.schema';
import { JobDocument, JobDocumentDefinition, JobSchema } from '../persistence/job.schema';
import {
  JobResultDocument,
  JobResultDocumentDefinition,
  JobResultSchema,
} from '../persistence/job-result.schema';
import { StrainHistorySpec } from '../history/history.model';

/**
 * 结果存储与终态保证的集成测试。
 *
 * 跑在真实 MongoDB 上：mongodb-memory-server 启动的是官方 mongod 7.0.14
 * 二进制（与生产 mongo:7 同大版本），16MB BSON 上限、唯一索引等行为与
 * 生产一致 —— 不是测试替身。本文件覆盖：
 *
 * 1. 十条 × 三万点的大作业跑完，曲线完整取回，与单独提交逐元素一致；
 * 2. 单条结果写不进库（真实触发 16MB 超限）→ 该条 failed 附原因，其余照常；
 * 3. 执行器级异常（材料档被删）→ 作业落终态，未完成的历程附原因；
 * 4. 崩溃恢复：挂在 running 的作业被重新执行到终态，已落库结果不被覆盖；
 * 5. 升级前的老格式作业（曲线内嵌、无结果文档）照常查进度/取曲线/按材料检索。
 */
describe('作业持久化与终态保证（真实 mongod）', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  let materialService: MaterialService;
  let jobService: JobService;
  let jobModel: Model<JobDocument>;
  let resultModel: Model<JobResultDocument>;

  // 用户场景：E∞=3，支路 (4, 0.1) 与 (6, 10)，无 WLF
  const MATERIAL = {
    name: 'nitrile-70',
    eInf: 3,
    branches: [
      { modulus: 4, tau: 0.1 },
      { modulus: 6, tau: 10 },
    ],
  };
  const EPS0 = 0.1;
  // 解析解：σ(t)=E(t)·ε0，E(t)=3+4e^(−t/0.1)+6e^(−t/10)
  const analyticModulus = (t: number): number =>
    3 + 4 * Math.exp(-t / 0.1) + 6 * Math.exp(-t / 10);

  const stepHold = (name: string, count: number): StrainHistorySpec => ({
    name,
    segments: [{ type: 'linear', times: [0, 100], strains: [EPS0, EPS0] }],
    output: { kind: 'uniform', start: 0, stop: 100, count },
  });

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: {
        version: '7.0.14',
        os: { os: 'linux', dist: 'ubuntu', release: '22.04' },
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
          { name: JobDocumentDefinition.name, schema: JobSchema },
          { name: JobResultDocumentDefinition.name, schema: JobResultSchema },
        ]),
      ],
      providers: [MaterialService, JobService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    materialService = app.get(MaterialService);
    jobService = app.get(JobService);
    jobModel = app.get(getModelToken(JobDocumentDefinition.name));
    resultModel = app.get(getModelToken(JobResultDocumentDefinition.name));
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    const conn = app.get<Connection>(getConnectionToken());
    await conn.collection('materials').deleteMany({});
    await conn.collection('jobs').deleteMany({});
    await conn.collection('job_results').deleteMany({});
  });

  async function waitForCompletion(jobId: string, timeoutMs = 120000) {
    // 轮询只读轻量台账（getStatus 不加载曲线），完成后再一次性取完整结果，
    // 避免大作业的曲线反序列化与执行器抢占事件循环。
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await jobService.getStatus(jobId);
      if (status.status === 'completed') break;
      if (Date.now() > deadline) throw new Error(`作业 ${jobId} 超时未完成`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return jobService.getDetail(jobId);
  }

  async function expectNoJobLeftRunning(): Promise<void> {
    const stuck = await jobModel.find({ status: { $in: ['queued', 'running'] } }).exec();
    expect(stuck.map((d) => d.id)).toEqual([]);
  }

  test('十条 × 三万点大作业：跑到 completed，曲线完整，与单独提交逐元素一致', async () => {
    await materialService.create(MATERIAL);

    const histories = Array.from({ length: 10 }, (_, i) =>
      stepHold(`阶跃保持-${i + 1}`, 30000),
    );
    const { jobId } = await jobService.submit({ materialName: MATERIAL.name, histories });
    const detail = await waitForCompletion(jobId);

    // 全部终态：作业 completed，十条全 succeeded
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(10);
    expect(detail.failed).toBe(0);
    expect(detail.histories.map((h: { status: string }) => h.status)).toEqual(
      Array(10).fill('succeeded'),
    );

    // 每条的四条曲线都完整取回（各 30000 点）
    for (const h of detail.histories) {
      expect(h.times).toHaveLength(30000);
      expect(h.strains).toHaveLength(30000);
      expect(h.stresses).toHaveLength(30000);
      expect(h.relaxationModulus).toHaveLength(30000);
    }

    // 锚定解析解：σ(0)=E0·ε0=1.3；σ(100)=0.1·(3+6e⁻¹⁰)；E(t) 同理
    const first = detail.histories[0];
    expect(first.stresses[0]).toBeCloseTo(1.3, 12);
    expect(first.relaxationModulus[0]).toBeCloseTo(13, 12);
    expect(first.stresses[29999]).toBeCloseTo(EPS0 * analyticModulus(100), 12);
    expect(first.relaxationModulus[29999]).toBeCloseTo(analyticModulus(100), 12);

    // 同一条历程单独提交一次
    const solo = await jobService.submit({
      materialName: MATERIAL.name,
      histories: [stepHold('阶跃保持-单独', 30000)],
    });
    const soloDetail = await waitForCompletion(solo.jobId);
    expect(soloDetail.succeeded).toBe(1);
    const soloRow = soloDetail.histories[0];

    // 大作业里的每一条都与单独提交的结果逐元素精确一致（内核确定性）
    for (const h of detail.histories) {
      expect(h.times).toEqual(soloRow.times);
      expect(h.strains).toEqual(soloRow.strains);
      expect(h.stresses).toEqual(soloRow.stresses);
      expect(h.relaxationModulus).toEqual(soloRow.relaxationModulus);
    }

    // 进度查询与按材料检索路径正常
    const status = await jobService.getStatus(jobId);
    expect(status.status).toBe('completed');
    expect(status.histories).toHaveLength(10);
    const listed = await jobService.findByMaterial(MATERIAL.name);
    expect(listed.map((j) => j.id).sort()).toEqual([jobId, solo.jobId].sort());

    await expectNoJobLeftRunning();
  }, 180000);

  test('单条结果写不进库（真实 16MB 超限）→ 该条 failed 附原因，其余照常出结果，作业落终态', async () => {
    await materialService.create(MATERIAL);

    // 35 万点 × 4 条曲线的 BSON 约 21MB，单结果文档真实超限（驱动报 10334）
    const huge = stepHold('超大规模历程', 350000);
    const normal = stepHold('正常历程', 101);
    const { jobId } = await jobService.submit({
      materialName: MATERIAL.name,
      histories: [huge, normal],
    });
    const detail = await waitForCompletion(jobId);

    // 作业落到终态，不停在 running
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(1);
    expect(detail.failed).toBe(1);

    // 写不进库的那条：failed + 错误码 + 原因
    const failedRow = detail.histories[0];
    expect(failedRow.status).toBe('failed');
    expect(failedRow.errorCode).toBe('RESULT_PERSISTENCE_FAILED');
    expect(failedRow.errorMessage).toMatch(/结果写入数据库失败/);
    // 服务端拒绝（BSONObj size ... larger）或驱动序列化越界（out of range）都算
    expect(failedRow.errorMessage).toMatch(/BSON|size|larger|out of range/i);
    // 失败条没有曲线（与旧行为一致）
    expect(failedRow.times).toEqual([]);
    expect(failedRow.stresses).toEqual([]);

    // 其余历程照常出结果，曲线完整
    const okRow = detail.histories[1];
    expect(okRow.status).toBe('succeeded');
    expect(okRow.stresses).toHaveLength(101);
    expect(okRow.stresses[0]).toBeCloseTo(1.3, 12);

    // 失败条的结果文档已清理，不留孤儿
    const orphans = await resultModel.find({ jobId: new Types.ObjectId(jobId), historyIndex: 0 }).exec();
    expect(orphans).toEqual([]);

    await expectNoJobLeftRunning();
  }, 120000);

  test('执行器级异常（材料档不存在）→ 作业落终态，未完成历程标 failed 附原因', async () => {
    // 直接构造 queued 作业（绕过 submit 的材料校验），模拟排队期间材料档被删
    const job = await jobModel.create({
      materialName: 'ghost-material',
      materialId: new Types.ObjectId(),
      status: 'queued',
      totalHistories: 2,
      succeeded: 0,
      failed: 0,
      histories: [
        { name: 'h1', status: 'pending' },
        { name: 'h2', status: 'pending' },
      ],
      specs: [stepHold('h1', 11), stepHold('h2', 11)],
    });

    await jobService.execute(job.id);

    const status = await jobService.getStatus(job.id);
    expect(status.status).toBe('completed');
    expect(status.succeeded).toBe(0);
    expect(status.failed).toBe(2);
    for (const h of status.histories) {
      expect(h.status).toBe('failed');
      expect(h.errorCode).toBe('MATERIAL_NOT_FOUND');
      expect(h.errorMessage).toMatch(/ghost-material/);
    }
    await expectNoJobLeftRunning();
  }, 30000);

  test('崩溃恢复：挂在 running 的作业重跑到终态，已落库的结果不被重算覆盖', async () => {
    await materialService.create(MATERIAL);

    // 手工摆一个"崩溃现场"：作业卡在 running，第 0 条已 succeeded 且结果
    // 文档里是哨兵数据（内核绝不可能算出 42/43），第 1、2 条还是 pending。
    const specs = [stepHold('crash-0', 11), stepHold('crash-1', 11), stepHold('crash-2', 11)];
    const job = await jobModel.create({
      materialName: MATERIAL.name,
      materialId: new Types.ObjectId(),
      status: 'running',
      totalHistories: 3,
      succeeded: 1,
      failed: 0,
      histories: [
        { name: 'crash-0', status: 'succeeded' },
        { name: 'crash-1', status: 'pending' },
        { name: 'crash-2', status: 'pending' },
      ],
      specs,
    });
    await resultModel.create({
      jobId: job._id,
      historyIndex: 0,
      name: 'crash-0',
      times: [0, 1],
      strains: [EPS0, EPS0],
      stresses: [42, 43],
      relaxationModulus: [99, 98],
      dynamics: [],
      shiftFactor: 1,
    });

    await jobService.recoverInterruptedJobs();

    const detail = await waitForCompletion(job.id);
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(3);
    expect(detail.failed).toBe(0);

    // 第 0 条：恢复不重算、不覆盖，崩溃前落库的哨兵数据原样保留
    expect(detail.histories[0].stresses).toEqual([42, 43]);
    expect(detail.histories[0].relaxationModulus).toEqual([99, 98]);

    // 第 1、2 条：恢复后真正算出结果（σ(0)=E0·ε0=1.3）
    for (const i of [1, 2]) {
      expect(detail.histories[i].status).toBe('succeeded');
      expect(detail.histories[i].stresses).toHaveLength(11);
      expect(detail.histories[i].stresses[0]).toBeCloseTo(1.3, 12);
    }
    await expectNoJobLeftRunning();
  }, 30000);

  test('升级前的老格式作业（曲线内嵌、无结果文档）照常查进度、取曲线、按材料检索', async () => {
    await materialService.create(MATERIAL);

    // 直接落一个升级前格式的文档：结果曲线内嵌在 histories 里，job_results 无对应文档
    const legacyTimes = [0, 1, 2, 3];
    const legacyStrains = [EPS0, EPS0, EPS0, EPS0];
    const legacyStresses = legacyTimes.map((t) => EPS0 * analyticModulus(t));
    const legacyModulus = legacyTimes.map(analyticModulus);
    const legacyDynamics = [
      {
        frequency: 2,
        omega: 4 * Math.PI,
        storageModulus: 12.9,
        lossModulus: 0.8,
        lossTangent: 0.062,
        complexMagnitude: 12.925,
      },
    ];
    const legacy = await jobModel.create({
      materialName: MATERIAL.name,
      materialId: new Types.ObjectId(),
      status: 'completed',
      totalHistories: 1,
      succeeded: 1,
      failed: 0,
      histories: [
        {
          name: '老作业-阶跃',
          status: 'succeeded',
          times: legacyTimes,
          strains: legacyStrains,
          stresses: legacyStresses,
          relaxationModulus: legacyModulus,
          dynamics: legacyDynamics,
          shiftFactor: 1,
        },
      ],
      specs: [stepHold('老作业-阶跃', 4)],
    });

    // 查进度
    const status = await jobService.getStatus(legacy.id);
    expect(status.status).toBe('completed');
    expect(status.succeeded).toBe(1);
    expect(status.histories[0]).toMatchObject({ name: '老作业-阶跃', status: 'succeeded' });

    // 取完整结果：内嵌曲线逐元素原样返回
    const detail = await jobService.getDetail(legacy.id);
    const row = detail.histories[0];
    expect(row.times).toEqual(legacyTimes);
    expect(row.strains).toEqual(legacyStrains);
    expect(row.stresses).toEqual(legacyStresses);
    expect(row.relaxationModulus).toEqual(legacyModulus);
    expect(row.dynamics).toMatchObject(legacyDynamics);
    expect(row.shiftFactor).toBe(1);

    // 按材料档检索：老作业与新作业都能检出
    const { jobId: freshId } = await jobService.submit({
      materialName: MATERIAL.name,
      histories: [stepHold('新作业-阶跃', 11)],
    });
    await waitForCompletion(freshId);
    const listed = await jobService.findByMaterial(MATERIAL.name);
    expect(listed.map((j) => j.id).sort()).toEqual([legacy.id, freshId].sort());

    await expectNoJobLeftRunning();
  }, 30000);
});
