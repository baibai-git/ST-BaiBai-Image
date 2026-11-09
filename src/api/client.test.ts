import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from '@/state/settings';
import { buildRequestBody, extractContent, readUsage, readSseContent, requestCompletion, requestViaMainApi, wireMessages } from './client';

/** 历史层全部 mock 掉:这里要断的正是「什么时候记成功/失败」 */
const h = vi.hoisted(() => ({
  beginLlm: vi.fn(() => 1),
  generateRaw: vi.fn(),
  finishLlm: vi.fn(),
  failLlm: vi.fn(),
  patchLlmTokens: vi.fn(),
}));

vi.mock('@/state/history', () => ({
  FOLLOW_MAIN_API: '跟随主 API',
  beginLlm: h.beginLlm,
  finishLlm: h.finishLlm,
  failLlm: h.failLlm,
  patchLlmTokens: h.patchLlmTokens,
  // 与真实实现同语义:吞异常返回 null
  safeHistory: (fn: () => unknown) => {
    try {
      return fn();
    } catch {
      return null;
    }
  },
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({ getRequestHeaders: () => ({}), generateRaw: h.generateRaw }),
}));

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const channel: ApiChannel = {
  id: 'ch1',
  name: '测试渠道',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  excludeParams: [],
  reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hi' }];

describe('layout image wire boundary',()=>{
  it('keeps plain text unchanged and serializes attachments as actual image blocks without local metadata',()=>{
    expect(wireMessages([{role:'system',content:'rules',purpose:'spec'},{role:'user',content:'atlas',images:['data:image/png;base64,AAA']}])).toEqual([
      {role:'system',content:'rules'},
      {role:'user',content:[{type:'text',text:'atlas'},{type:'image_url',image_url:{url:'data:image/png;base64,AAA',detail:'high'}}]},
    ]);
    expect(()=>wireMessages([{role:'system',content:'atlas',images:['x']}])).toThrow('user');
  });
  it('does not silently flatten images through the text-only main API helper',async()=>{
    await expect(requestViaMainApi([{role:'user',content:'atlas',images:['data:image/png;base64,AAA']}])).rejects.toThrow('支持图片的副 API');
  });
});

describe('readUsage: upstream cache counters', () => {
  it('reads DeepSeek cache hits without treating cache writes as hits', () => {
    expect(readUsage({ usage: { prompt_tokens: 1000, completion_tokens: 20,
      prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
      cache_creation_input_tokens: 200 } })).toEqual({ prompt: 1000, completion: 20, cached: 800 });
  });
  it('reads compatible nested cached_tokens and preserves an explicit zero', () => {
    expect(readUsage({ usage: { prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0 } } }).cached).toBe(0);
    expect(readUsage({ usage: { prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 70 } } }).cached).toBe(70);
  });
  it('does not infer cache hits from missing or invalid counters', () => {
    for (const value of [undefined, null, '80', -1, 1.5, NaN, Infinity, 101]) {
      expect(readUsage({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: value } }).cached).toBeNull();
    }
    expect(readUsage({}).cached).toBeNull();
  });
});
/** 带 usage 的响应:避免触发 token 估算分支(那需要主界面分词器) */
const okPayload = {
  choices: [{ message: { role: 'assistant', content: '  答案文本  ' } }],
  usage: { prompt_tokens: 5, completion_tokens: 7 },
};

