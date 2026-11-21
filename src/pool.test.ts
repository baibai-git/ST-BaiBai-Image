import { describe, expect, it } from 'vitest';

import { mapLimit } from '@/pool';

/** 受控 promise:让测试自己决定每个任务何时完成。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapLimit', () => {
  it('返回顺序与输入一致,而非完成顺序', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapLimit([0, 1, 2], 3, async i => {
      await gates[i].promise;
      return `r${i}`;
    });
    // 倒着放行:若按完成顺序收集,结果会是 r2,r1,r0
    gates[2].resolve();
    gates[1].resolve();
    gates[0].resolve();
    expect(await run).toEqual(['r0', 'r1', 'r2']);
  });

  it('同时在跑的任务数不超过 limit', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    const run = mapLimit(gates, 2, async gate => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return 1;
    });
    // 先让前两个起跑,再逐个放行,始终不该超过 2
    await Promise.resolve();
    gates.forEach(gate => gate.resolve());
    await run;
    expect(peak).toBe(2);
  });

  it('慢任务不拖住整片:worker 各自取下一个未领的下标', async () => {
    const slow = deferred<void>();
    const order: number[] = [];
    const run = mapLimit([0, 1, 2, 3], 2, async i => {
      // 0 号一直卡着,1 号之后的都该由另一个 worker 顺次做完
      if (i === 0) await slow.promise;
      order.push(i);
      return i;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([1, 2, 3]);
    slow.resolve();
    expect(await run).toEqual([0, 1, 2, 3]);
  });
});
