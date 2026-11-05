import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginImage,
  beginLlm,
  clearHistory,
  cacheHitRate,
  failImage,
  failLlm,
  finishLlm,
  patchLlmTokens,
  records,
  resetHistory,
  roughTokens,
  safeHistory,
  truncate,
  HISTORY_LIMITS,
  type ImageRecord,
  type LlmRecord,
} from './history';

const { MAX_RECORDS, MAX_CONTENT } = HISTORY_LIMITS;

function llm(source = 'test'): number {
  return beginLlm({
    source,
    channelName: 'ch',
    model: 'm',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

beforeEach(() => {
  resetHistory();
});

describe('cache usage', () => {
  it('retains real cache counters and calculates an input-token ratio', () => {
    const id = llm();
    finishLlm(id, { response: 'ok', promptTokens: 1000, completionTokens: 20,
      cacheReadTokens: 800, tokensEstimated: false });
    const record = records[0] as LlmRecord;
    expect(record.cacheReadTokens).toBe(800);
    expect(cacheHitRate(record)).toBe(80);
    expect(cacheHitRate({ ...record, cacheReadTokens: 0 })).toBe(0);
  });
  it('keeps unknown, zero-input and estimated usage distinct from a zero hit rate', () => {
    const base = { promptTokens: 100, cacheReadTokens: null, tokensEstimated: false };
    expect(cacheHitRate(base)).toBeNull();
    expect(cacheHitRate({ ...base, cacheReadTokens: 80, tokensEstimated: true })).toBeNull();
    expect(cacheHitRate({ ...base, cacheReadTokens: 0, promptTokens: 0 })).toBeNull();
    expect(cacheHitRate({ ...base, cacheReadTokens: 101 })).toBeNull();
    const id = llm();
    finishLlm(id, { response: 'ok', promptTokens: 100, completionTokens: 5, tokensEstimated: false });
    expect((records[0] as LlmRecord).cacheReadTokens).toBeNull();
  });
});

describe('环形缓冲', () => {
  it('新记录在前', () => {
    llm('第一条');
    llm('第二条');
    expect((records[0] as LlmRecord).source).toBe('第二条');
    expect((records[1] as LlmRecord).source).toBe('第一条');
  });

  it('超出封顶时丢弃最旧的', () => {
    for (let i = 0; i < MAX_RECORDS + 10; i++) llm(`#${i}`);
    expect(records.length).toBe(MAX_RECORDS);
    // 最新的在前,最旧的 10 条应已被挤出
    expect((records[0] as LlmRecord).source).toBe(`#${MAX_RECORDS + 9}`);
    expect((records[records.length - 1] as LlmRecord).source).toBe('#10');
  });

  it('被挤出后 finish/fail 是安全空操作', () => {
    const id = llm('会被挤出');
    for (let i = 0; i < MAX_RECORDS; i++) llm(`填充${i}`);
    expect(records.some(r => r.id === id)).toBe(false);
    expect(() =>
      finishLlm(id, { response: 'x', promptTokens: 1, completionTokens: 1, tokensEstimated: false }),
    ).not.toThrow();
    expect(() => failLlm(id, 'boom')).not.toThrow();
  });

  it('clearHistory 清空但保持同一数组引用(reactive 不断链)', () => {
    llm();
    const ref = records;
    clearHistory();
    expect(records.length).toBe(0);
    expect(records).toBe(ref);
  });
});

describe('截断', () => {
  it('短文本原样返回', () => {
    expect(truncate('abc')).toBe('abc');
  });

  it('超长文本截断并标注原长', () => {
    const long = 'x'.repeat(MAX_CONTENT + 500);
    const out = truncate(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain(`原长 ${MAX_CONTENT + 500} 字符`);
  });

  it('登记时对每条 message 都截断', () => {
    const id = beginLlm({
      source: 's',
      channelName: 'c',
      model: 'm',
      stream: false,
      messages: [
        { role: 'system', content: 'y'.repeat(MAX_CONTENT + 1) },
        { role: 'user', content: '短的' },
      ],
    });
    const record = records.find(r => r.id === id) as LlmRecord;
    expect(record.messages[0].content).toContain('已截断');
    expect(record.messages[1].content).toBe('短的');
  });

  it('返回正文同样截断', () => {
    const id = llm();
    finishLlm(id, {
      response: 'z'.repeat(MAX_CONTENT + 1),
      promptTokens: null,
      completionTokens: null,
      tokensEstimated: true,
    });
    expect((records[0] as LlmRecord).response).toContain('已截断');
  });
});

describe('状态流转', () => {
  it('finish 记成功并算耗时', () => {
    const id = llm();
    finishLlm(id, { response: 'ok', promptTokens: 12, completionTokens: 3, tokensEstimated: false });
    const record = records[0] as LlmRecord;
    expect(record.status).toBe('ok');
    expect(record.promptTokens).toBe(12);
    expect(record.tokensEstimated).toBe(false);
    expect(record.durationMs).not.toBeNull();
  });

  it('取消与失败分开:aborted 不带错误信息', () => {
    const a = llm();
    failLlm(a, '被取消了', true);
    expect(records[0].status).toBe('aborted');
    expect(records[0].error).toBe('');

    const b = llm();
    failLlm(b, '500 炸了');
    expect(records[0].status).toBe('error');
    expect(records[0].error).toBe('500 炸了');
  });

  it('生图记录同样区分取消与失败', () => {
    const id = beginImage({
      backend: 'nai',
      model: 'nai-diffusion-4',
      prompt: '1girl',
      nl: '',
      negative: '',
      characters: [{ name: 'A', tag: '1girl, black hair', nl: 'left' }],
      seed: 42,
      size: 'portrait',
      floor: 3,
      seq: 0,
    });
    failImage(id, '', true);
    const record = records[0] as ImageRecord;
    expect(record.status).toBe('aborted');
    expect(record.characters).toEqual([
      { name: 'A', tag: '1girl, black hair', nl: 'left' },
    ]);
  });
});

describe('token 补录', () => {
  it('估算结果可补录进已完成的记录', () => {
    const id = llm();
    finishLlm(id, { response: 'r', promptTokens: null, completionTokens: null, tokensEstimated: true });
    patchLlmTokens(id, 88, 9);
    const record = records[0] as LlmRecord;
    expect(record.promptTokens).toBe(88);
    expect(record.tokensEstimated).toBe(true);
  });

  it('已有真实 usage 时不被估算值覆盖', () => {
    const id = llm();
    finishLlm(id, { response: 'r', promptTokens: 100, completionTokens: 20, tokensEstimated: false });
    patchLlmTokens(id, 999, 999);
    const record = records[0] as LlmRecord;
    expect(record.promptTokens).toBe(100);
    expect(record.tokensEstimated).toBe(false);
  });
});

describe('roughTokens 粗估', () => {
  it('空串为 0', () => {
    expect(roughTokens('')).toBe(0);
  });

  it('中日韩按 1 字 1 token', () => {
    expect(roughTokens('你好世界')).toBe(4);
    expect(roughTokens('こんにちは')).toBe(5);
  });

  it('拉丁文按 4 字符 1 token', () => {
    expect(roughTokens('a'.repeat(40))).toBe(10);
  });

  it('中英混排两段分别计入', () => {
    // 4 个汉字 + 8 个 ASCII → 4 + 2
    expect(roughTokens('你好世界abcdefgh')).toBe(6);
  });

  it('代理对(emoji)按一个字符算,不重复计数', () => {
    // '🎨' 的 length 是 2,但按码点只应算 1 个字符 → 1/4 → 四舍五入 0
    expect(roughTokens('🎨')).toBe(0);
    expect(roughTokens('🎨'.repeat(4))).toBe(1);
  });

  it('结果随文本变长而单调不减(段间比大小是它唯一的用途)', () => {
    const short = roughTokens('短文本');
    const long = roughTokens('短文本'.repeat(50));
    expect(long).toBeGreaterThan(short);
  });
});

describe('safeHistory', () => {
  it('吞掉异常并返回 null,不连累主流程', () => {
    expect(
      safeHistory(() => {
        throw new Error('store 炸了');
      }),
    ).toBeNull();
  });

  it('正常时原样返回结果', () => {
    expect(safeHistory(() => 42)).toBe(42);
  });
});

 it('retains a validation failure response and upstream usage using the existing history limit',()=> {
  const id=llm();
  failLlm(id,'bad JSON',false,{response:'x'.repeat(MAX_CONTENT+100),promptTokens:100,completionTokens:20,cacheReadTokens:80,tokensEstimated:false});
  const record=records[0] as LlmRecord;
  expect(record.status).toBe('error'); expect(record.error).toBe('bad JSON');
  expect(record.response).toBe(truncate('x'.repeat(MAX_CONTENT+100)));
  expect(record.promptTokens).toBe(100); expect(record.completionTokens).toBe(20); expect(record.cacheReadTokens).toBe(80);
 });
