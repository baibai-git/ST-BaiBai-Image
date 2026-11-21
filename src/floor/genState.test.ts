import { beforeEach, describe, expect, it } from 'vitest';

import {
  activeGenCount,
  beginGen,
  cancelGen,
  clearAllGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  pruneGenSlots,
  reconcileGen,
  setGenPhase,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';

const KEY = slotKey('chat1', 3, 0, 0);

describe('genState', () => {
  beforeEach(() => {
    clearAllGen();
  });

  it('beginGen 登记运行态并给出未取消的 signal', () => {
    const { signal } = beginGen(KEY, 'hash1');
    expect(signal.aborted).toBe(false);
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', error: '', hash: 'hash1' });
  });

  it('同槽位再次 beginGen 会中止上一个任务', () => {
    const first = beginGen(KEY, 'hash1');
    const second = beginGen(KEY, 'hash1');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('cancelGen 中止在途请求并清掉记录', () => {
    const { signal } = beginGen(KEY, 'hash1');
    cancelGen(KEY);
    expect(signal.aborted).toBe(true);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  it('failGen 保留 error 相位与信息(重水合后仍可见)', () => {
    const { token } = beginGen(KEY, 'hash1');
    failGen(KEY, token, '出图失败了');
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'error', error: '出图失败了' });
  });

  it('clearGen 清空记录,卡片回落派生态', () => {
    const { token } = beginGen(KEY, 'hash1');
    clearGen(KEY, token);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  it('setGenPhase / setQueueAhead 就地更新展示态', () => {
    const { token } = beginGen(KEY, 'hash1', 'queued');
    expect(getGenRecord(KEY)?.phase).toBe('queued');
    setGenPhase(KEY, token, 'generating');
    setQueueAhead(KEY, token, 2);
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', queueAhead: 2 });
  });

  it('reconcileGen:hash 变了才作废在途任务', () => {
    const { signal } = beginGen(KEY, 'hash1');
    // 同 hash:不动
    expect(reconcileGen(KEY, 'hash1')).toBe(false);
    expect(signal.aborted).toBe(false);
    // hash 变了(用户改了 tag):旧任务作废
    expect(reconcileGen(KEY, 'hash2')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  /**
   * 回归:旧任务迟到的回调不得改到新任务头上。
   * 典型触发——A 被 abort 后以非 AbortError 失败(HTTP 500/429 与 abort 撞车),
   * 其 catch 若无票据校验就会把正在跑的 B 标成 error。
   */
  describe('票据隔离(旧任务不得污染新任务)', () => {
    it('旧任务 failGen 不影响新任务', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h');
      failGen(KEY, a.token, 'A 的报错');
      expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', token: b.token });
      expect(getGenRecord(KEY)?.error).toBe('');
    });

    it('旧任务 clearGen 不会清掉新任务', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h');
      clearGen(KEY, a.token);
      expect(getGenRecord(KEY)?.token).toBe(b.token);
    });

    it('旧任务 setQueueAhead / setGenPhase 被忽略', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h', 'queued');
      setQueueAhead(KEY, a.token, 99);
      setGenPhase(KEY, a.token, 'error');
      expect(getGenRecord(KEY)).toMatchObject({ phase: 'queued', queueAhead: null, token: b.token });
    });

    it('isCurrentGen 让旧任务在落盘前自我放弃', () => {
      const a = beginGen(KEY, 'h');
      expect(isCurrentGen(KEY, a.token)).toBe(true);
      cancelGen(KEY);
      // 记录已清:迟到的 A 不该再落盘
      expect(isCurrentGen(KEY, a.token)).toBe(false);
    });
  });

  it('clearAllGen 中止全部并清空(切聊天/删楼)', () => {
    const a = beginGen(slotKey('c', 1, 0, 0), 'h');
    const b = beginGen(slotKey('c', 2, 0, 0), 'h');
    clearAllGen();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(activeGenCount()).toBe(0);
  });

  it('activeGenCount 只数在途,不数 error', () => {
    beginGen(slotKey('c', 1, 0, 0), 'h');
    beginGen(slotKey('c', 2, 0, 0), 'h', 'queued');
    const failed = slotKey('c', 3, 0, 0);
    const { token } = beginGen(failed, 'h');
    failGen(failed, token, 'boom');
    expect(activeGenCount()).toBe(2);
  });

  describe('pruneGenSlots', () => {
    it('删掉越界槽位(tag 变少后消失的那些),保留仍存在的', () => {
      const kept = slotKey('c', 5, 0, 0);
      const gone = slotKey('c', 5, 0, 2);
      const { signal: keptSignal } = beginGen(kept, 'h');
      const { signal: goneSignal } = beginGen(gone, 'h');
      // 正文现在只剩 1 个 tag → seq >= 1 的都该清掉
      pruneGenSlots('c', 5, 0, 1);
      expect(getGenRecord(kept)).toBeDefined();
      expect(keptSignal.aborted).toBe(false);
      expect(getGenRecord(gone)).toBeUndefined();
      expect(goneSignal.aborted).toBe(true);
    });

    it('清掉消失槽位残留的 error,同 key 复现时不会认领旧报错', () => {
      const key = slotKey('c', 5, 0, 1);
      const { token } = beginGen(key, 'h');
      failGen(key, token, '上一轮的报错');
      // tag 全被删掉
      pruneGenSlots('c', 5, 0, 0);
      expect(getGenRecord(key)).toBeUndefined();
    });

    it('不误伤其它楼层 / 其它 swipe', () => {
      const otherFloor = slotKey('c', 6, 0, 3);
      const otherSwipe = slotKey('c', 5, 1, 3);
      beginGen(otherFloor, 'h');
      beginGen(otherSwipe, 'h');
      pruneGenSlots('c', 5, 0, 0);
      expect(getGenRecord(otherFloor)).toBeDefined();
      expect(getGenRecord(otherSwipe)).toBeDefined();
    });

    it('keepCount 覆盖全部槽位时什么都不动(出图成功后的常规重水合)', () => {
      const a = slotKey('c', 5, 0, 0);
      const b = slotKey('c', 5, 0, 1);
      const { signal: aSignal } = beginGen(a, 'h');
      const { signal: bSignal } = beginGen(b, 'h');
      // 关键回归:重水合不得 abort 正在生成的兄弟槽位
      pruneGenSlots('c', 5, 0, 2);
      expect(aSignal.aborted).toBe(false);
      expect(bSignal.aborted).toBe(false);
      expect(activeGenCount()).toBe(2);
    });
  });
});
