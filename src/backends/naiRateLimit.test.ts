import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NAI_MAX_ATTEMPTS,
  NAI_MIN_INTERVAL_MS,
  NAI_RATE_LIMIT_COOLDOWN_MS,
  isAbortError,
  isRetryableNaiStatus,
  naiCooldownRemainingMs,
  naiPacingDelayMs,
  noteNaiRateLimited,
  noteNaiRequestStart,
  parseRetryAfter,
  resetNaiPacing,
  retryDelayMs,
  runNaiWithRetry,
  setNaiMinInterval,
  shouldRetryNai,
} from '@/backends/naiRateLimit';

/** 与 NaiError 同形的最小替身:执行器只鸭子类型读 status / retryAfterMs。 */
function httpError(status: number, retryAfterMs: number | null = null): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, retryAfterMs });
}

function abortError(): Error {
  return Object.assign(new Error('已取消'), { name: 'AbortError' });
}

describe('NAI 重试策略', () => {
  it('408/429/5xx 可重试,501 与 4xx 配置类错误不重试', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 520, 522]) {
      expect(isRetryableNaiStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 402, 403, 404, 501]) {
      expect(isRetryableNaiStatus(status)).toBe(false);
    }
    expect(isRetryableNaiStatus(undefined)).toBe(false);
  });

  it('用户取消一律不重试(哪怕带着可重试状态码)', () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(shouldRetryNai(abortError(), 429)).toBe(false);
  });

  it('无状态码时:fetch 的 TypeError 重试,自家校验错误不重试', () => {
    expect(shouldRetryNai(new TypeError('Failed to fetch'), undefined)).toBe(true);
    expect(shouldRetryNai(new Error('zip 包内没有图片文件'), undefined)).toBe(false);
  });
});

describe('Retry-After 解析', () => {
  it('秒数写法', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(' 5 ')).toBe(5000);
  });

  it('HTTP 日期写法按当下时间算差值', () => {
    const now = Date.parse('2026-08-30T00:00:00Z');
    expect(parseRetryAfter('Sun, 30 Aug 2026 00:00:20 GMT', now)).toBe(20_000);
    // 已过期的日期夹到 0,不出现负等待
    expect(parseRetryAfter('Sun, 30 Aug 2026 00:00:00 GMT', now + 5000)).toBe(0);
  });

  it('空值/垃圾值 → null;超长值夹到 60s 上限', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('3600')).toBe(60_000);
  });
});

describe('退避时长', () => {
  it('指数增长,抖动落在 50%–100% 区间', () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(1000);
    expect(retryDelayMs(1, null, () => 1)).toBe(2000);
    expect(retryDelayMs(2, null, () => 0)).toBe(2000);
    expect(retryDelayMs(2, null, () => 1)).toBe(4000);
    expect(retryDelayMs(3, null, () => 0)).toBe(4000);
  });

  it('Retry-After 当下界:比退避长时以它为准', () => {
    expect(retryDelayMs(1, 30_000, () => 0)).toBe(30_000);
    // 比退避短则不削弱退避
    expect(retryDelayMs(3, 1000, () => 1)).toBe(8000);
  });

  it('单次等待不超过 60s', () => {
    expect(retryDelayMs(10, null, () => 1)).toBe(60_000);
    expect(retryDelayMs(1, 999_999, () => 1)).toBe(60_000);
  });
});

