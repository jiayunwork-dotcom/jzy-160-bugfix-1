import { instantaneousModulus, validateMaterial } from './material.model';
import { ViscoError } from '../common/errors';

describe('材料档校验', () => {
  test('E0 = E∞ + Σ E_i 建档时计算并回显', () => {
    const m = validateMaterial({
      name: 'rubber-A',
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.1 },
        { modulus: 6, tau: 10 },
      ],
    });
    expect(m.e0).toBe(13);
    expect(instantaneousModulus(3, [
      { modulus: 4, tau: 0.1 },
      { modulus: 6, tau: 10 },
    ])).toBe(13);
  });

  test('无支路时 E0=E∞（线弹性）', () => {
    const m = validateMaterial({ name: 'pure', eInf: 7, branches: [] });
    expect(m.e0).toBe(7);
  });

  test('E∞<0 → 错误', () => {
    try {
      validateMaterial({ name: 'x', eInf: -1, branches: [] });
      fail('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ViscoError);
      expect((e as ViscoError).code).toBe('E_INF_NEGATIVE');
    }
  });

  test('E_i<0 → 错误', () => {
    try {
      validateMaterial({ name: 'x', eInf: 1, branches: [{ modulus: -2, tau: 1 }] });
      fail('应当抛错');
    } catch (e) {
      expect((e as ViscoError).code).toBe('BRANCH_E_NEGATIVE');
    }
  });

  test('τ_i≤0 → 错误', () => {
    for (const tau of [0, -3]) {
      try {
        validateMaterial({ name: 'x', eInf: 1, branches: [{ modulus: 2, tau }] });
        fail(`τ=${tau} 应当抛错`);
      } catch (e) {
        expect((e as ViscoError).code).toBe('BRANCH_TAU_NONPOSITIVE');
      }
    }
  });

  test('E∞=0 与 E_i=0 边界值合法', () => {
    const m = validateMaterial({
      name: 'edge',
      eInf: 0,
      branches: [{ modulus: 0, tau: 1 }],
    });
    expect(m.e0).toBe(0);
  });

  test('wlf 缺省规范化为 null', () => {
    const m = validateMaterial({ name: 'x', eInf: 1, branches: [] });
    expect(m.wlf).toBeNull();
  });
});
