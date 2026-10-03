import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { BSON, ObjectId } from 'bson';
import { MaterialService } from '../material/material.service';
import { JobService } from './job.service';
import { MaterialDocumentDefinition, MaterialSchema } from '../persistence/material.schema';
import { JobDocumentDefinition, JobSchema } from '../persistence/job.schema';
import {
  JobHistoryResultDefinition,
  JobHistoryResultSchema,
  JobHistoryResultDocument,
} from '../persistence/job-history-result.schema';
import { StrainHistorySpec } from '../history/history.model';

/**
 * 真实 MongoDB 上的作业存储/恢复验收测试。
 *
 * 默认用 mongodb-memory-server 起一个**真实的 mongod 7.0.14 进程**
 * （不是测试替身：真正执行 BSON 16MiB 上限、真正建唯一索引）；
 * 也可通过环境变量指向独立 mongo 实例（compose 的 mongo:7 等）：
 *
 *   TEST_MONGO_URI=mongodb://localhost:27017 npm run test:real-mongo
 *
 * 覆盖验收口径：
 * - 10 条 × 30000 点大作业跑到 completed，十条全部 succeeded，
 *   times/strains/stresses/relaxationModulus 完整取回，且与十条各自单独
 *   提交的结果逐点完全一致；作业文档与每条结果文档均不超过 BSON 上限。
 * - 结果写不进库（注入一次真实驱动层面的写失败）时：该历程 failed 附原因，
 *   其余照常 succeeded，作业落到 completed，不再挂 running。
 * - 命名卷里升级前的旧作业（曲线内嵌）：已完成的查进度/取曲线/按材料检索
 *   全部可用；卡在 running 的由启动恢复续跑到 completed。
 * - 新结构作业崩溃后留下的 running 作业同样被恢复。
 */