describe('节奏状态(按闸门分账)', () => {
  beforeEach(() => {
    resetNaiPacing();
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  afterEach(() => {
    resetNaiPacing();
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  it('初始不需要等待', () => {
    expect(naiPacingDelayMs(1000)).toBe(0);
  });

  it('刚发过请求 → 等到最小间隔满', () => {
    noteNaiRequestStart(1000);
    expect(naiPacingDelayMs(1000)).toBe(NAI_MIN_INTERVAL_MS);
    expect(naiPacingDelayMs(1000 + NAI_MIN_INTERVAL_MS - 200)).toBe(200);
    expect(naiPacingDelayMs(1000 + NAI_MIN_INTERVAL_MS)).toBe(0);
  });

  it('429 无 Retry-After → 默认冷却', () => {
    noteNaiRateLimited(null, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(NAI_RATE_LIMIT_COOLDOWN_MS);
    expect(naiPacingDelayMs(1000)).toBe(NAI_RATE_LIMIT_COOLDOWN_MS);
  });

  it('429 带 Retry-After → 按对方说的等', () => {
    noteNaiRateLimited(40_000, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(40_000);
  });

  it('冷却只延后不提前:后来的短冷却冲不掉前面的长冷却', () => {
    noteNaiRateLimited(40_000, 1000);
    noteNaiRateLimited(2000, 1500);
    expect(naiCooldownRemainingMs(1000)).toBe(40_000);
  });

  it('Retry-After: 0 也要刹一下(下界 1s),不然「立刻重来」会滚成连发', () => {
    noteNaiRateLimited(0, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(1000);
  });

  it('冷却上限 60s:对方给个离谱的 Retry-After 也不会把卡片挂死', () => {
    noteNaiRateLimited(999_999, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(60_000);
  });

  it('冷却与最小间隔取大值', () => {
    noteNaiRequestStart(1000);
    noteNaiRateLimited(30_000, 1000);
    expect(naiPacingDelayMs(1000)).toBe(30_000);
  });

  it('复位清空冷却与间隔基准', () => {
    noteNaiRequestStart(1000);
    noteNaiRateLimited(30_000, 1000);
    resetNaiPacing();
    expect(naiPacingDelayMs(1000)).toBe(0);
  });

  it('各接入点各记各的:A 站吃 429 / 刚发过,B 站不受牵连', () => {
    noteNaiRateLimited(30_000, 1000, 'nep_a');
    noteNaiRequestStart(1000, 'nep_a');
    expect(naiPacingDelayMs(1000, 'nep_a')).toBe(30_000);
    expect(naiPacingDelayMs(1000, 'nep_b')).toBe(0);
    expect(naiCooldownRemainingMs(1000, 'nep_b')).toBe(0);
    // 复位一次清所有闸门
    resetNaiPacing();
    expect(naiPacingDelayMs(1000, 'nep_a')).toBe(0);
  });
});

describe('重试执行器', () => {
  /** 记下每次等待时长但不真睡。 */
  function fakeDelay() {
    const waits: number[] = [];
    return {
      waits,
      delay: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  beforeEach(() => {
    resetNaiPacing();
    setNaiMinInterval(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetNaiPacing();
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
    vi.restoreAllMocks();
  });

  it('首发成功不重试,不产生等待', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi.fn(async () => 'ok');
    await expect(runNaiWithRetry(run, { delay })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('429 后成功:重试一次即返回', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce('ok');
    await expect(runNaiWithRetry(run, { delay })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
  });

  it('一直 429:总共只发 NAI_MAX_ATTEMPTS 次,并抛出原错误', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi.fn(async () => {
      throw httpError(429);
    });
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('HTTP 429');
    expect(run).toHaveBeenCalledTimes(NAI_MAX_ATTEMPTS);
    expect(waits).toHaveLength(NAI_MAX_ATTEMPTS - 1);
  });

  it('429 顺手给本闸门上冷却', async () => {
    const { delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce('ok');
    await runNaiWithRetry(run, { delay });
    expect(naiCooldownRemainingMs()).toBeGreaterThan(0);
  });

  it('指定 gate 时冷却只记在那个接入点上,重试也遵守那个接入点的冷却', async () => {
    const { waits, delay } = fakeDelay();
    noteNaiRateLimited(40_000, Date.now(), 'nep_b');
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429, 2000))
      .mockResolvedValueOnce('ok');
    await runNaiWithRetry(run, { delay, gate: 'nep_a' });
    expect(naiCooldownRemainingMs(Date.now(), 'nep_a')).toBeGreaterThan(0);
    expect(naiCooldownRemainingMs(Date.now())).toBe(0);
    // B 站的 40s 冷却不该拖住 A 站的重试
    expect(waits[0]).toBeLessThan(10_000);
  });

  it('401 立刻抛出,一次都不重试', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi.fn(async () => {
      throw httpError(401);
    });
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('HTTP 401');
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    // 配置错误不该污染全局节奏
    expect(naiCooldownRemainingMs()).toBe(0);
  });

  it('取消立刻抛出,不重试', async () => {
    const { delay } = fakeDelay();
    const run = vi.fn(async () => {
      throw abortError();
    });
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('已取消');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Retry-After 抬高等待时长', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429, 45_000))
      .mockResolvedValueOnce('ok');
    await runNaiWithRetry(run, { delay });
    expect(waits[0]).toBe(45_000);
  });

  it('每次重试都回报进度', async () => {
    const { delay } = fakeDelay();
    const onRetry = vi.fn();
    const run = vi.fn(async () => {
      throw httpError(503);
    });
    await expect(runNaiWithRetry(run, { delay, onRetry })).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(NAI_MAX_ATTEMPTS - 1);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2, 3]);
    expect(onRetry.mock.calls[0][0].max).toBe(NAI_MAX_ATTEMPTS - 1);
  });

  it('网络级失败(TypeError)也重试', async () => {
    const { delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce('ok');
    await expect(runNaiWithRetry(run, { delay })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('等待期间被取消:等待抛错就地中断,不再重跑', async () => {
    const run = vi.fn(async () => {
      throw httpError(429);
    });
    const delay = async () => {
      throw abortError();
    };
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('已取消');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
