# 粘弹核算服务（Prony / 广义 Maxwell）

密封件与减振橡胶 CAE 组的粘弹性后端作业服务。输入试验室给出的 **Prony 级数参数**
（平衡模量 E∞ 加若干支路 (E_i, τ_i)，可选 WLF 时温等效参数），对任意分段线性 +
正弦拼接的应变历程，在给定输出时间网格上计算应力 σ(t)，并输出松弛模量 E(t)
与正弦稳态储能/损耗模量。

- 框架：NestJS（TypeScript, Node.js 20）
- 数据库：MongoDB 7（Mongoose）
- 内核：每支路一个内变量，逐步递推，分段线性/正弦段一步精确积分；断点合并 O(n log n)，
  递推计算量随步数**线性**增长（3 万点历程的内核耗时为毫秒级）

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
| `src/job` | 作业异步调度、单条失败隔离、终态保证、崩溃恢复、进度、按材料检索 |
| `src/persistence` | Mongoose schema（materials / jobs / job_results） |
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
计算类失败沿用参数/历程校验错误码；**结果写不进库**（如单条曲线 BSON 超 16MB）
记 `RESULT_PERSISTENCE_FAILED`，其余历程照常出结果，作业一定落到终态（见第 6 节）。

---

## 5. 校验规则（均返回说明原因的错误）

- `τ_i ≤ 0`、`E_i < 0`、`E∞ < 0`
- 控制点时间不严格递增；拼接点应变间断；后续拼接段不连续
- 正弦频率 ≤ 0、周期数 ≤ 0；第一段不是线性段
- WLF 分母 `C2+T−Tref ≤ 0`
- 输出网格为空、不严格递增、超出历程时间范围
- 作业为空、引用不存在的材料档

错误响应统一为 `{statusCode, errorCode, message}`。

---

## 6. 结果存储与终态保证

### 故障复盘：十条 × 三万点的作业为什么卡在 running

两个叠加的根因：

1. **结果曲线全部内嵌在单个作业文档里。** BSON 把数组存成 `{"0":v,"1":v,…}`，
   每个元素除 8 字节 double 外还有键名开销（约 15B/个）。10 条 × 3 万点 × 4 条
   曲线 ≈ 17.5MB，超过 MongoDB 单文档 16MB 上限。第 9 条落库后文档约 15.8MB
   堪堪未超，第 10 条 `save` 被 MongoDB 拒绝（错误码 10334，BSONObj size）。
2. **执行器把"每条历程落库"写在 try/catch 之外。** 写库异常直接逃出执行循环，
   作业永远停在 `running`，第十条永远 `pending`，失败原因只出现在服务日志里，
   作业记录和历程行上什么都没留下。

### 选型：结果拆到独立集合 `job_results`，一条历程一个文档

- 作业文档（`jobs`）只留台账：状态、计数、每条历程的状态与错误原因（KB 级）。
- 曲线按 `(jobId, historyIndex)` 唯一键 upsert 到 `job_results`。3 万点 ≈ 1.8MB，
  离 16MB 上限有约 8 倍余量；上限从"整个作业共享一份"变成"单条历程独享一份"，
  作业包含多少条历程都不再触顶。
- 每条历程只有两次小写（结果文档 + 状态行定点更新）。原方案每算完一条就整体
  重写一次作业文档，10 条 × 3 万点的作业累计写放大约 90MB，且越写越慢。
- 读取：`GET /jobs/:id/detail` 按 jobId 一次取回全部结果文档并合并；
  进度查询与按材料检索只读小台账，比原来更快。

### 被放弃的路：曲线分块（chunks 集合 / GridFS 式）

- **本来能换来**：单条历程也不受 16MB 限制（输出点数无上限）；单文档大小有界；
  理论上可流式读写、边算边写。
- **要多付出**：读取要按序拼装 N 块（多次往返或聚合管道）；写入变成多文档操作，
  崩溃会留下半套块，需要版本号或清理任务保证一致性；失败/进度语义与块的生命
  周期耦合；schema、索引、测试都明显变复杂。
