import { ViscoError } from '../common/errors';
import { WlfParams } from '../material/material.model';

/**
 * WLF 时温等效（Williams–Landel–Ferry）。
 *
 *   log10 a_T = -C1 (T - Tref) / (C2 + T - Tref)
 *
 * 物理意义：在温度 T 下观测的时间 t，等价于参考温度 Tref 下的约化时间 t / a_T；
 * 材料在该温度下的有效松弛时间 τ(T) = a_T · τ。
 *
 * - T > Tref 时（标准 C1、C2 > 0）a_T < 1，松弛加快；
 * - 分母 C2 + T − Tref ≤ 0 时 WLF 公式失效，按需求返回错误。
 */
export function wlfShiftFactor(temperature: number, wlf: WlfParams): number {
  if (!Number.isFinite(temperature)) {
    throw new TypeError('温度必须是有限数值');
  }
  const denominator = wlf.c2 + (temperature - wlf.tRef);
  if (denominator <= 0) {
    throw new ViscoError(
      'WLF_DENOMINATOR_NONPOSITIVE',
      `WLF 分母 C2 + T − Tref = ${denominator} ≤ 0（T=${temperature}, Tref=${wlf.tRef}, C2=${wlf.c2}），公式适用范围之外`,
    );
  }
  const exponent = (-wlf.c1 * (temperature - wlf.tRef)) / denominator;
  return Math.pow(10, exponent);
}

/** 把参考温度下的松弛时间换算到给定温度：τ(T) = a_T · τ。 */
export function shiftedTau(referenceTau: number, aT: number): number {
  return aT * referenceTau;
}
