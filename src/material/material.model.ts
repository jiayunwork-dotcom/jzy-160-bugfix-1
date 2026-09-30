import { ViscoError } from '../common/errors';

/**
 * 粘弹性材料域模型：广义 Maxwell（Prony）模型。
 *
 * 松弛模量  E(t) = E∞ + Σ E_i exp(-t / τ_i)
 * 瞬时模量  E0   = E∞ + Σ E_i
 *
 * 可选 WLF 时温等效参数（以 Tref 为参考温度）：
 *   log10 a_T = -C1 (T - Tref) / (C2 + T - Tref)
 */
export interface WlfParams {
  /** 参考温度（与输入温度同一温标，通常 °C） */
  tRef: number;
  c1: number;
  c2: number;
}

export interface PronyBranch {
  /** 支路模量 E_i */
  modulus: number;
  /** 松弛时间 τ_i（参考温度下） */
  tau: number;
}

export interface ViscoMaterial {
  name: string;
  description?: string;
  eInf: number;
  branches: PronyBranch[];
  wlf?: WlfParams | null;
}

export interface StoredMaterial extends ViscoMaterial {
  /** 瞬时模量 E0 = E∞ + Σ E_i，建档时计算并回显 */
  e0: number;
}

export function instantaneousModulus(eInf: number, branches: PronyBranch[]): number {
  return eInf + branches.reduce((s, b) => s + b.modulus, 0);
}

/**
 * 材料参数校验（纯函数，不碰数据库，便于单测）。
 * τ_i ≤ 0、E_i < 0、E∞ < 0 都在这里拒绝。
 */
export function validateMaterial(material: ViscoMaterial): StoredMaterial {
  if (!Number.isFinite(material.eInf)) {
    throw new TypeError('E∞ 必须是有限数值');
  }
  if (material.eInf < 0) {
    throw new ViscoError('E_INF_NEGATIVE', `平衡模量 E∞ 不能为负，收到 ${material.eInf}`);
  }
  for (const [i, b] of material.branches.entries()) {
    if (!Number.isFinite(b.modulus) || !Number.isFinite(b.tau)) {
      throw new TypeError(`支路 ${i + 1} 的 E_i、τ_i 必须是有限数值`);
    }
    if (b.tau <= 0) {
      throw new ViscoError(
        'BRANCH_TAU_NONPOSITIVE',
        `支路 ${i + 1} 松弛时间 τ_i 必须为正，收到 τ=${b.tau}`,
      );
    }
    if (b.modulus < 0) {
      throw new ViscoError(
        'BRANCH_E_NEGATIVE',
        `支路 ${i + 1} 支路模量 E_i 不能为负，收到 E=${b.modulus}`,
      );
    }
  }
  if (material.wlf) {
    const { tRef, c1, c2 } = material.wlf;
    if (![tRef, c1, c2].every(Number.isFinite)) {
      throw new TypeError('WLF 参数 tRef、c1、c2 必须是有限数值');
    }
  }
  return {
    ...material,
    wlf: material.wlf ?? null,
    e0: instantaneousModulus(material.eInf, material.branches),
  };
}
