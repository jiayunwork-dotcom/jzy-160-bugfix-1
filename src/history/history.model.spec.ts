import { resolveHistory, sineStrain, StrainHistorySpec } from './history.model';
import { ViscoError } from '../common/errors';

const grid = { kind: 'uniform', start: 0, stop: 10, count: 11 } as const;

describe('历程解析：分段线性', () => {
  test('正常解析起止时间与输出网格', () => {
    const h = resolveHistory({
      segments: [{ type: 'linear', times: [0, 2, 10], strains: [0, 0.1, 0.3] }],
      output: grid,
    });
    expect(h.tStart).toBe(0);
    expect(h.tEnd).toBe(10);
    expect(h.outputTimes).toHaveLength(11);
  });

  test('控制点时间不严格递增 → 错误', () => {
    expect(() =>
      resolveHistory({
        segments: [{ type: 'linear', times: [0, 2, 2], strains: [0, 0.1, 0.1] }],
        output: grid,
      }),
    ).toThrow(ViscoError);
    try {
      resolveHistory({
        segments: [{ type: 'linear', times: [0, 2, 1], strains: [0, 0.1, 0.1] }],
        output: grid,
      });
      fail('应当抛错');
    } catch (e) {
      expect((e as ViscoError).code).toBe('TIME_NOT_STRICTLY_INCREASING');
    }
  });

  test('times 与 strains 不等长 → 错误', () => {
    expect(() =>
      resolveHistory({
        segments: [{ type: 'linear', times: [0, 1], strains: [0] }],
        output: grid,
      }),
    ).toThrow(ViscoError);
  });

  test('没有段 → 错误', () => {
    expect(() => resolveHistory({ segments: [], output: grid })).toThrow(ViscoError);
  });
});

describe('历程解析：正弦拼接', () => {
  test('正弦段时长=cycles/frequency，起止时间正确', () => {
    const h = resolveHistory({
      segments: [
        { type: 'linear', times: [0, 1], strains: [0, 0.5] },
        { type: 'sine', amplitude: 0.2, frequency: 2, cycles: 3, preload: 0.5 },
      ],
      output: { kind: 'uniform', start: 0, stop: 1 + 1.5, count: 26 },
    });
    expect(h.segments).toHaveLength(2);
    const sine = h.segments[1];
    expect(sine.type).toBe('sine');
    if (sine.type === 'sine') {
      expect(sine.t0).toBe(1);
      expect(sine.duration).toBeCloseTo(1.5, 12);
    }
    expect(h.tEnd).toBeCloseTo(2.5, 12);
  });

  test('正弦频率 ≤ 0 → 错误', () => {
    const spec = (f: number): StrainHistorySpec => ({
      segments: [
        { type: 'linear', times: [0, 1], strains: [0, 0] },
        { type: 'sine', amplitude: 0.1, frequency: f, cycles: 2, preload: 0 },
      ],
      output: { kind: 'uniform', start: 0, stop: 2, count: 5 },
    });
    try {
      resolveHistory(spec(0));
      fail('应当抛错');
    } catch (e) {
      expect((e as ViscoError).code).toBe('SINE_FREQUENCY_NONPOSITIVE');
    }
    try {
      resolveHistory(spec(-2));
      fail('应当抛错');
    } catch (e) {
      expect((e as ViscoError).code).toBe('SINE_FREQUENCY_NONPOSITIVE');
    }
  });

  test('周期数 ≤ 0 → 错误', () => {
    expect(() =>
      resolveHistory({
        segments: [
          { type: 'linear', times: [0, 1], strains: [0, 0] },
          { type: 'sine', amplitude: 0.1, frequency: 1, cycles: 0, preload: 0 },
        ],
        output: { kind: 'uniform', start: 0, stop: 1, count: 2 },
      }),
    ).toThrow(ViscoError);
  });

  test('第一段是正弦 → 错误', () => {
    try {
      resolveHistory({
        segments: [{ type: 'sine', amplitude: 0.1, frequency: 1, cycles: 1 }],
        output: { kind: 'uniform', start: 0, stop: 1, count: 2 },
      });
      fail('应当抛错');
    } catch (e) {
      expect((e as ViscoError).code).toBe('FIRST_SEGMENT_NOT_LINEAR');
    }
  });

  test('正弦拼接点应变不一致（preload 不等于前段末点）→ 错误', () => {
    expect(() =>
      resolveHistory({
        segments: [
          { type: 'linear', times: [0, 1], strains: [0, 0.5] },
          { type: 'sine', amplitude: 0.1, frequency: 1, cycles: 1, preload: 0.2 },
        ],
        output: { kind: 'uniform', start: 0, stop: 2, count: 3 },
      }),
    ).toThrow(/拼接点|不连续/);
  });

  test('sineStrain 取值：段起点 preload，1/4 周期处 preload+A', () => {
    const seg = { type: 'sine' as const, amplitude: 0.3, frequency: 2, cycles: 1, preload: 0.5, t0: 1, duration: 0.5 };
    expect(sineStrain(seg, 1)).toBeCloseTo(0.5, 12);
    expect(sineStrain(seg, 1 + 1 / 8)).toBeCloseTo(0.8, 12); // 1/4 周期 = 1/(4f)
    expect(sineStrain(seg, 1.5)).toBeCloseTo(0.5, 12);
  });
});

