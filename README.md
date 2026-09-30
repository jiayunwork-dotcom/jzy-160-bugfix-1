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
| `src/job` | 作业异步调度、单条失败隔离、进度、按材料检索 |
| `src/persistence` | Mongoose schema（materials / jobs） |
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

## 5. 校验规则（均返回说明原因的错误）

- `τ_i ≤ 0`、`E_i < 0`、`E∞ < 0`
- 控制点时间不严格递增；拼接点应变间断；后续拼接段不连续
- 正弦频率 ≤ 0、周期数 ≤ 0；第一段不是线性段
- WLF 分母 `C2+T−Tref ≤ 0`
- 输出网格为空、不严格递增、超出历程时间范围
- 作业为空、引用不存在的材料档

错误响应统一为 `{statusCode, errorCode, message}`。

---

## 6. 已测试的性质（Jest）

- 可手算的单支路阶跃算例：E∞=3、E1=7、τ=2、ε0=0.1，σ(0)=1、σ(2)=0.1(3+7/e)、σ→0.3
- σ(t)=E(t)·ε0；t≫τ 趋于 E∞·ε0
- 无支路退化为线弹性 σ=E∞·ε
- 应变叠加 ⇒ 应力叠加；时间平移不变；τ 与时间轴同乘 k 的时间缩放不变
- 单支路 t=τ 时支路贡献剩初值 e⁻¹
- 输出网格加密一倍，同一时刻应力变化 ≤ 容差
- 正弦稳态内核拟合的 E′/E″ 与解析 E′(ω)/E″(ω) 一致
- 升温 a_T<1、同历程松弛更快，且等价于 τ→a_T·τ
- 全部错误条件；作业异步执行、单条失败隔离、按材料档检索（内存 MongoDB 集成测试）