describe('作业存储与恢复（真实 MongoDB）', () => {
  let externalUri: string | undefined;
  let mongod: MongoMemoryServer | undefined;
  let app: INestApplication;
  let connection: Connection;
  let materialService: MaterialService;
  let jobService: JobService;
  let resultModel: Model<JobHistoryResultDocument>;

  function uniqueDbName(): string {
    return `visco_real_mongo_${process.pid}_${Date.now()}`;
  }

  function withDbName(uri: string, db: string): string {
    const url = new URL(uri);
    url.pathname = `/${db}`;
    return url.toString();
  }

  beforeAll(async () => {
    externalUri = process.env.TEST_MONGO_URI;
    let uri: string;
    if (externalUri) {
      uri = withDbName(externalUri, uniqueDbName());
    } else {
      mongod = await MongoMemoryServer.create({
        binary: {
          version: '7.0.14',
          os: { os: 'linux', dist: 'ubuntu', release: '22.04' },
        },
      });
      uri = withDbName(mongod.getUri(), uniqueDbName());
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
          { name: JobDocumentDefinition.name, schema: JobSchema },
          {
            name: JobHistoryResultDefinition.name,
            schema: JobHistoryResultSchema,
          },
        ]),
      ],
      providers: [MaterialService, JobService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    materialService = app.get(MaterialService);
    jobService = app.get(JobService);
    resultModel = app.get<Model<JobHistoryResultDocument>>(
      getModelToken(JobHistoryResultDefinition.name),
    );
  }, 120000);

  afterAll(async () => {
    if (connection && externalUri) {
      // 外部实例上使用的是一次性测试库，删掉以免污染
      await connection.dropDatabase().catch(() => undefined);
    }
    await app?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    await connection.collection('materials').deleteMany({});
    await connection.collection('jobs').deleteMany({});
    await connection.collection('job_history_results').deleteMany({});
  });

  const materialInput = {
    name: 'nitrile-step',
    eInf: 3,
    branches: [
      { modulus: 4, tau: 0.1 },
      { modulus: 6, tau: 10 },
    ],
  };

  /** 0→100s 阶跃保持 ε=0.1、30000 点均匀网格。 */
  function bigStepSpec(name: string): StrainHistorySpec {
    return {
      name,
      segments: [{ type: 'linear', times: [0, 100], strains: [0.1, 0.1] }],
      output: { kind: 'uniform', start: 0, stop: 100, count: 30000 },
    };
  }

  async function waitForCompletion(jobId: string, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await jobService.getStatus(jobId);
      if (status.status === 'completed') {
        return jobService.getDetail(jobId);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`作业 ${jobId} 超时未完成`);
  }

  test(
    '10 条 × 每条 30000 点大作业：全部 succeeded，曲线完整且与单条提交逐点一致，文档不超 BSON 上限',
    async () => {
      await materialService.create(materialInput);

      const specs = Array.from({ length: 10 }, (_, i) => bigStepSpec(`step-${i + 1}`));
      const { jobId } = await jobService.submit({ materialName: 'nitrile-step', histories: specs });
      const detail = await waitForCompletion(jobId);

      // 1) 作业终态：completed、10/10
      expect(detail.status).toBe('completed');
      expect(detail.succeeded).toBe(10);
      expect(detail.failed).toBe(0);
      expect(detail.totalHistories).toBe(10);
      expect(detail.histories).toHaveLength(10);
      expect(detail.histories.every((h) => h.status === 'succeeded')).toBe(true);

      // 2) 每条四条曲线都完整取回
      for (let i = 0; i < 10; i++) {
        const h = detail.histories[i];
        expect(h.name).toBe(`step-${i + 1}`);
        expect(h.times).toHaveLength(30000);
        expect(h.strains).toHaveLength(30000);
        expect(h.stresses).toHaveLength(30000);
        expect(h.relaxationModulus).toHaveLength(30000);
        // 解析抽样：σ(0)=E0·ε0=1.3；t=100 时 σ=0.1·(3+4e⁻¹⁰⁰⁰+6e⁻¹⁰)≈0.300027；σ=E(t)·ε0
        expect(h.stresses[0]).toBeCloseTo(1.3, 10);
        const sigmaEnd = 0.1 * (3 + 4 * Math.exp(-1000) + 6 * Math.exp(-10));
        expect(h.stresses[30000 - 1]).toBeCloseTo(sigmaEnd, 10);
        for (const k of [0, 1, 15000, 29999]) {
          expect(h.stresses[k]).toBeCloseTo(0.1 * h.relaxationModulus[k], 1e-9);
        }
      }

      // 3) 与十条各自单独提交一次的结果逐点完全一致
      const singles = [];
      for (let i = 0; i < 10; i++) {
        const { jobId: singleId } = await jobService.submit({
          materialName: 'nitrile-step',
          histories: [bigStepSpec(`single-${i + 1}`)],
        });
        singles.push(await waitForCompletion(singleId));
      }
      for (let i = 0; i < 10; i++) {
        const batch = detail.histories[i];
        const single = singles[i].histories[0];
        expect(single.times).toHaveLength(30000);
        for (const arr of ['times', 'strains', 'stresses', 'relaxationModulus'] as const) {
          expect(batch[arr]).toEqual(single[arr]);
        }
      }

      // 4) 作业文档（不含曲线）与每条结果文档都严格小于 16MiB
      const rawJob = await connection.collection('jobs').findOne({ _id: new ObjectId(jobId) });
      const jobSize = BSON.calculateObjectSize(rawJob as object);
      expect(jobSize).toBeLessThan(16 * 1024 * 1024);
      const resultDocs = await connection
        .collection('job_history_results')
        .find({ jobId: new ObjectId(jobId) })
        .toArray();
      expect(resultDocs).toHaveLength(10);
      for (const r of resultDocs) {
        expect(BSON.calculateObjectSize(r)).toBeLessThan(16 * 1024 * 1024);
      }

      // 5) 进度路径不携带曲线；按材料检索能找到该作业
      const status = await jobService.getStatus(jobId);
      expect(status.status).toBe('completed');
      expect(JSON.stringify(status)).not.toMatch(/times|stresses/);
      const byMaterial = await jobService.findByMaterial('nitrile-step');
      expect(byMaterial.length).toBeGreaterThanOrEqual(11);
      expect(byMaterial[byMaterial.length - 1].id).toBe(jobId);
    },
    180000,
  );

  test(
    '结果写不进库：该历程 failed 并附原因，其余照常 succeeded，作业 completed',
    async () => {
      await materialService.create(materialInput);
      const smallSpec = (name: string): StrainHistorySpec => ({
        name,
        segments: [{ type: 'linear', times: [0, 10], strains: [0.1, 0.1] }],
        output: { kind: 'uniform', start: 0, stop: 10, count: 101 },
      });

      // 注入一次真实驱动层面的写失败（模拟 mongo 瞬态错误/连接中断），只作用一次
      let injected = false;
      const spy = jest
        .spyOn(resultModel, 'replaceOne')
        .mockImplementationOnce(() => {
          injected = true;
          return Promise.reject(new Error('MongoNetworkError: connection closed')) as never;
        });

      const { jobId } = await jobService.submit({
        materialName: 'nitrile-step',
        histories: [smallSpec('h1'), smallSpec('h2'), smallSpec('h3')],
      });
      const detail = await waitForCompletion(jobId);
      expect(injected).toBe(true);
      spy.mockRestore();

      expect(detail.status).toBe('completed');
      expect(detail.succeeded).toBe(2);
      expect(detail.failed).toBe(1);
      expect(detail.histories[0].status).toBe('failed');
      expect(detail.histories[0].errorCode).toBe('RESULT_PERSISTENCE_FAILED');
      expect(detail.histories[0].errorMessage).toMatch(/结果写入数据库失败/);
      expect(detail.histories[1].status).toBe('succeeded');
      expect(detail.histories[2].status).toBe('succeeded');
      // 失败行没有孤儿结果文档，成功行曲线完整
      const resultDocs = await connection
        .collection('job_history_results')
        .find({ jobId: new ObjectId(jobId) })
        .toArray();
      expect(resultDocs.map((d) => d.index).sort()).toEqual([1, 2]);
      expect(detail.histories[1].stresses).toHaveLength(101);

      // 恢复/续跑不应把 failed 行改判，也不重复计数
      await jobService.recoverStuckJobs();
      const again = await jobService.getDetail(jobId);
      expect(again.succeeded).toBe(2);
      expect(again.failed).toBe(1);
      expect(again.histories[0].status).toBe('failed');

      // 还原（防止影响后续用例）
      jest.restoreAllMocks();
    },
    60000,
  );

  test('执行时材料档已不存在：每条 pending 行 failed 附原因，作业 completed', async () => {
    const spec = {
      segments: [{ type: 'linear', times: [0, 10], strains: [0.1, 0.1] }],
      output: { kind: 'uniform', start: 0, stop: 10, count: 11 },
    };
    // 直接落一条 queued 作业（材料档从不存在），等价于“提交后、执行前材料被删”
    const { insertedId } = await connection.collection('jobs').insertOne({
      materialName: 'ghost-material',
      materialId: new ObjectId(),
      status: 'queued',
      totalHistories: 2,
      succeeded: 0,
      failed: 0,
      histories: [
        { index: 0, name: 'a', status: 'pending' },
        { index: 1, name: 'b', status: 'pending' },
      ],
      specs: [spec, spec],
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });
    const jobId = insertedId.toHexString();

    await jobService.recoverStuckJobs();
    const detail = await waitForCompletion(jobId);
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(0);
    expect(detail.failed).toBe(2);
    for (const h of detail.histories) {
      expect(h.status).toBe('failed');
      expect(h.errorCode).toBe('MATERIAL_NOT_FOUND');
      expect(h.errorMessage).toMatch(/材料档不存在/);
      expect(h.stresses).toEqual([]);
    }
    const n = await connection
      .collection('job_history_results')
      .countDocuments({ jobId: insertedId });
    expect(n).toBe(0);
  });

  test('升级前已完成的旧作业（曲线内嵌在 jobs 文档）：查进度/取曲线/按材料检索均可用', async () => {
    await materialService.create(materialInput);
    const matDoc = await connection
      .collection('materials')
      .findOne({ name: 'nitrile-step' });
    const now = new Date();
    // 手工构造旧版本文档：曲线内嵌、状态行没有 index 字段
    const legacyRow = (name: string, stress: number) => ({
      name,
      status: 'succeeded',
      times: [0, 1, 2],
      strains: [0.1, 0.1, 0.1],
      stresses: [stress, stress, stress],
      relaxationModulus: [stress / 0.1, stress / 0.1, stress / 0.1],
      dynamics: [],
      shiftFactor: 1,
    });
    const { insertedId } = await connection.collection('jobs').insertOne({
      materialName: 'nitrile-step',
      materialId: matDoc!._id,
      status: 'completed',
      totalHistories: 2,
      succeeded: 2,
      failed: 0,
      histories: [legacyRow('old-1', 1.2), legacyRow('old-2', 0.9)],
      specs: [],
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    const oldJobId = insertedId.toHexString();

    // 进度
    const status = await jobService.getStatus(oldJobId);
    expect(status.status).toBe('completed');
    expect(status.succeeded).toBe(2);
    expect(status.histories.map((h) => h.name)).toEqual(['old-1', 'old-2']);

    // 完整曲线（走旧字段兜底，结构不变）
    const detail = await jobService.getDetail(oldJobId);
    expect(detail.histories[0].stresses).toEqual([1.2, 1.2, 1.2]);
    expect(detail.histories[0].times).toEqual([0, 1, 2]);
    expect(detail.histories[1].relaxationModulus).toEqual([9, 9, 9]);

    // 按材料档检索
    const found = await jobService.findByMaterial('nitrile-step');
    expect(found.some((j) => j.id === oldJobId)).toBe(true);
  });

  test('升级前卡在 running 的旧作业：启动恢复把 pending 行续跑完，已有内嵌曲线不受影响', async () => {
    await materialService.create(materialInput);
    const matDoc = await connection
      .collection('materials')
      .findOne({ name: 'nitrile-step' });
    const now = new Date();
    const doneRows = Array.from({ length: 9 }, (_, i) => ({
      name: `old-step-${i + 1}`,
      status: 'succeeded',
      times: [0, 100],
      strains: [0.1, 0.1],
      stresses: [1.3, 0.31],
      relaxationModulus: [13, 3.1],
      dynamics: [],
      shiftFactor: 1,
    }));
    const { insertedId } = await connection.collection('jobs').insertOne({
      materialName: 'nitrile-step',
      materialId: matDoc!._id,
      status: 'running',
      totalHistories: 10,
      succeeded: 9,
      failed: 0,
      histories: [...doneRows, { name: 'old-step-10', status: 'pending' }],
      specs: Array.from({ length: 10 }, () => ({
        segments: [{ type: 'linear', times: [0, 100], strains: [0.1, 0.1] }],
        output: { kind: 'uniform', start: 0, stop: 100, count: 51 },
      })),
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    const stuckId = insertedId.toHexString();

    // 这正是周一看到的状态
    const before = await jobService.getStatus(stuckId);
    expect(before.status).toBe('running');
    expect(before.succeeded).toBe(9);
    expect(before.histories[9].status).toBe('pending');

    await jobService.recoverStuckJobs();
    const detail = await waitForCompletion(stuckId);
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(10);
    expect(detail.failed).toBe(0);
    expect(detail.histories.every((h) => h.status === 'succeeded')).toBe(true);

    // 旧的 9 条仍从内嵌字段读取，第 10 条来自新结果集合
    expect(detail.histories[0].stresses).toEqual([1.3, 0.31]);
    expect(detail.histories[8].stresses).toEqual([1.3, 0.31]);
    expect(detail.histories[9].stresses).toHaveLength(51);
    expect(detail.histories[9].stresses[0]).toBeCloseTo(1.3, 10);
    // t=100：τ=10 支路尚未完全松弛，σ=0.1·(3+4e^-1000+6e^-10)
    const sigma100 = 0.1 * (3 + 4 * Math.exp(-1000) + 6 * Math.exp(-10));
    expect(detail.histories[9].stresses[50]).toBeCloseTo(sigma100, 10);

    const resultDocs = await connection
      .collection('job_history_results')
      .find({ jobId: insertedId })
      .toArray();
    expect(resultDocs).toHaveLength(1);
    expect(resultDocs[0].index).toBe(9);
  });

  test('崩溃后留下的 running 新结构作业：恢复后续跑 pending 行并 completed', async () => {
    await materialService.create(materialInput);
    const { jobId } = await jobService.submit({
      materialName: 'nitrile-step',
      histories: [bigStepSpec('c1'), bigStepSpec('c2')],
    });
    // 模拟进程在执行途中被 kill：直接把作业钉回 running、两行重置 pending，
    // 并清掉可能已经写入的结果文档。
    await waitForCompletion(jobId);
    await connection
      .collection('job_history_results')
      .deleteMany({ jobId: new ObjectId(jobId) });
    await connection
      .collection('jobs')
      .updateOne(
        { _id: new ObjectId(jobId) },
        {
          $set: {
            status: 'running',
            succeeded: 0,
            failed: 0,
            'histories.$[].status': 'pending',
          },
        },
      );

    await jobService.recoverStuckJobs();
    const detail = await waitForCompletion(jobId);
    expect(detail.status).toBe('completed');
    expect(detail.succeeded).toBe(2);
    expect(detail.histories.every((h) => h.status === 'succeeded')).toBe(true);
    expect(detail.histories[0].stresses).toHaveLength(30000);
  }, 120000);
});
