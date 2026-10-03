# 粘弹核算服务（Prony / 广义 Maxwell）

密封件与减振橡胶 CAE 组的粘弹性后端作业服务。输入试验室给出的 **Prony 级数参数**
（平衡模量 E∞ 加若干支路 (E_i, τ_i)，可选 WLF 时温等效参数），对任意分段线性 +
正弦拼接的应变历程，在给定输出时间网格上计算应力 σ(t)，并输出松弛模量 E(t)
与正弦稳态储能/损耗模量。

- 框架：NestJS（TypeScript, Node.js 20）
- 数据库：MongoDB 7（Mongoose）
- 内核：每支路一个内变量，逐步递推，分段线性/正弦段一步精确积分，计算量随步数**线性**增长

---

## 1. 本构与内核

松弛模量

```
E(t) = E∞ + Σ_i E_i exp(−t/τ_i),        E0 = E∞ + Σ_i E_i
```

引入应变型支路内变量

```
ż_i + z_i/τ_i = ε̇,        σ(t) = E∞·ε(t) + Σ_i E_i z_i(t)
```

- 静止过去 ε=0，阶跃 ε0 在 t₀ 瞬时施加：z_i(t₀+)=ε0，保持段 z_i=ε0·e^{−t/τ_i}，
  因此 **σ(t)=E(t)·ε0**，t≫max τ 时趋于 **E∞·ε0**。
- 分段线性段（ε̇=r 为常数）一步精确积分：
  `z_i^{n+1} = f_i z_i^n + r·τ_i·(1−f_i)`，`f_i=e^{−Δt/τ_i}`，只依赖上一步。
- 正弦段 ε=b+A sin ωt 给出闭合形式一步积分（见 `src/prony/prony-kernel.service.ts`）。
- 不做全历史卷积求和，长历程单遍推进；输出时刻与控制点合并为统一断点。

### 动态模量（解析）

```
E′(ω) = E∞ + Σ E_i (ωτ_i)²/(1+(ωτ_i)²)
E″(ω) =      Σ E_i  ωτ_i  /(1+(ωτ_i)²)
tan δ  = E″/E′
```

### WLF 时温等效

```
log10 a_T = −C1 (T−Tref) / (C2 + T−Tref),        τ(T) = a_T·τ
```

T>Tref（C1,C2>0）时 a_T<1，松弛更快；C2+T−Tref≤0 返回错误。

---

## 2. 模块划分

| 目录 | 职责 |
|---|---|
| `src/material` | 材料档域模型、校验（E∞、E_i、τ_i）、E0 回显、材料服务 |
| `src/history` | 历程解析：分段线性控制点 + 正弦段拼接、输出网格、全部历程校验 |
| `src/prony` | Prony 递推内核（**不依赖控制器/数据库**） |
| `src/dynamic` | E′/E″/tanδ 解析动态模量 |
| `src/wlf` | WLF 平移因子 |
| `src/job` | 作业异步调度、单条失败隔离、进度、按材料检索、终态兜底与崩溃恢复 |
| `src/persistence` | Mongoose schema（materials / jobs / job_history_results） |
| `src/http` | DTO、控制器、异常过滤器 |

---

## 3. 快速开始

### Docker Compose（app + mongo:7，命名卷）

```bash
docker compose up --build
# 应用 http://localhost:3000 ，mongo 端口 27017，数据卷 visco-cae-mongo-data
```

### 本地开发

```bash
npm ci
npm run test          # Jest 单元 + 内存 MongoDB 集成测试
npm run start:dev     # 需要本机/ compose 的 mongo（见 .env.example）
```

---

## 4. HTTP API

### 材料档

```bash
curl -X POST http://localhost:3000/materials \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "nitrile-70",
    "description": "丁腈胶 70 邵氏",
    "eInf": 3.0,
    "branches": [
      {"modulus": 4.0, "tau": 0.1},
      {"modulus": 6.0, "tau": 10.0}
    ],
    "wlf": {"tRef": 20, "c1": 17.44, "c2": 51.6}
  }'
# 响应回显 "e0": 13.0
```

`GET /materials`、`GET /materials/:name`。

### 提交作业（异步，返回作业号）

