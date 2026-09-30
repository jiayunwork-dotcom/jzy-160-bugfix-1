import {
  ResolvedHistory,
  ResolvedSegment,
  ResolvedSineSegment,
  sineStrain,
} from '../history/history.model';
import { StoredMaterial } from '../material/material.model';
import { wlfShiftFactor } from '../wlf/wlf.service';

/**
 * Prony 级数逐步递推内核（广义 Maxwell，松弛表示）。
 *
 * 松弛模量  E(t) = E∞ + Σ E_i exp(-t/τ_i)
 *
 * 引入应变型支路内变量 z_i（Boltzmann 遗传积分的离散形式）：
 *   z_i(t) = ∫₀^t exp(-(t-s)/τ_i) ε̇(s) ds,   即  ż_i + z_i/τ_i = ε̇
 *   σ(t)   = E∞·ε(t) + Σ E_i·z_i(t)
 *
 * 静止过去 ε=0 下初始 z_i=0；阶跃 ε0 在 t0 瞬时施加时 z_i(t0+)=ε0，
 * 保持段内 z_i 按 e^{-t/τ_i} 衰减，于是 σ=E(t)·ε0，长时趋于 E∞·ε0。
 *
 * 一步精确积分（只依赖上一步状态，计算量随步数线性增长）：
 * - 分段线性段 ε̇=r 为常数：
 *     z_i^{n+1} = f_i z_i^n + r·τ_i·(1 − f_i),  f_i = exp(−Δt/τ_i)
 * - 正弦段 ε(t)=b+A sin(ωt)，ε̇=Aω cos(ωt)：
 *     z_i^{n+1} = f_i z_i^n + ω( A cosθ0·Jc − A sinθ0·Js )
 *   Jc、Js 为 e^{−u/τ} 与 cos/sin 的一段定积分（闭合形式，见 sineAdvance）。
 */

export interface KernelInput {
  material: StoredMaterial;
  history: ResolvedHistory;
}

export interface KernelResult {
  times: number[];
  strains: number[];
  stresses: number[];
  /** 该历程（含温度平移）松弛模量 E(t) 在输出时刻的值 */
  relaxationModulus: number[];
  /** 本次计算使用的 WLF 平移因子（无 WLF/未指定温度时为 1） */
  shiftFactor: number;
}

const DEDUP_EPS = 1e-12;

export function runPronyKernel(input: KernelInput): KernelResult {
  const { material, history } = input;
  const { segments, outputTimes } = history;

  // 恒定温度下的平移因子与有效松弛时间 τ(T)=a_T·τ
  let shiftFactor = 1;
  if (history.temperature !== undefined && material.wlf) {
    shiftFactor = wlfShiftFactor(history.temperature, material.wlf);
  }
  const lambdas = material.branches.map((b) => b.tau * shiftFactor);
  const moduli = material.branches.map((b) => b.modulus);
  const nBranch = lambdas.length;

  // 合并所有段内控制点与输出时刻，得到严格递增的推进断点。
  const breakpoints = buildBreakpoints(history);

  // 初始时刻：静止过去 ε=0，z_i=0；首控制点应变视为瞬时施加（阶跃）。
  const t0 = breakpoints[0];
  const epsStart = strainAt(segments, t0);
  let z: number[] = new Array(nBranch).fill(epsStart);
  let tPrev = t0;
  let epsPrev = epsStart;

  const nOut = outputTimes.length;
  const stresses = new Array<number>(nOut);
  const strains = new Array<number>(nOut);
  const relaxation = new Array<number>(nOut);

  let nextOutput = 0;
  if (outputTimes[0] === t0) {
    strains[0] = epsStart;
    stresses[0] = material.eInf * epsStart + branchStress(moduli, z);
    relaxation[0] = relaxationAt(material.eInf, moduli, lambdas, 0);
    nextOutput = 1;
  }

  for (let k = 1; k < breakpoints.length; k++) {
    const tNext = breakpoints[k];
    const dt = tNext - tPrev;
    const epsNext = strainAt(segments, tNext);
    const seg = segmentAt(segments, tPrev, tNext);

    if (nBranch !== 0) {
      if (seg.type === 'sine') {
        z = sineAdvance(z, tPrev, tNext, dt, lambdas, seg);
      } else {
        z = linearAdvance(z, epsPrev, epsNext, dt, lambdas);
      }
    }

    tPrev = tNext;
    epsPrev = epsNext;

    // 收集恰好落在该断点上的输出（断点集合已包含全部输出时刻）。
    const tol = DEDUP_EPS * Math.max(1, Math.abs(tNext));
    while (nextOutput < nOut && outputTimes[nextOutput] <= tNext + tol) {
      strains[nextOutput] = epsNext;
      stresses[nextOutput] = material.eInf * epsNext + branchStress(moduli, z);
      relaxation[nextOutput] = relaxationAt(material.eInf, moduli, lambdas, tNext - t0);
      nextOutput++;
    }
  }

  return {
    times: outputTimes.slice(),
    strains,
    stresses,
    relaxationModulus: relaxation,
    shiftFactor,
  };
}

