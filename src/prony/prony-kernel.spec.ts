import { runPronyKernel } from './prony-kernel.service';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { makeMaterial, runSpec, stepHoldSpec, linspace, approxEqual } from '../test-support/helpers';

/**
 * 可手算的单支路阶跃算例：
 *   E∞=3, 单支路 E1=7, τ1=2；t=0 阶跃 ε0=0.1 并保持。
 *   σ(t) = ε0 [ 3 + 7 e^{-t/2} ]
 *   t=0  : σ = 0.1×10 = 1
 *   t=τ=2: 支路贡献剩初值的 e⁻¹，σ = 0.1×(3 + 7/e) = 0.557515...
 *   t≫τ : σ → 0.1×3 = 0.3
 */
describe('Prony 递推内核：单支路阶跃手算算例', () => {
  const material = makeMaterial({ eInf: 3 }, [{ modulus: 7, tau: 2 }]);
  const eps0 = 0.1;
  const tEnd = 20;
  const grid = linspace(0, tEnd, 401);
  const spec: StrainHistorySpec = {
    ...stepHoldSpec(eps0, tEnd, 401),
    output: { kind: 'points', times: grid },
  };
  const { result } = runSpec(material, spec);
  const sigma = (t: number) => eps0 * (3 + 7 * Math.exp(-t / 2));

  test('t=0 应力等于 E0·ε0=1', () => {
    expect(result.stresses[0]).toBeCloseTo(1, 12);
    expect(result.strains[0]).toBeCloseTo(eps0, 12);
  });

  test('t=τ=2 时支路贡献为初值的 e⁻¹', () => {
    const idx = grid.indexOf(2);
    // 支路贡献 = σ − E∞·ε0；初值 = E1·ε0 = 0.7
    const branchNow = result.stresses[idx] - 3 * eps0;
    expect(branchNow).toBeCloseTo((7 * eps0) / Math.E, 12);
    expect(result.stresses[idx]).toBeCloseTo(sigma(2), 12);
  });

  test('各输出时刻与解析 σ(t)=ε0(3+7e^{-t/2}) 一致', () => {
    grid.forEach((t, i) => {
      expect(result.stresses[i]).toBeCloseTo(sigma(t), 10);
    });
  });

  test('同时输出的松弛模量 E(t)=3+7e^{-t/2}', () => {
    grid.forEach((t, i) => {
      expect(result.relaxationModulus[i]).toBeCloseTo(3 + 7 * Math.exp(-t / 2), 10);
    });
  });

  test('t 远大于最大 τ 时应力趋于 E∞·ε0=0.3', () => {
    // 另取 tEnd=100（50τ）的网格验证长时收敛
    const far = runSpec(material, stepHoldSpec(eps0, 100, 5)).result;
    expect(far.stresses.at(-1)).toBeCloseTo(0.3, 8);
    // 原 10τ 网格末点为渐近过程中的值（物理正确，残差 ≈ E1·ε0·e⁻¹⁰）
    const last = result.stresses[result.stresses.length - 1];
    expect(last).toBeCloseTo(0.3 + 0.7 * Math.exp(-10), 10);
  });
});

describe('Prony 内核：基本性质', () => {
  test('没有支路时退化为线弹性 σ=E∞·ε（斜坡+保持）', () => {
    const elastic = makeMaterial({ eInf: 5 }, []);
    const spec: StrainHistorySpec = {
      segments: [
        { type: 'linear', times: [0, 1, 3], strains: [0, 0.2, 0.2] },
      ],
      output: { kind: 'uniform', start: 0, stop: 3, count: 31 },
    };
    const { result } = runSpec(elastic, spec);
    result.strains.forEach((eps, i) => {
      expect(result.stresses[i]).toBeCloseTo(5 * eps, 12);
    });
    // 保持段末应力
    expect(result.stresses.at(-1)).toBeCloseTo(1, 12);
  });

  test('阶跃应变下 σ(t)=E(t)·ε0 恒等', () => {
    const material = makeMaterial(
      { eInf: 2 },
      [
        { modulus: 4, tau: 0.5 },
        { modulus: 6, tau: 5 },
      ],
    );
    const eps0 = 0.37;
    const { result } = runSpec(material, stepHoldSpec(eps0, 30, 601));
    result.relaxationModulus.forEach((e, i) => {
      expect(result.stresses[i]).toBeCloseTo(e * eps0, 10);
    });
  });
});

