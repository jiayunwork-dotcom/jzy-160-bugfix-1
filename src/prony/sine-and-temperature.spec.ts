import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from './prony-kernel.service';
import { dynamicModulusAtHz } from '../dynamic/dynamic-modulus.service';
import { wlfShiftFactor } from '../wlf/wlf.service';
import { makeMaterial, runSpec } from '../test-support/helpers';

describe('正弦稳态：递推内核与解析 E′、E″ 一致', () => {
  const material = makeMaterial(
    { eInf: 30 },
    [
      { modulus: 40, tau: 0.05 },
      { modulus: 60, tau: 2 },
    ],
  );
  const frequency = 1; // Hz，ω=2π，落在两个 τ 之间
  const amplitude = 0.01;
  const totalCycles = 60;

  const spec: StrainHistorySpec = {
    segments: [
      // 极短线性段承载初始静止状态，随后整条正弦（含启动瞬态，统计时丢弃前段）
      { type: 'linear', times: [0, 1e-6], strains: [0, 0] },
      { type: 'sine', amplitude, frequency, cycles: totalCycles, preload: 0 },
    ],
    output: {
      kind: 'uniform',
      start: 0,
      stop: totalCycles / frequency,
      count: totalCycles * 40 + 1,
    },
  };

  test('末尾 20 周期 Lissajous 最小二乘拟合的 E′、E″ 与解析解一致（相对偏差 < 2%）', () => {
    const { result, history } = runSpec(material, spec);
    const sineSeg = history.segments[1];
    if (sineSeg.type !== 'sine') throw new Error('第二段应当是正弦段');

    // 稳态 σ = E′·A sinθ + E″·A cosθ（ε=A sinθ）。
    // 在末尾 20 个周期上对 sinθ、cosθ 基函数做最小二乘（显式 2×2 正规方程）。
    const period = 1 / frequency;
    const measureStart = sineSeg.t0 + (totalCycles - 20) * period;
    let Ssin2 = 0;
    let Scos2 = 0;
    let Ssincos = 0;
    let Ssinsig = 0;
    let Scossig = 0;
    for (let i = 0; i < result.times.length; i++) {
      const t = result.times[i];
      if (t < measureStart) continue;
      const theta = 2 * Math.PI * frequency * (t - sineSeg.t0);
      const sn = Math.sin(theta);
      const cs = Math.cos(theta);
      Ssin2 += sn * sn;
      Scos2 += cs * cs;
      Ssincos += sn * cs;
      Ssinsig += sn * result.stresses[i];
      Scossig += cs * result.stresses[i];
    }
    const det = Ssin2 * Scos2 - Ssincos * Ssincos;
    // 拟合系数是 σ = a·sinθ + b·cosθ，故 E′=a/A, E″=b/A
    const a = (Scos2 * Ssinsig - Ssincos * Scossig) / det;
    const b = (Ssin2 * Scossig - Ssincos * Ssinsig) / det;
    const storage = a / amplitude;
    const loss = b / amplitude;

    const analytic = dynamicModulusAtHz(material, frequency);
    expect(Math.abs(storage - analytic.storageModulus) / analytic.storageModulus).toBeLessThan(0.02);
    expect(Math.abs(loss - analytic.lossModulus) / analytic.lossModulus).toBeLessThan(0.02);
    // tanδ 自洽
    expect(loss / storage).toBeCloseTo(analytic.lossTangent, 2);
  });
});

describe('时温等效：升温使同一历程松弛得更快', () => {
  const wlf = { tRef: 20, c1: 17.44, c2: 51.6 };
  const material = makeMaterial({ eInf: 3, wlf }, [{ modulus: 7, tau: 2 }]);

  test('T>Tref 时 a_T<1，高温应力在松弛阶段更低', () => {
    const eps0 = 0.1;
    const base: StrainHistorySpec = {
      segments: [{ type: 'linear', times: [0, 20], strains: [eps0, eps0] }],
      output: { kind: 'uniform', start: 0, stop: 20, count: 201 },
    };
    const ref = runSpec(material, base).result;
    const hot = runSpec(material, { ...base, temperature: 60 }).result;

    expect(hot.shiftFactor).toBe(wlfShiftFactor(60, wlf));
    expect(hot.shiftFactor).toBeLessThan(1);

    // 起点相同（阶跃瞬间 E0·ε0）
    expect(hot.stresses[0]).toBeCloseTo(ref.stresses[0], 12);
    // 在松弛中段，高温应力更小
    let anyLower = false;
    for (let i = 20; i < 80; i++) {
      if (hot.stresses[i] < ref.stresses[i] - 1e-9) anyLower = true;
    }
    expect(anyLower).toBe(true);

    // 高温曲线与“参考温度下 τ 缩小为 a_T·τ”的曲线完全一致
    const equivalent = makeMaterial({ eInf: 3 }, [{ modulus: 7, tau: 2 * hot.shiftFactor }]);
    const equivResult = runSpec(equivalent, base).result;
    hot.stresses.forEach((s, i) => {
      expect(s).toBeCloseTo(equivResult.stresses[i], 10);
    });
  });

  test('WLF 分母 ≤ 0 时经内核路径抛出说明原因的错误', () => {
    const history = resolveHistory({
      segments: [{ type: 'linear', times: [0, 1], strains: [0.1, 0.1] }],
      temperature: -100, // C2 + T − Tref < 0
      output: { kind: 'uniform', start: 0, stop: 1, count: 2 },
    });
    expect(() => runPronyKernel({ material, history })).toThrow(/WLF 分母/);
  });
});