```bash
curl -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "materialName": "nitrile-70",
    "histories": [
      {
        "name": "阶跃压缩后保持",
        "segments": [
          {"type": "linear", "times": [0, 100], "strains": [0.1, 0.1]}
        ],
        "temperature": 20,
        "output": {"kind": "uniform", "start": 0, "stop": 100, "count": 1001}
      },
      {
        "name": "斜坡 + 正弦往复",
        "segments": [
          {"type": "linear", "times": [0, 1], "strains": [0, 0.05]},
          {"type": "sine", "amplitude": 0.02, "frequency": 2, "cycles": 20, "preload": 0.05}
        ],
        "output": {"kind": "uniform", "start": 0, "stop": 11, "count": 2201}
      }
    ]
  }'
# {"jobId": "65f..."}
```

输出网格也可给显式时刻：`{"kind":"points","times":[0,1,2,5]}`。

### 查询进度 / 取结果 / 按材料检索

```bash
GET /jobs/:id            # 进度与每条历程状态（失败附 errorCode/errorMessage）
GET /jobs/:id/detail     # 完整结果：times/strains/stresses/relaxationModulus/dynamics
GET /jobs?materialName=nitrile-70
```

单条历程失败不影响其余：失败行 `status:"failed"` 并带 `errorCode`、`errorMessage`。

---

## 5. 结果存储设计：曲线为什么拆到独立集合

### 问题：一个作业文档被多条大曲线撑过 16MiB

旧实现把每条历程的 `times / strains / stresses / relaxationModulus / dynamics`
全部内嵌在 `jobs` 文档的 `histories` 数组里，执行器每算完一条就 `job.save()`。
`save()` 序列化的是**整个文档**，于是体积随“历程数 × 每条点数”线性累积：

- 一条 30000 点阶跃保持约 1MB（四条 double 数组）；
- 十条 × 30000 点的作业文档约 **16.7MiB，超过 MongoDB 单文档 16MiB 上限**；
- 前九条保存都成功（约 15.1MiB），**保存第十条时驱动抛 BSON 大小异常**。

而旧代码里 `job.save()` 在单条 try/catch **之外**，异常直接逃出执行循环，
提交侧只打了条日志：作业既没有落 `completed`，第十条也没被标 `failed`，
于是永远挂在 `running`（9 succeeded / 1 pending / 0 failed），与现场现象一致。

### 选定方案：每条历程一个结果文档（集合 `job_history_results`）

- `jobs` 文档只保留**状态行**：`index / name / status / errorCode / errorMessage`
  和小体积的原始 `specs`，任何作业的主文档都很小；
- 每条历程的曲线写入 `job_history_results` 的**独立文档**
  （字段 `jobId, index, times, strains, stresses, relaxationModulus, dynamics, shiftFactor`，
  `(jobId, index)` 唯一索引）。**单文档体积只取决于一条历程的点数，与作业总条数无关**，
  30000 点约 1MB，离 16MiB 很远；
- 执行器不再 `save()` 整文档，而是用**字段级原子更新**推进：
  结果文档 `replaceOne(..., {upsert:true})`，状态行用聚合管道 `$map` 按 `index`
  只改这一行，并对 `succeeded/failed` 做 `$inc`。更新负载与曲线大小无关，
  因此即使读到升级前那种大文档，状态也能照常更新。
- 读取时 `GET /jobs/:id/detail` 按 `(jobId, index)` 把结果文档**合并回状态行**，
  返回的字段、顺序、路径与旧版完全一致（见下“向后兼容”）；
  `GET /jobs/:id` 的进度与 `GET /jobs?materialName=` 的检索只碰小的主文档。

**这样选换来的好处**：写入不再随作业规模累积、单条结果隔离（一条写失败不牵连其他）、
进度/检索查询更轻；代价是取详情要多一次按索引的查询（极廉价）、数据跨两个集合，
以及需要一层读取合并。

### 被放弃的方案：在作业文档内“分块写”曲线（仍留在 jobs 集合）

即把每条曲线切成若干 <16MB 的块，分散到 jobs 文档的多个字段/嵌套块里，
或用 `$push` 分批追加，避免一次性 `save()` 超上限。

- 它本来能换来：不新增集合、所有数据仍在一个文档里、读取无需跨集合合并。
- 但要多付出：
  - **治标不治本**——切块只能抬高单个作业的容量上限，
    “历程数 × 点数”继续增长（更多条、几万点）时，块管理会反复逼近上限，
    需要持续调参块大小；
  - 读取必须把块重新拼接，且要处理半写入/块序号空洞，**逻辑更脆**；
  - 每次进度更新都在同一个巨大文档上做数组追加，写放大严重，
    且仍要绕开 Mongoose 整文档校验/版本号，维护成本高；
  - 与“单条失败隔离”的模型不匹配——一条坏数据和其余成功数据挤在同一 BSON 里。

