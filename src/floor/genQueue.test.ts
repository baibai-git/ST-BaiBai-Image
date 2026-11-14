import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NAI_MIN_INTERVAL_MS,
  noteNaiRateLimited,
  setNaiMinInterval,
} from '@/backends/naiRateLimit';
import { acquireNaiSlot, naiSlotBusy, resetNaiGate, setNaiConcurrency } from '@/floor/genQueue';

describe('NAI 并发闸门', () => {
  beforeEach(() => {
    resetNaiGate();
    // 本组只验并发,把节奏关掉;节奏另有一组(见下)。
    setNaiMinInterval(0);
  });

  afterEach(() => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  it('默认上限 1:第二个请求要等第一个 release', async () => {
    const release1 = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);

    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    // 还没 release,第二个不该拿到槽
    await Promise.resolve();
    expect(granted).toBe(false);

    release1();
    const release2 = await pending;
    expect(granted).toBe(true);
    release2();
    expect(naiSlotBusy()).toBe(false);
  });

  it('上限内的请求立刻通过', async () => {
    setNaiConcurrency(2);
    const a = await acquireNaiSlot();
    const b = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
    b();
    expect(naiSlotBusy()).toBe(false);
  });

  it('调大上限立刻放行等待中的任务', async () => {
    const first = await acquireNaiSlot();
    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    setNaiConcurrency(3);
    const second = await pending;
    expect(granted).toBe(true);
    first();
    second();
  });

  it('已取消的 signal 直接抛错,不占槽位', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireNaiSlot(controller.signal)).rejects.toThrow();
    expect(naiSlotBusy()).toBe(false);
  });

  it('排队期间被取消:抛错并从队列摘除,不会之后再占槽', async () => {
    const release1 = await acquireNaiSlot();
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    // 尚在排队时取消
    controller.abort();
    await expect(pending).rejects.toThrow();

    // 释放第一个后,被取消的那个不该悄悄占用槽位
    release1();
    expect(naiSlotBusy()).toBe(false);
    const release2 = await acquireNaiSlot();
    release2();
  });

  it('release 幂等:重复调用不会把计数减穿', async () => {
    const release = await acquireNaiSlot();
    release();
    release();
    release();
    expect(naiSlotBusy()).toBe(false);
    // 计数没被减成负数 → 仍只允许 1 个并发
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });

  it('并发上限至少为 1(非法值兜底)', async () => {
    setNaiConcurrency(0);
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });
});

describe('NAI 节奏(闸门侧,按接入点分)', () => {
  /** 用小间隔跑真实时钟:比假时钟更能验到「持槽等待」的真实次序。 */
  const INTERVAL = 40;

  beforeEach(() => {
    resetNaiGate();
    setNaiMinInterval(INTERVAL);
  });

  afterEach(() => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
    resetNaiGate();
  });

  it('第一个请求不等待', async () => {
    const started = Date.now();
    const release = await acquireNaiSlot();
    expect(Date.now() - started).toBeLessThan(INTERVAL);
    release();
  });

  it('相邻两个请求之间至少隔一个最小间隔', async () => {
    const first = await acquireNaiSlot();
    first();
    const started = Date.now();
    const second = await acquireNaiSlot();
    // 时钟精度留 5ms 余量
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERVAL - 5);
    second();
  });

  it('节奏等待持槽进行:上限 2 时第二个也得排在第一个之后,不会同时放行', async () => {
    setNaiConcurrency(2);
    const started = Date.now();
    const [a, b] = await Promise.all([acquireNaiSlot(), acquireNaiSlot()]);
    // 两个都在上限内,但第二个仍要等完间隔——否则「并发 2」等于「同时发 2 个」
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERVAL - 5);
    a();
    b();
  });

  it('429 冷却会拦住新任务取槽', async () => {
    noteNaiRateLimited(120);
    const started = Date.now();
    const release = await acquireNaiSlot();
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
    release();
  });

  it('闸门按接入点分:A 站满了 / 在冷却,B 站照样立刻放行', async () => {
    const a = await acquireNaiSlot(undefined, 'nep_a');
    noteNaiRateLimited(5000, Date.now(), 'nep_a');
    expect(naiSlotBusy('nep_a')).toBe(true);
    expect(naiSlotBusy('nep_b')).toBe(false);
    const started = Date.now();
    const b = await acquireNaiSlot(undefined, 'nep_b');
    expect(Date.now() - started).toBeLessThan(100);
    a();
    b();
  });

  it('并发上限逐个接入点设置', async () => {
    setNaiConcurrency(2, 'nep_a');
    setNaiMinInterval(0);
    const a1 = await acquireNaiSlot(undefined, 'nep_a');
    const a2 = await acquireNaiSlot(undefined, 'nep_a');
    expect(naiSlotBusy('nep_a')).toBe(true);
    // 另一个站没设过 → 按 1 起步
    const b1 = await acquireNaiSlot(undefined, 'nep_b');
    expect(naiSlotBusy('nep_b')).toBe(true);
    a1();
    a2();
    b1();
  });

  it('节奏等待期间被取消:抛错且把槽还回去(不泄漏)', async () => {
    noteNaiRateLimited(5000);
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    // 此刻已持槽、正在等冷却
    expect(naiSlotBusy()).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    // 槽已归还:否则并发永久少一格
    expect(naiSlotBusy()).toBe(false);
  });
});