describe('历程解析：多段线性拼接', () => {
  test('后续段从相对 0 拼接并去掉重复点', () => {
    const h = resolveHistory({
      segments: [
        { type: 'linear', times: [0, 1], strains: [0, 0.2] },
        { type: 'linear', times: [0, 2], strains: [0.2, 0.4] },
      ],
      output: { kind: 'uniform', start: 0, stop: 3, count: 4 },
    });
    expect(h.tEnd).toBe(3);
    const all = h.segments.flatMap((s) => (s.type === 'linear' ? s.times : []));
    expect(all).toEqual([0, 1, 3]);
  });

  test('拼接点应变不一致 → 间断错误', () => {
    expect(() =>
      resolveHistory({
        segments: [
          { type: 'linear', times: [0, 1], strains: [0, 0.2] },
          { type: 'linear', times: [0, 1], strains: [0.3, 0.4] },
        ],
        output: { kind: 'uniform', start: 0, stop: 2, count: 3 },
      }),
    ).toThrow(ViscoError);
  });
});

describe('历程解析：输出网格', () => {
  test('输出网格超出历程时间范围 → 错误', () => {
    try {
      resolveHistory({
        segments: [{ type: 'linear', times: [0, 5], strains: [0, 1] }],
        output: { kind: 'points', times: [0, 10] },
      });
      fail('应当抛错');
    } catch (e) {
      expect((e as ViscoError).code).toBe('OUTPUT_GRID_OUT_OF_RANGE');
    }
  });

  test('空输出网格 → 错误', () => {
    expect(() =>
      resolveHistory({
        segments: [{ type: 'linear', times: [0, 1], strains: [0, 1] }],
        output: { kind: 'points', times: [] },
      }),
    ).toThrow(ViscoError);
  });

  test('输出网格不递增 → 错误', () => {
    expect(() =>
      resolveHistory({
        segments: [{ type: 'linear', times: [0, 5], strains: [0, 1] }],
        output: { kind: 'points', times: [0, 3, 2] },
      }),
    ).toThrow(ViscoError);
  });

  test('均匀网格生成', () => {
    const h = resolveHistory({
      segments: [{ type: 'linear', times: [0, 4], strains: [0, 1] }],
      output: { kind: 'uniform', start: 0, stop: 4, count: 5 },
    });
    expect(h.outputTimes).toEqual([0, 1, 2, 3, 4]);
  });
});
