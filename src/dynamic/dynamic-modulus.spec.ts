import { dynamicModulus, dynamicModulusAtHz } from './dynamic-modulus.service';
import { makeMaterial } from '../test-support/helpers';

describe('动态模量（Prony 解析 E′、E″、tanδ）', () => {
  // E∞=3, E1=7, τ=2
  const material = makeMaterial({ eInf: 3 }, [{ modulus: 7, tau: 2 }]);

  test('单支路在 ω=1/τ 处 E′=E∞+E1/2, E″=E1/2, tanδ=E1/(2E∞+E1)', () => {
    const omega = 0.5; // = 1/τ
    const dm = dynamicModulus(material, omega);
    expect(dm.storageModulus).toBeCloseTo(3 + 3.5, 12);
    expect(dm.lossModulus).toBeCloseTo(3.5, 12);
    expect(dm.lossTangent).toBeCloseTo(3.5 / 6.5, 12);
    expect(dm.complexMagnitude).toBeCloseTo(Math.hypot(6.5, 3.5), 12);
  });

  test('与一般解析式逐点一致', () => {
    for (const omega of [0.01, 0.3, 1.7, 12, 100]) {
      const x = omega * 2;
      const dm = dynamicModulus(material, omega);
      expect(dm.storageModulus).toBeCloseTo(3 + (7 * x * x) / (1 + x * x), 12);
      expect(dm.lossModulus).toBeCloseTo((7 * x) / (1 + x * x), 12);
    }
  });

  test('多支路求和', () => {
    const multi = makeMaterial(
      { eInf: 10 },
      [
        { modulus: 5, tau: 0.1 },
        { modulus: 8, tau: 10 },
      ],
    );
    const omega = 3;
    const branch = (tau: number, e: number) => {
      const x = omega * tau;
      return { s: (e * x * x) / (1 + x * x), l: (e * x) / (1 + x * x) };
    };
    const b1 = branch(0.1, 5);
    const b2 = branch(10, 8);
    const dm = dynamicModulus(multi, omega);
    expect(dm.storageModulus).toBeCloseTo(10 + b1.s + b2.s, 12);
    expect(dm.lossModulus).toBeCloseTo(b1.l + b2.l, 12);
  });

  test('低频极限 E′→E∞、E″→0；高频极限 E′→E0、E″→0', () => {
    const low = dynamicModulus(material, 1e-9);
    expect(low.storageModulus).toBeCloseTo(3, 6);
    // E″ ≈ E1·ωτ = 1.4e-8
    expect(low.lossModulus).toBeCloseTo(7 * 1e-9 * 2, 9);

    const high = dynamicModulus(material, 1e9);
    expect(high.storageModulus).toBeCloseTo(10, 6);
    expect(high.lossModulus).toBeCloseTo(7 / (1e9 * 2), 9);
  });

  test('Hz 便捷重载换算 ω=2πf', () => {
    const f = 1;
    const viaHz = dynamicModulusAtHz(material, f);
    const viaOmega = dynamicModulus(material, 2 * Math.PI);
    expect(viaHz.storageModulus).toBeCloseTo(viaOmega.storageModulus, 14);
    expect(viaHz.lossModulus).toBeCloseTo(viaOmega.lossModulus, 14);
  });

  test('ω ≤ 0 抛错', () => {
    expect(() => dynamicModulus(material, 0)).toThrow(RangeError);
    expect(() => dynamicModulus(material, -1)).toThrow(RangeError);
  });
});
