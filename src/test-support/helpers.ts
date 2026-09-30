import {
  ResolvedHistory,
  StrainHistorySpec,
  resolveHistory,
} from '../history/history.model';
import { StoredMaterial } from '../material/material.model';
import { runPronyKernel } from '../prony/prony-kernel.service';

/** 构造材料档测试夹具。 */
export function makeMaterial(
  overrides: Partial<StoredMaterial> = {},
  branches: Array<{ modulus: number; tau: number }> = [{ modulus: 7, tau: 2 }],
): StoredMaterial {
  const eInf = overrides.eInf ?? 3;
  const material: StoredMaterial = {
    name: overrides.name ?? 'test-rubber',
    eInf,
    branches: overrides.branches ?? branches,
    wlf: overrides.wlf ?? null,
    e0: eInf + (overrides.branches ?? branches).reduce((s, b) => s + b.modulus, 0),
  };
  return material;
}

/** 阶跃后保持：t=0 瞬时施加 eps0 并保持到 tEnd。 */
export function stepHoldSpec(eps0: number, tEnd: number, count = 201): StrainHistorySpec {
  return {
    segments: [{ type: 'linear', times: [0, tEnd], strains: [eps0, eps0] }],
    output: { kind: 'uniform', start: 0, stop: tEnd, count },
  };
}

export function runSpec(material: StoredMaterial, spec: StrainHistorySpec) {
  const history: ResolvedHistory = resolveHistory(spec);
  return { history, result: runPronyKernel({ material, history }) };
}

/** 相对/绝对混合容差比较。 */
export function approxEqual(actual: number, expected: number, tol = 1e-9): boolean {
  return Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
}

export function linspace(start: number, stop: number, count: number): number[] {
  if (count === 1) return [start];
  return Array.from({ length: count }, (_, i) => start + (stop - start) * (i / (count - 1)));
}
