import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ViscoModule } from '../visco.module';
import { ViscoExceptionFilter } from './visco-exception.filter';

/**
 * 端到端冒烟：真实 HTTP 监听 → ValidationPipe → 控制器 → 服务 → Mongoose。
 * 覆盖建档回显 E0、提交异步作业、轮询拿到 σ(t)、校验失败的统一错误结构。
 */
describe('HTTP 端到端（内存 MongoDB）', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: {
        version: '7.0.14',
        os: { os: 'linux', dist: 'ubuntu', release: '22.04' },
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(mongod.getUri()), ViscoModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new ViscoExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  test('建档 → 提交阶跃作业 → 轮询完成，σ(0)=E0·ε0，错误响应结构正确', async () => {
    // 1) 建档
    const create = await fetch(`${baseUrl}/materials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'nitrile',
        eInf: 3,
        branches: [{ modulus: 7, tau: 2 }],
      }),
    });
    expect(create.status).toBe(201);
    const material = await create.json();
    expect(material.e0).toBe(10);

    // 2) 提交异步作业
    const submit = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        materialName: 'nitrile',
        histories: [
          {
            name: '阶跃',
            segments: [{ type: 'linear', times: [0, 10], strains: [0.1, 0.1] }],
            output: { kind: 'uniform', start: 0, stop: 10, count: 11 },
          },
        ],
      }),
    });
    expect(submit.status).toBe(201);
    const { jobId } = await submit.json();
    expect(jobId).toBeTruthy();

    // 3) 轮询进度直到完成
    let detail: any;
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${baseUrl}/jobs/${jobId}/detail`);
      detail = await res.json();
      if (detail.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(detail.status).toBe('completed');
    expect(detail.histories[0].status).toBe('succeeded');
    expect(detail.histories[0].stresses[0]).toBeCloseTo(1, 10);
    expect(detail.histories[0].stresses[5]).toBeCloseTo(
      0.1 * (3 + 7 * Math.exp(-5 / 2)),
      10,
    );

    // 4) 按材料档检索
    const list = await (await fetch(`${baseUrl}/jobs?materialName=nitrile`)).json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
  });

  test('领域错误：τ≤0 经 HTTP 返回 422 + errorCode', async () => {
    const res = await fetch(`${baseUrl}/materials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', eInf: 1, branches: [{ modulus: 2, tau: -1 }] }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe('BRANCH_TAU_NONPOSITIVE');
    expect(body.message).toMatch(/松弛时间/);
  });

  test('引用不存在材料档 → 404；查询不存在作业 → 404', async () => {
    const submit = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        materialName: 'ghost',
        histories: [
          {
            segments: [{ type: 'linear', times: [0, 1], strains: [0, 1] }],
            output: { kind: 'uniform', start: 0, stop: 1, count: 2 },
          },
        ],
      }),
    });
    expect(submit.status).toBe(404);
    expect((await submit.json()).errorCode).toBe('MATERIAL_NOT_FOUND');

    const getJob = await fetch(`${baseUrl}/jobs/0123456789abcdef01234567`);
    expect(getJob.status).toBe(404);
  });

  test('请求体校验：缺字段被 ValidationPipe 拦截为 400', async () => {
    const res = await fetch(`${baseUrl}/materials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', eInf: 1 }), // 缺 branches
    });
    expect(res.status).toBe(400);
  });
});