/** 造一个最小 Response,可读出给定 SSE 文本 */
function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('buildRequestBody:思考强度与两条源分支', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const build = (over: Partial<typeof channel> = {}) =>
    buildRequestBody({ ...channel, ...over }, msgs, 'https://api.example.com/v1', false);

  it('未设思考强度 → 走 openai 源(除新增的 tool_choice 外,请求体与加功能前一致)', () => {
    expect(build()).toEqual({
      chat_completion_source: 'openai',
      reverse_proxy: 'https://api.example.com/v1',
      proxy_password: 'k',
      model: 'm',
      messages: msgs,
      temperature: 1,
      max_tokens: 1024,
      stream: false,
      tool_choice: 'none',
      presence_penalty: 0,
      frequency_penalty: 0,
    });
  });

  it('两条源分支都带 tool_choice:none(给防截断类 fetch 拦截器的放行握手)', () => {
    // Kemini 等预设脚本拦截所有 /generate 请求,看到调用方自带 tool_choice 就放行,
    // 不再注入合成工具 + 控制消息(否则生图 tag 会被拖慢甚至逼出重试)。
    expect(build().tool_choice).toBe('none');
    expect(build({ reasoningEffort: 'high' }).tool_choice).toBe('none');
    // 若用户真想让第三方改写,可用 excludeParams 删掉它
    expect(build({ excludeParams: ['tool_choice'] }).tool_choice).toBeUndefined();
  });

  it('设了思考强度 → 切 custom 源,并经 custom_include_body 透传', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://api.example.com/v1');
    // 顶层不发 reasoning_effort:openai/custom 源都卡模型名白名单,
    // 模型名恰好命中时会覆盖掉我们真正想发的值
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.custom_include_body as string)).toEqual({ reasoning_effort: 'high' });
  });

  it('custom 源必须靠 header 带 key:proxy_password 在该源下不被读取', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.proxy_password).toBeUndefined();
    expect(JSON.parse(body.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
  });

  it('key 含 YAML 元字符时仍能安全注入(靠 JSON.stringify 转义)', () => {
    // 手拼 YAML 会在这类 key 上解析失败;而 ST 的 mergeObjectWithYaml 是静默忽略,
    // header 注入失败 → 退回读 ST 自己的 Custom 密钥 → 可能把别家的 key 发到本端点。
    const nasty = 'sk-a:b#c{d}e*f "g"';
    const body = build({ reasoningEffort: 'high', key: nasty });
    expect(JSON.parse(body.custom_include_headers as string).Authorization).toBe(`Bearer ${nasty}`);
  });

  it('空白字符串视同未设(不误切 custom 源)', () => {
    expect(build({ reasoningEffort: '   ' }).chat_completion_source).toBe('openai');
  });

  it('取值不做白名单:非常规值原样透传', () => {
    const body = build({ reasoningEffort: '我自己的档位' });
    expect(JSON.parse(body.custom_include_body as string).reasoning_effort).toBe('我自己的档位');
  });

  it('excludeParams 在两条分支下都照常生效', () => {
    expect(build({ excludeParams: ['temperature'] }).temperature).toBeUndefined();
    expect(
      build({ excludeParams: ['temperature'], reasoningEffort: 'high' }).temperature,
    ).toBeUndefined();
  });
});

describe('extractContent:标准响应', () => {
  it('message.content 正常提取', () => {
    const data = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(extractContent(data)).toBe('hello');
  });

  it('兼容 choices[0].text 与顶层 content', () => {
    expect(extractContent({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractContent({ content: 'top-level' })).toBe('top-level');
  });

  it('content 为 content-parts 数组时拼接各段 text', () => {
    const data = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] };
    expect(extractContent(data)).toBe('ab');
  });

  it('content 为 null 时返回空串而非抛错', () => {
    const data = { choices: [{ message: { role: 'assistant', content: null, refusal: null } }] };
    expect(extractContent(data)).toBe('');
  });
});

describe('extractContent:推理模型把答案塞进 reasoning', () => {
  it('content 为空时回退 reasoning', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          reasoning: '思考过程…\n\n{"images":[],"changes":[]}',
        },
      }],
    };
    expect(extractContent(data)).toContain('"images"');
  });

  it('content 为空时回退 reasoning_content(DeepSeek 标准字段)', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: null, reasoning_content: '答案在里' },
      }],
    };
    expect(extractContent(data)).toBe('答案在里');
  });

  it('content 为空时回退 thinking', () => {
    const data = { choices: [{ message: { content: null, thinking: 'via thinking' } }] };
    expect(extractContent(data)).toBe('via thinking');
  });

  it('content 非空时绝不混入 reasoning', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: 'final answer', reasoning: 'chain of thought' },
      }],
    };
    expect(extractContent(data)).toBe('final answer');
  });
});

