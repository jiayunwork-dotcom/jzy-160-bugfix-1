import { wlfShiftFactor, shiftedTau } from './wlf.service';
import { WlfParams } from '../material/material.model';

// 通用聚合物常数 C1=17.44, C2=51.6（°C），Tref=−50 只是测试用值
const wlf: WlfParams = { tRef: 20, c1: 17.44, c2: 51.6 };

describe('WLF 时温等效', () => {
  test('T=Tref 时 a_T=1', () => {
    expect(wlfShiftFactor(20, wlf)).toBeCloseTo(1, 12);
  });

  test('温度高于参考温度时 a_T<1', () => {
    const a = wlfShiftFactor(60, wlf);
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThan(0);
    // 手算：log10 a = -17.44*40/(51.6+40)
    const expected = Math.pow(10, (-17.44 * 40) / (51.6 + 40));
    expect(a).toBeCloseTo(expected, 12);
  });

  test('温度低于参考温度时 a_T>1（松弛变慢）', () => {
    expect(wlfShiftFactor(0, wlf)).toBeGreaterThan(1);
  });

  test('有效松弛时间 τ(T)=a_T·τ，升温时缩短、松弛更快', () => {
    const tau = 2;
    const aHot = wlfShiftFactor(60, wlf);
    expect(shiftedTau(tau, aHot)).toBeLessThan(tau);
    const aCold = wlfShiftFactor(0, wlf);
    expect(shiftedTau(tau, aCold)).toBeGreaterThan(tau);
  });

  test('分母 C2+T−Tref ≤ 0 返回说明原因的错误', () => {
    // Tref−C2 = −31.6 时分母为 0
    expect(() => wlfShiftFactor(20 - 51.6, wlf)).toThrow(/WLF 分母/);
    expect(() => wlfShiftFactor(-100, wlf)).toThrow(/WLF 分母/);
  });
});