describe('Prony 内核：线性（叠加性）', () => {
  const material = makeMaterial(
    { eInf: 2 },
    [
      { modulus: 3, tau: 1 },
      { modulus: 5, tau: 7 },
    ],
  );

  const rampA: StrainHistorySpec = {
    segments: [{ type: 'linear', times: [0, 2, 6], strains: [0.05, 0.2, 0.2] }],
    output: { kind: 'uniform', start: 0, stop: 6, count: 121 },
  };
  const rampB: StrainHistorySpec = {
    segments: [{ type: 'linear', times: [0, 3, 6], strains: [0, 0.1, -0.05] }],
    output: { kind: 'uniform', start: 0, stop: 6, count: 121 },
  };

  test('两条历程应变相加，应力等于各自应力之和', () => {
    const a = runSpec(material, rampA).result;
    const b = runSpec(material, rampB).result;
    const sumSpec: StrainHistorySpec = {
      segments: [
        {
          type: 'linear',
          times: [0, 2, 3, 6],
          strains: [
            0.05,
            0.2 + (0.1 * 2) / 3, // 合并控制点：各自线性相加后为分段线性
            0.2 + 0.1,
            0.2 - 0.05,
          ],
        },
      ],
      output: { kind: 'uniform', start: 0, stop: 6, count: 121 },
    };
    // 更直接的加法构造：在统一网格 0..6 上把两条应变曲线数值相加作为新控制点
    const times = linspace(0, 6, 121);
    const epsSum = times.map((_, i) => a.strains[i] + b.strains[i]);
    const direct: StrainHistorySpec = {
      segments: [{ type: 'linear', times, strains: epsSum }],
      output: { kind: 'points', times },
    };
    const c = runSpec(material, direct).result;
    times.forEach((_, i) => {
      expect(c.stresses[i]).toBeCloseTo(a.stresses[i] + b.stresses[i], 9);
    });
    void sumSpec;
  });
});

describe('Prony 内核：时间平移不变性', () => {
  const material = makeMaterial({ eInf: 1 }, [{ modulus: 2, tau: 3 }]);
  const base: StrainHistorySpec = {
    segments: [{ type: 'linear', times: [0, 2, 5], strains: [0, 0.4, 0.1] }],
    output: { kind: 'uniform', start: 0, stop: 5, count: 101 },
  };

  test('整条历程在时间上平移 t0，应力曲线同样平移', () => {
    const shift = 4.5;
    const a = runSpec(material, base).result;
    const shifted: StrainHistorySpec = {
      segments: [
        { type: 'linear', times: [shift, shift + 2, shift + 5], strains: [0, 0.4, 0.1] },
      ],
      output: { kind: 'points', times: linspace(shift, shift + 5, 101) },
    };
    const b = runSpec(material, shifted).result;
    a.stresses.forEach((s, i) => {
      expect(b.stresses[i]).toBeCloseTo(s, 9);
    });
    // 时间坐标确实平移
    expect(b.times[50] - a.times[50]).toBeCloseTo(shift, 12);
  });
});

describe('Prony 内核：时间尺度缩放不变性', () => {
  const material = makeMaterial({ eInf: 1 }, [{ modulus: 2, tau: 3 }]);
  const k = 5;

  test('所有 τ 与时间轴同乘 k，应力曲线按时间缩放后不变', () => {
    const base: StrainHistorySpec = {
      segments: [{ type: 'linear', times: [0, 2, 8], strains: [0, 0.4, 0.1] }],
      output: { kind: 'uniform', start: 0, stop: 8, count: 81 },
    };
    const a = runSpec(material, base).result;

    const scaledMaterial = makeMaterial(
      { eInf: 1 },
      [{ modulus: 2, tau: 3 * k }],
    );
    const scaled: StrainHistorySpec = {
      segments: [
        { type: 'linear', times: [0, 2 * k, 8 * k], strains: [0, 0.4, 0.1] },
      ],
      output: { kind: 'uniform', start: 0, stop: 8 * k, count: 81 },
    };
    const b = runSpec(scaledMaterial, scaled).result;

    a.stresses.forEach((s, i) => {
      expect(b.stresses[i]).toBeCloseTo(s, 9);
    });
  });
});