/** 分段线性段一步精确积分：ε̇=r 为常数，z' = f z + r τ (1−f)。 */
function linearAdvance(
  z: number[],
  eps0: number,
  eps1: number,
  dt: number,
  lambdas: number[],
): number[] {
  const result = new Array<number>(z.length);
  const rate = (eps1 - eps0) / dt;
  for (let i = 0; i < z.length; i++) {
    const f = Math.exp(-dt / lambdas[i]);
    result[i] = f * z[i] + rate * lambdas[i] * (1 - f);
  }
  return result;
}

/**
 * 正弦段一步精确积分。段内 ε=b+A sinθ，ε̇=Aω cosθ。
 * 解  z' = f z + Aω ∫₀^Δ e^{−a(Δ−u)} cos(θ0+ωu) du，令 v=Δ−u：
 *   z' = f z + ω( A cosθ1·Jc + A sinθ1·Js )
 * 其中 θ1 为步末相位，A sinθ1 = ε1−b，
 *   Jc = ∫₀^Δ e^{−av} cos(ωv) dv，Js = ∫₀^Δ e^{−av} sin(ωv) dv。
 */
function sineAdvance(
  z: number[],
  t0: number,
  t1: number,
  dt: number,
  lambdas: number[],
  seg: ResolvedSineSegment,
): number[] {
  const result = new Array<number>(z.length);
  const omega = 2 * Math.PI * seg.frequency;
  const preload = seg.preload ?? 0;
  const theta1 = 2 * Math.PI * seg.frequency * (t1 - seg.t0);
  const aSin1 = seg.amplitude * Math.sin(theta1); // = ε1−b（按解析相位取值）
  const aCos1 = seg.amplitude * Math.cos(theta1);
  const theta = omega * dt;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);

  for (let i = 0; i < z.length; i++) {
    const a = 1 / lambdas[i];
    const f = Math.exp(-a * dt);
    const denom = a * a + omega * omega;
    const oneMinusFCos = 1 - f * cosTheta;
    const fSin = f * sinTheta;
    const jc = (a * oneMinusFCos + omega * fSin) / denom;
    const js = (omega * oneMinusFCos - a * fSin) / denom;
    result[i] = f * z[i] + omega * (aCos1 * jc + aSin1 * js);
  }
  return result;
}

function branchStress(moduli: number[], z: number[]): number {
  let s = 0;
  for (let i = 0; i < z.length; i++) s += moduli[i] * z[i];
  return s;
}

function relaxationAt(
  eInf: number,
  moduli: number[],
  lambdas: number[],
  t: number,
): number {
  let e = eInf;
  for (let i = 0; i < moduli.length; i++) {
    e += moduli[i] * Math.exp(-t / lambdas[i]);
  }
  return e;
}

/** 合并控制点与输出时刻（去重、严格递增）。 */
function buildBreakpoints(history: ResolvedHistory): number[] {
  const points: number[] = [];
  const add = (t: number): void => {
    const tol = DEDUP_EPS * Math.max(1, Math.abs(t));
    for (const existing of points) {
      if (Math.abs(existing - t) <= tol) return;
    }
    points.push(t);
  };
  for (const seg of history.segments) {
    if (seg.type === 'linear') {
      for (const t of seg.times) add(t);
    } else {
      add(seg.t0);
      add(seg.t0 + seg.duration);
    }
  }
  for (const t of history.outputTimes) add(t);
  return points.sort((a, b) => a - b);
}

/** 定位覆盖区间 [t0,t1] 的段；断点取自段边界与输出点，区间整体落在唯一段内。 */
function segmentAt(segments: ResolvedSegment[], t0: number, t1: number): ResolvedSegment {
  for (const seg of segments) {
    if (seg.type === 'linear') {
      const start = seg.times[0];
      const end = seg.times[seg.times.length - 1];
      if (t0 >= start - DEDUP_EPS && t1 <= end + DEDUP_EPS) return seg;
    } else if (t0 >= seg.t0 - DEDUP_EPS && t1 <= seg.t0 + seg.duration + DEDUP_EPS) {
      return seg;
    }
  }
  throw new Error(`内核无法定位时间区间 [${t0}, ${t1}] 所在的历程段`);
}

function strainAt(segments: ResolvedSegment[], t: number): number {
  for (const seg of segments) {
    if (seg.type === 'linear') {
      const last = seg.times.length - 1;
      if (t >= seg.times[0] - DEDUP_EPS && t <= seg.times[last] + DEDUP_EPS) {
        return interpolateLinear(seg.times, seg.strains, t);
      }
    } else if (t >= seg.t0 - DEDUP_EPS && t <= seg.t0 + seg.duration + DEDUP_EPS) {
      return sineStrain(seg, t);
    }
  }
  throw new Error(`内核无法取得时刻 ${t} 的应变`);
}

function interpolateLinear(times: number[], strains: number[], t: number): number {
  if (t <= times[0]) return strains[0];
  let lo = 0;
  let hi = times.length - 1;
  if (t >= times[hi]) return strains[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const frac = span === 0 ? 0 : (t - times[lo]) / span;
  return strains[lo] + frac * (strains[hi] - strains[lo]);
}