也考虑过 **GridFS**：它专为远超 16MB 的大文件设计，但这里单条结果只有 MB 级，
GridFS 的多分块/元数据模型反而过重，且无法对曲线做结构化查询与按行合并。
因此最终采用“每历程一文档”，在隔离性、可扩展性与实现复杂度之间最均衡。

### 终态保证：任何一步失败都不再挂 running

- 计算失败（参数/历程错误、内核异常）只标记该历程 `failed` 并写原因，其余继续；
- **结果写库失败**同样把该历程标为 `failed`（`errorCode=RESULT_PERSISTENCE_FAILED`，
  message 含底层错误），删除可能残留的孤儿结果文档，其余历程照常出结果；
- 执行循环之外的致命异常（作业/材料读不出等）会尽力把仍 `pending` 的行
  全部终态化（`JOB_EXECUTION_FAILED`），最后无条件把作业收尾到 `completed`，
  并以各行实际状态重算 `succeeded/failed`；
- 仅当收尾时数据库本身不可用才会暂时停在 `running`，**重连/重启后自动续跑**（见下）。

### 崩溃恢复与升级兼容

- 服务启动及 MongoDB（重）连接时扫描所有 `queued/running` 作业，重新驱动执行；
  执行是**幂等可续跑**的：已 `succeeded/failed` 的行跳过，只补 `pending` 行，
  因此进程被 kill、升级重启、周一那种卡住的作业都会跑到终态。
- **命名卷里升级前的旧作业无需迁移**：旧 `jobs` 文档的状态行没有 `index`、
  曲线还内嵌在行里。读取侧对旧行按数组位置补 `index`；已完成的旧作业
  直接从内嵌字段回显曲线；卡在 `running` 的旧作业续跑时，新算出的行写入
  `job_history_results`，旧行继续读内嵌字段。进度查询、取完整结果、
  按材料检索三条路径与字段均保持原样，调用方无需改动。

---

## 6. 校验规则（均返回说明原因的错误）

- `τ_i ≤ 0`、`E_i < 0`、`E∞ < 0`
- 控制点时间不严格递增；拼接点应变间断；后续拼接段不连续
- 正弦频率 ≤ 0、周期数 ≤ 0；第一段不是线性段
- WLF 分母 `C2+T−Tref ≤ 0`
- 输出网格为空、不严格递增、超出历程时间范围
- 作业为空、引用不存在的材料档

错误响应统一为 `{statusCode, errorCode, message}`。

---

## 7. 已测试的性质（Jest）

- 可手算的单支路阶跃算例：E∞=3、E1=7、τ=2、ε0=0.1，σ(0)=1、σ(2)=0.1(3+7/e)、σ→0.3
- σ(t)=E(t)·ε0；t≫τ 趋于 E∞·ε0
- 无支路退化为线弹性 σ=E∞·ε
- 应变叠加 ⇒ 应力叠加；时间平移不变；τ 与时间轴同乘 k 的时间缩放不变
- 单支路 t=τ 时支路贡献剩初值 e⁻¹
- 输出网格加密一倍，同一时刻应力变化 ≤ 容差
- **30000 点大网格秒级完成**：断点合并为 O(n log n)（旧 O(n²) 去重在 3 万点下需数十秒），数值不变
- 正弦稳态内核拟合的 E′/E″ 与解析 E′(ω)/E″(ω) 一致
- 升温 a_T<1、同历程松弛更快，且等价于 τ→a_T·τ
- 全部错误条件；作业异步执行、单条失败隔离、按材料档检索（内存 MongoDB 集成测试）
- **真实 MongoDB 验收**（`npm run test:real-mongo`，默认用 mongodb-memory-server
  起的真实 mongod 7.0.14，非测试替身；也可用
  `TEST_MONGO_URI=mongodb://host:27017 npm run test:real-mongo` 指向独立实例）：
  - 10 条 × 每条 30000 点作业跑到 `completed`、十条全 `succeeded`，
    时间/应变/应力/松弛模量完整取回，与每条单独提交的结果**逐点完全一致**，
    且作业文档与每条结果文档都不超过 16MiB；
  - 结果写库被注入失败时，该历程 `failed` 附 `RESULT_PERSISTENCE_FAILED` 与原因，
    其余照常 `succeeded`，作业 `completed`，恢复扫描不翻案、不重复计数；
  - 升级前已完成的旧作业（曲线内嵌）仍可查进度/取曲线/按材料检索；
  - 升级前卡在 `running` 的旧作业、以及崩溃留下的新结构 `running` 作业，
    经启动恢复续跑到 `completed`，旧内嵌曲线不受影响。