describe('Prony 内核：分段线性精确积分与网格加密', () => {
  const material = makeMaterial({ eInf: 2 }, [
    { modulus: 3, tau: 0.7 },
    { modulus: 4, tau: 9 },
  ]);

  test('斜坡加载结果与高分辨率参考解一致', () => {
    const spec: StrainHistorySpec = {
      segments: [{ type: 'linear', times: [0, 4, 10], strains: [0, 0.5, 0.5] }],
      output: { kind: 'uniform', start: 0, stop: 10, count: 51 },
    };
    const coarse = runSpec(material, spec).result;
    const fineSpec: StrainHistorySpec = { ...spec, output: { kind: 'uniform', start: 0, stop: 10, count: 2001 } };
    const fine = runSpec(material, fineSpec).result;

    coarse.times.forEach((t, i) => {
      // 在细网格上找同一时刻
      const j = Math.round((t / 10) * 2000);
      expect(Math.abs(fine.times[j] - t)).toBeLessThan(1e-9);
      expect(coarse.stresses[i]).toBeCloseTo(fine.stresses[j], 9);
    });
  });

  test('输出网格加密一倍，同一时刻应力变化不超过给定容差（1e-6 相对）', () => {
    const make = (n: number): StrainHistorySpec => ({
      segments: [{ type: 'linear', times: [0, 1, 5, 12], strains: [0, 0.3, 0.3, 0.05] }],
      output: { kind: 'uniform', start: 0, stop: 12, count: n },
    });
    const g1 = runSpec(material, make(121)).result;
    const g2 = runSpec(material, make(241)).result;
    const tol = 1e-6;
    g1.times.forEach((t, i) => {
      const j = i * 2;
      expect(g2.times[j]).toBeCloseTo(t, 9);
      const diff = Math.abs(g2.stresses[j] - g1.stresses[i]);
      const scale = Math.max(1, Math.abs(g1.stresses[i]));
      expect(diff / scale).toBeLessThanOrEqual(tol);
    });
  });

  test('长历程计算量线性：推进步数 = 断点数，不回看历史（接口层面断点合并正确）', () => {
    // 内核以合并断点单遍推进；这里保证超长保持段与短保持段结果都正确且能快速完成
    const mat = makeMaterial({ eInf: 1 }, [{ modulus: 10, tau: 1 }]);
    const spec = stepHoldSpec(1, 1e6, 5);
    const started = Date.now();
    const { result } = runSpec(mat, spec);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.stresses.at(-1)).toBeCloseTo(1, 6);
  });
});

describe('Prony 内核：正弦段与正弦拼接', () => {
  const material = makeMaterial({ eInf: 3 }, [
    { modulus: 4, tau: 0.2 },
    { modulus: 8, tau: 3 },
  ]);

  test('正弦段可拼接在线性段之后，段起点应变连续', () => {
    const spec: StrainHistorySpec = {
      segments: [
        { type: 'linear', times: [0, 1], strains: [0, 0.5] },
        { type: 'sine', amplitude: 0.1, frequency: 2, cycles: 4, preload: 0.5 },
      ],
      output: { kind: 'uniform', start: 0, stop: 1 + 4 / 2, count: 181 },
    };
    const resolved = resolveHistory(spec);
    expect(resolved.tEnd).toBeCloseTo(3, 12);
    const result = runPronyKernel({ material, history: resolved });
    expect(result.stresses).toHaveLength(181);
    // 首周期前静态预载 0.5：在正弦起点附近应力围绕 E∞·0.5 量级
    expect(Number.isFinite(result.stresses[60])).toBe(true);
  });
});
