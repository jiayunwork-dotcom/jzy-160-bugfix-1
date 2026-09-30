import { ViscoError } from '../common/errors';

/**
 * 应变历程模型。
 *
 * 一条历程按时间顺序由若干“段 (segment)”拼接而成：
 * - linear：时间-应变分段线性控制点（斜坡、阶跃保持都用它表达）；
 * - sine：正弦往复段，ε(t) = preload + amplitude·sin(2πf·(t − t0))，
 *   段起点取值为 preload（sin 0 = 0），因此与前段末点连续。
 *
 * 阶跃压缩的表达：linear 段用两个时间点（t0,ε0)→(t0,ε0）或直接第一控制点
 * 位于 t0、应变非零，内核把首个控制点之前视为静止过去（ε=0），
 * 在 t0 瞬时施加该应变（见 prony 内核初始化）。
 */
export type StrainSegment = LinearSegment | SineSegment;

export interface LinearSegment {
  type: 'linear';
  /** 控制点时间，必须在本段内严格递增 */
  times: number[];
  /** 控制点应变，与 times 等长 */
  strains: number[];
}

export interface SineSegment {
  type: 'sine';
  /** 正弦幅值 A（峰偏） */
  amplitude: number;
  /** 频率 f（Hz，> 0），角频率 ω = 2πf */
  frequency: number;
  /** 周期数（> 0），段时长 = cycles / frequency */
  cycles: number;
  /** 静态预应变（默认 0），段起点应变取该值以保证拼接连续 */
  preload?: number;
}

export interface StrainHistorySpec {
  name?: string;
  segments: StrainSegment[];
  /** 恒定温度；材料档带 WLF 参数时用于平移松弛时间 */
  temperature?: number;
  /** 输出时间网格：显式网格或均匀网格二选一 */
  output: OutputGrid;
}

export type OutputGrid =
  | { kind: 'points'; times: number[] }
  | { kind: 'uniform'; start: number; stop: number; count: number };

/** 解析后的正弦段（时长与起止时间已算出）。 */
export interface ResolvedSineSegment extends SineSegment {
  t0: number;
  duration: number;
}

/** 解析后的线性段（首段/后续段统一带时间坐标）。 */
export interface ResolvedLinearSegment {
  type: 'linear';
  times: number[];
  strains: number[];
}

export type ResolvedSegment = ResolvedLinearSegment | ResolvedSineSegment;

export interface ResolvedHistory {
  name?: string;
  segments: ResolvedSegment[];
  tStart: number;
  tEnd: number;
  temperature?: number;
  outputTimes: number[];
}

function isFiniteArray(xs: number[]): boolean {
  return xs.every(Number.isFinite);
}

/** 校验并解析一条历程：拼接各段、生成输出时间网格（纯函数）。 */
export function resolveHistory(history: StrainHistorySpec): ResolvedHistory {
  if (!Array.isArray(history.segments) || history.segments.length === 0) {
    throw new ViscoError('NO_SEGMENTS', '历程至少要包含一个加载段');
  }

  const segments: ResolvedSegment[] = [];
  let cursor = 0;
  let initialized = false;

  for (const [segIndex, seg] of history.segments.entries()) {
    if (seg.type === 'linear') {
      if (
        !seg ||
        !Array.isArray(seg.times) ||
        !Array.isArray(seg.strains) ||
        seg.times.length !== seg.strains.length
      ) {
        throw new ViscoError(
          'INVALID_PAYLOAD',
          `第 ${segIndex + 1} 段：times 与 strains 必须等长`,
        );
      }
      if (seg.times.length < 2) {
        throw new ViscoError(
          'INVALID_PAYLOAD',
          `第 ${segIndex + 1} 段：分段线性段至少需要 2 个控制点`,
        );
      }
      if (!isFiniteArray(seg.times) || !isFiniteArray(seg.strains)) {
        throw new TypeError(`第 ${segIndex + 1} 段：时间与应变必须是有限数值`);
      }
      for (let k = 1; k < seg.times.length; k++) {
        if (!(seg.times[k] > seg.times[k - 1])) {
          throw new ViscoError(
            'TIME_NOT_STRICTLY_INCREASING',
            `第 ${segIndex + 1} 段：控制点时间必须严格递增（位置 ${k}：${seg.times[k - 1]} → ${seg.times[k]}）`,
          );
        }
      }

      let times: number[];
      let strains: number[];
      if (!initialized) {
        // 首段允许使用绝对时间坐标（例如 (1,0)→(2,0.1)）。
        times = seg.times.slice();
        strains = seg.strains.slice();
        initialized = true;
      } else {
        // 后续段以前段末点为 t0 拼接；首点可与前段末点重合（同一拼接点）。
        const t0 = seg.times[0];
        if (t0 !== 0) {
          throw new ViscoError(
            'SEGMENT_GAP_OR_OVERLAP',
            `第 ${segIndex + 1} 段：后续拼接段必须从相对时间 0 开始（收到 ${t0}）`,
          );
        }
        const offset = cursor;
        times = seg.times.map((t) => t + offset);
        strains = seg.strains.slice();
        // 去掉与前段末点重复的拼接点（应变必须一致）。
        if (times[0] === cursor) {
          if (strains[0] !== segmentEndStrain(segments[segments.length - 1])) {
            throw new ViscoError(
              'SEGMENT_GAP_OR_OVERLAP',
              `第 ${segIndex + 1} 段：拼接点应变与前段末点不一致，历程出现间断`,
            );
          }
          times = times.slice(1);
          strains = strains.slice(1);
        }
        if (times.some((t) => t <= cursor)) {
          throw new ViscoError(
            'SEGMENT_GAP_OR_OVERLAP',
            `第 ${segIndex + 1} 段：时间必须在前段之后连续推进`,
          );
        }
      }
      const resolved: ResolvedLinearSegment = { type: 'linear', times, strains };
      segments.push(resolved);
      cursor = times[times.length - 1];
    } else if (seg.type === 'sine') {
      // 第一段必须是 linear：正弦段起点应变取 preload，需要由线性段给出静止过去与初始时刻。
      if (!initialized) {
        throw new ViscoError(
          'FIRST_SEGMENT_NOT_LINEAR',
          '历程的第一个段必须是分段线性段（正弦段需拼接在线性段之后）',
        );
      }
      if (!Number.isFinite(seg.amplitude)) {
        throw new TypeError('正弦段幅值必须是有限数值');
      }
      if (!(seg.frequency > 0)) {
        throw new ViscoError(
          'SINE_FREQUENCY_NONPOSITIVE',
          `正弦频率必须为正，收到 ${seg.frequency}`,
        );
      }
      if (!(seg.cycles > 0)) {
        throw new ViscoError(
          'SINE_CYCLES_NONPOSITIVE',
          `正弦周期数必须为正，收到 ${seg.cycles}`,
        );
      }
      const preload = seg.preload ?? 0;
      if (!Number.isFinite(preload)) {
        throw new TypeError('正弦段预应变必须是有限数值');
      }
      if (preload !== segmentEndStrain(segments[segments.length - 1])) {
        throw new ViscoError(
          'SEGMENT_GAP_OR_OVERLAP',
          `正弦段起点应变（preload=${preload}）与前段末点不一致，拼接不连续`,
        );
      }
      const duration = seg.cycles / seg.frequency;
      const resolved: ResolvedSineSegment = {
        ...seg,
        preload,
        t0: cursor,
        duration,
      };
      segments.push(resolved);
      cursor += duration;
    } else {
      throw new ViscoError('INVALID_PAYLOAD', `未知的历程段类型: ${String((seg as { type?: unknown })?.type)}`);
    }
  }

  const tStart = segmentStartTime(segments[0]);
  const tEnd = cursor;
  const outputTimes = resolveOutputGrid(history.output, tStart, tEnd);

  return { name: history.name, segments, tStart, tEnd, temperature: history.temperature, outputTimes };
}

