import { StoredMaterial } from '../material/material.model';

/**
 * 正弦稳态动态模量（Prony 级数解析解）。
 *
 * 对角频率 ω 的稳态正弦应变 ε=ε0 sin ωt，单支路贡献：
 *   E′_i(ω) = E_i · (ωτ_i)² / (1 + (ωτ_i)²)
 *   E″_i(ω) = E_i ·  ωτ_i    / (1 + (ωτ_i)²)
 * 平衡模量只贡献储能部分：
 *   E′ = E∞ + Σ E′_i,   E″ = Σ E″_i,   tan δ = E″ / E′
 */
export interface DynamicModulus {
  /** 角频率 ω = 2πf（rad/s） */
  omega: number;
  storageModulus: number;
  lossModulus: number;
  lossTangent: number;
  /** 复数模量幅值 |E*| = sqrt(E′² + E″²) */
  complexMagnitude: number;
}

export function dynamicModulus(material: StoredMaterial, omega: number): DynamicModulus {
  if (!Number.isFinite(omega) || omega <= 0) {
    throw new RangeError(`角频率 ω 必须为正有限值，收到 ${omega}`);
  }
  let storage = material.eInf;
  let loss = 0;
  for (const branch of material.branches) {
    const x = omega * branch.tau;
    const denom = 1 + x * x;
    storage += branch.modulus * (x * x) / denom;
    loss += branch.modulus * x / denom;
  }
  return {
    omega,
    storageModulus: storage,
    lossModulus: loss,
    lossTangent: storage === 0 ? Number.NaN : loss / storage,
    complexMagnitude: Math.hypot(storage, loss),
  };
}

/** 频率（Hz）便捷重载。 */
export function dynamicModulusAtHz(material: StoredMaterial, frequencyHz: number): DynamicModulus {
  return dynamicModulus(material, 2 * Math.PI * frequencyHz);
}