describe('readSseContent:流式', () => {
  it('preserves structured upstream errors inside SSE', async () => {
    await expect(readSseContent(sseResponse('data: {"error":{"message":"Gone","status":410,"code":"session_gone"}}\n\n')))
      .rejects.toMatchObject({status: 410, code: 'session_gone'});
  });
  it('拼接 delta.content', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('Hello');
  });

  it('content 全空时回退拼接 reasoning 增量', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"思考"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"…{\\"images\\":[]}"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toContain('"images"');
  });

  it('content 出现后忽略 reasoning,不拼接', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"先想"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('答案!');
  });
});

describe('validate:历史「成功」= 调用方验收通过', () => {
  beforeEach(() => {
    h.beginLlm.mockClear();
    h.finishLlm.mockClear();
    h.failLlm.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okPayload)));
  });

  it('验收通过 → 返回文本,历史记成功', async () => {
    const seen: string[] = [];
    const text = await requestCompletion(channel, messages, {
      validate: raw => seen.push(raw),
    });
    expect(text).toBe('答案文本');
    expect(seen).toEqual(['答案文本']); // validate 拿到的是提取后的正文
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
    expect(h.failLlm).not.toHaveBeenCalled();
  });

  it('不传 validate → 维持旧行为:拿到文本即记成功', async () => {
    await expect(requestCompletion(channel, messages)).resolves.toBe('答案文本');
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
  });

  it('验收抛错 → 请求按失败抛出,历史记失败而非成功', async () => {
    // 这是「HTTP 成功但协议解析不过」的场景:必须 failLlm,否则重试会在历史里
    // 留下两条绿色成功记录,看历史的人会误以为成功也重复调用。
    await expect(
      requestCompletion(channel, messages, {
        validate: () => {
          throw new Error('协议不合法');
        },
      }),
    ).rejects.toThrow('协议不合法');
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledWith(1, '协议不合法', false, {response:'答案文本', promptTokens:5, completionTokens:7, cacheReadTokens:null, tokensEstimated:false});
  });

  it('HTTP 失败时 validate 根本不该被调用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const validate = vi.fn();
    await expect(requestCompletion(channel, messages, { validate })).rejects.toThrow('500');
    expect(validate).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ message: 'Conflict', status: 409, code: 'rules_changed' }, 409, 'rules_changed'],
    [{ message: 'Gone', status: 410 }, 410, undefined],
    [{ message: 'Conflict' }, 409, undefined],
    [{ message: 'Gone' }, 410, undefined],
    [{ message: 'Unauthorized', status: 401 }, 401, undefined],
    [{ message: 'provider failed', status: '410' }, undefined, undefined],
    [{ message: 'toString' }, undefined, undefined],
  ])('preserves an upstream error wrapped in HTTP 200: %j', async (error, status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error })));
    await expect(requestCompletion(channel, messages)).rejects.toMatchObject({
      name: 'ApiError', message: error.message, status, code,
    });
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });

  it('preserves the actual HTTP status with structured errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({error: {message: 'session expired'}}), {
      status: 410, headers: {'content-type': 'application/json'},
    })));
    await expect(requestCompletion(channel, messages)).rejects.toMatchObject({status: 410, message: 'session expired'});
  });
});

 it('主 API 验收失败仍保留返回文本', async () => {
  h.finishLlm.mockClear(); h.failLlm.mockClear();
  h.generateRaw.mockResolvedValue('invalid response');
  await expect(requestViaMainApi(messages,{validate:()=>{throw new Error('invalid JSON');}})).rejects.toThrow('invalid JSON');
  expect(h.finishLlm).not.toHaveBeenCalled();
  expect(h.failLlm).toHaveBeenCalledWith(1,'invalid JSON',false,{response:'invalid response',promptTokens:null,completionTokens:null,tokensEstimated:true});
 });
