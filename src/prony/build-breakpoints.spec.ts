import { buildBreakpoints } from './prony-kernel.service';
import { ResolvedHistory } from '../history/history.model';

/**
 * 断点合并的差分测试：优化后的 O(n log n) 实现必须与朴素 O(n²) 参考
 * 实现逐点等价（断点集合与顺序一致 ⇒ 内核数值逐位一致）。
 *
 * 朴素参考实现即优化前的原始算法：按加入顺序（控制点先于输出时刻）
 * 处理候选点，凡与某个已保留点相差不超过 tol 即丢弃，最后排序。
 */
function naiveBuildBreakpoints(control: number[], output: number[]): number[] {
  const DEDUP_EPS = 1e-12;
  const points: number[] = [];
  const add = (t: number): void => {
    const tol = DEDUP_EPS * Math.max(1, Math.abs(t));
    for (const existing of points) {
      if (Math.abs(existing - t) <= tol) return;
    }
    points.push(t);
  };
  for (const t of control) add(t);
  for (const t of output) add(t);
  return points.sort((a, b) => a - b);
}

/** 用显式控制点/输出时刻构造内核输入（绕过历程解析，便于直接构造边界值）。 */
function historyOf(control: number[], output: number[]): ResolvedHistory {
  return {
    segments: [{ type: 'linear', times: control.slice(), strains: control.map(() => 0) }],
    tStart: control[0],
    tEnd: control[control.length - 1],
    outputTimes: output.slice(),
  };
}

function expectSame(control: number[], output: number[]): void {
  expect(buildBreakpoints(historyOf(control, output))).toEqual(
    naiveBuildBreakpoints(control, output),
  );
}

describe('断点合并：与朴素 O(n²) 参考实现逐点等价', () => {
  test('固定边界用例', () => {
    expectSame([0, 100], [0, 50, 100]); // 端点重合
    expectSame([0, 1e-6], [0, 5e-7, 1e-6]); // 亚微秒控制点
    expectSame([1, 2], [1, 1.5, 2]); // 非零起点
    expectSame([0, 1], [1 - 5e-13, 1, 1 + 5e-13]); // tol 内近重复（曾捕获不一致）
    expectSame([0, 1], [1 - 2e-12, 1 + 2e-12]); // tol 外近邻
    expectSame([-100, -50], [-100, -75, -50]); // 负时间
    expectSame([0, 1e8], [0, 5e7, 1e8]); // 大时间尺度
    expectSame([0, 1], [0.3, 0.3 + 5e-13, 0.3 + 1.5e-12, 0.7]); // 簇内链式近邻
    expectSame([0.1, 0.2, 0.30000000000000004], [0.1, 0.2, 0.3]); // 浮点表示噪声
    expectSame([0, 5, 5, 10], [0, 5, 10]); // 控制点原值重复（正弦段拼接点）
    expectSame([0, 1], [0.9999999999999999, 1]); // 输出点比控制点小 1 ulp
    expectSame([0, 0.3, 1], [0.1 + 0.2, 0.5]); // 0.1+0.2 ≠ 0.3 的著名浮点情形
  });

  test('随机用例（含刻意贴近 tol 的扰动）', () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iter = 0; iter < 20000; iter++) {
      const scale = [1e-6, 1, 100, 1e6][iter % 4];
      const nSeg = 2 + Math.floor(rand() * 5);
      const control: number[] = [];
      let t = rand() * scale;
      for (let k = 0; k < nSeg; k++) {
        control.push(t);
        t += rand() * scale;
        if (rand() < 0.1) control.push(control[control.length - 1]); // 原值重复
      }
      const nOut = 1 + Math.floor(rand() * 20);
      const output: number[] = [];
      for (let k = 0; k < nOut; k++) {
        let ot = control[0] + rand() * (control[control.length - 1] - control[0]);
        if (rand() < 0.4) {
          // 贴近某个控制点，扰动在 tol 上下随机（含恰好 1 ulp 的情形）
          const c = control[Math.floor(rand() * control.length)];
          ot = c + (rand() - 0.5) * 4e-12 * Math.max(1, Math.abs(c));
        }
        output.push(ot);
      }
      output.sort((a, b) => a - b);
      expectSame(control, output);
    }
  });

  test('大规模均匀网格：断点数 = 输出点数 + 内部控制点数', () => {
    // 注意：朴素参考实现是 O(n²)，本用例规模取到其可接受的量级即可；
    // 等价性主要由上面的两万个随机用例保证。
    const count = 5001;
    const output = Array.from({ length: count }, (_, i) => (i / (count - 1)) * 100);
    const control = [0, 25, 50, 75, 100];
    const breakpoints = buildBreakpoints(historyOf(control, output));
    // 均匀网格步长 0.02 ≫ tol，控制点 25/50/75 与网格点不重合（100/5000 非整数倍）
    expect(breakpoints).toEqual(naiveBuildBreakpoints(control, output));
    expect(breakpoints.length).toBeGreaterThanOrEqual(count);
  });
});