function segmentStartTime(seg: ResolvedSegment): number {
  return seg.type === 'linear' ? seg.times[0] : seg.t0;
}

/** 段的末点应变（正弦段末点 sin(2π·cycles)=0，即 preload）。 */
function segmentEndStrain(seg: ResolvedSegment): number {
  if (seg.type === 'linear') {
    return seg.strains[seg.strains.length - 1];
  }
  return seg.preload ?? 0;
}

/** 正弦段在时刻 t 的应变，t 为全局绝对时间。 */
export function sineStrain(seg: ResolvedSineSegment, t: number): number {
  const phase = 2 * Math.PI * seg.frequency * (t - seg.t0);
  return (seg.preload ?? 0) + seg.amplitude * Math.sin(phase);
}

function resolveOutputGrid(grid: OutputGrid, tStart: number, tEnd: number): number[] {
  if (!grid || typeof grid !== 'object') {
    throw new ViscoError('INVALID_PAYLOAD', '必须指定输出时间网格 output');
  }
  let times: number[];
  if (grid.kind === 'points') {
    if (!Array.isArray(grid.times) || grid.times.length === 0) {
      throw new ViscoError('OUTPUT_GRID_EMPTY', '输出时间网格不能为空');
    }
    if (!isFiniteArray(grid.times)) {
      throw new TypeError('输出时间必须是有限数值');
    }
    times = grid.times.slice();
  } else if (grid.kind === 'uniform') {
    if (![grid.start, grid.stop, grid.count].every(Number.isFinite)) {
      throw new TypeError('均匀网格的 start/stop/count 必须是有限数值');
    }
    if (!Number.isInteger(grid.count) || grid.count < 1) {
      throw new ViscoError('OUTPUT_GRID_EMPTY', '均匀网格 count 必须是不小于 1 的整数');
    }
    if (!(grid.stop > grid.start)) {
      throw new ViscoError(
        'OUTPUT_GRID_NOT_INCREASING',
        `均匀网格要求 stop > start（${grid.start} → ${grid.stop}）`,
      );
    }
    times =
      grid.count === 1
        ? [grid.start]
        : Array.from({ length: grid.count }, (_, i) => grid.start + (grid.stop - grid.start) * (i / (grid.count - 1)));
  } else {
    throw new ViscoError('INVALID_PAYLOAD', `未知的输出网格类型: ${String((grid as { kind?: unknown })?.kind)}`);
  }

  for (let k = 1; k < times.length; k++) {
    if (!(times[k] > times[k - 1])) {
      throw new ViscoError(
        'OUTPUT_GRID_NOT_INCREASING',
        `输出时间网格必须严格递增（位置 ${k}：${times[k - 1]} → ${times[k]}）`,
      );
    }
  }
  const eps = 1e-9 * Math.max(1, Math.abs(tStart), Math.abs(tEnd));
  if (times[0] < tStart - eps || times[times.length - 1] > tEnd + eps) {
    throw new ViscoError(
      'OUTPUT_GRID_OUT_OF_RANGE',
      `输出网格 [${times[0]}, ${times[times.length - 1]}] 超出历程时间范围 [${tStart}, ${tEnd}]`,
    );
  }
  return times;
}