- **结论**：当前业务量（3 万点/条 ≈ 1.8MB，余量 8 倍）用不上这些好处。单条历程
  约 28 万个输出点才会触顶；真到那天，读取路径的合并逻辑已经把存储细节藏住，
  可以再演进到分块而调用方无感。
- 也评估过"继续内嵌 + 二进制打包/压缩"：只是把上限推得更晚（约 10 条 × 6 万点），
  没有消除上限，还让库里的数据不再是可直接查询的数值，排障更费劲。

### 终态保证：任何一步出错，作业都不会挂在 running

- 每条历程分**计算 / 落库**两阶段分别捕获：算错按参数/历程错误码记 `failed`；
  写不进库记 `RESULT_PERSISTENCE_FAILED`（HTTP 500）并尽力清理残留的结果文档；
  其余历程照常出结果。
- 每条历程先 upsert 结果文档、再翻状态行：`succeeded` 蕴含结果已落库。
- 执行器级异常（如排队期间材料档被删）：兜底把未完成的历程标 `failed` 附原因、
  计数归位、作业翻 `completed`（最多重试 3 次）。
- 进程崩溃/重启：启动时扫描，`queued`/`running` 的作业重新入队执行。内核是纯
  函数、结果文档 upsert 幂等，已 `succeeded` 的历程跳过不重算、不覆盖。
- 单条历程输出点数超过约 28 万时，该条会因单文档超限记 `RESULT_PERSISTENCE_FAILED`
  —— 失败被显式记录、其余历程不受影响，而不是无声挂起。

### 兼容性：调用方与既有数据都不用动

- API 路径与字段不变：`GET /jobs/:id`、`GET /jobs/:id/detail`、
  `GET /jobs?materialName=…` 的响应结构完全一致。
- 升级前命名卷里的老作业（曲线内嵌在 `jobs` 文档）**无需迁移**：`detail` 对每条
  succeeded 历程优先合并 `job_results`，没有结果文档时回退到内嵌曲线，原样返回。

---

## 7. 已测试的性质（Jest）

- 可手算的单支路阶跃算例：E∞=3、E1=7、τ=2、ε0=0.1，σ(0)=1、σ(2)=0.1(3+7/e)、σ→0.3
- σ(t)=E(t)·ε0；t≫τ 趋于 E∞·ε0
- 无支路退化为线弹性 σ=E∞·ε
- 应变叠加 ⇒ 应力叠加；时间平移不变；τ 与时间轴同乘 k 的时间缩放不变
- 单支路 t=τ 时支路贡献剩初值 e⁻¹
- 输出网格加密一倍，同一时刻应力变化 ≤ 容差
- 正弦稳态内核拟合的 E′/E″ 与解析 E′(ω)/E″(ω) 一致
- 升温 a_T<1、同历程松弛更快，且等价于 τ→a_T·τ
- 全部错误条件；作业异步执行、单条失败隔离、按材料档检索（内存 MongoDB 集成测试）
- 断点合并与朴素 O(n²) 参考实现逐点等价（固定边界用例 + 两万个随机用例差分）
- 以下均跑在真实 mongod 7.0.14 二进制上（mongodb-memory-server 启动官方服务器，
  与生产 mongo:7 同大版本，16MB 上限行为一致，非测试替身）：
  - 十条 × 三万点作业跑到 completed，四条曲线各 3 万点完整取回，
    且与同一条历程单独提交的结果逐元素精确一致；
  - 单条结果真实触发 16MB 超限 → 该条 failed + `RESULT_PERSISTENCE_FAILED` 附原因，
    其余历程照常出结果，作业落 completed，不留孤儿结果文档；
  - 执行器级异常（材料档不存在）→ 作业落终态，未完成历程标 failed 附原因；
  - 崩溃恢复：卡在 running 的作业重跑到 completed，已落库结果不被重算覆盖，
    全库无 queued/running 残留；
  - 升级前老格式作业（曲线内嵌、无结果文档）照常查进度、取曲线、按材料检索。
