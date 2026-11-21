import { afterEach, describe, expect, it, vi } from 'vitest';

import { simpleDefaults } from '@/backends/comfyTemplates';
import {
  generateComfyImage,
  ComfyUIError,
  parseWorkflowTemplate,
  renderWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';

const TEMPLATE = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: { seed: '%seed%', text: '%prompt%', neg: '%negative_prompt%' },
  },
});

function seedOf(workflow: ComfyWorkflow): unknown {
  return (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
}

afterEach(() => vi.restoreAllMocks());

describe('parseWorkflowTemplate', () => {
  it('hints that placeholders must be quoted strings when JSON parse fails on %', () => {
    try {
      parseWorkflowTemplate('{"3":{"class_type":"KSampler","inputs":{"seed":%seed%}}}');
      expect.unreachable('should throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('占位符必须写成字符串形式');
      expect(message).toContain('"%seed%"');
    }
  });
});

describe('renderWorkflowTemplate with %seed%', () => {
  it('replaces exact %seed% with a number (not string)', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl' });
    expect(seedOf(workflow)).toBeTypeOf('number');
    expect(seedOf(workflow)).toBeGreaterThanOrEqual(0);
    expect(seedOf(workflow)).toBeLessThan(2 ** 53);
  });

  it('uses the explicitly passed seed when provided', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 42 });
    expect(seedOf(workflow)).toBe(42);
  });

  it('uses the passed seed even when it is 0', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 0 });
    expect(seedOf(workflow)).toBe(0);
  });

  it('replaces every %seed% across all nodes with the same value', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%', note: 'seed=%seed% here' } },
      '9': { class_type: 'SomeNode', inputs: { value: 3 } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl', seed: 12345 });
    const n3 = workflow['3'] as { inputs: { seed: unknown } };
    const n7 = workflow['7'] as { inputs: { noise_seed: unknown; note: unknown } };
    expect(n3.inputs.seed).toBe(12345);
    expect(n7.inputs.noise_seed).toBe(12345);
    // 嵌在字符串里的 %seed% 也被替换成同一个值
    expect(n7.inputs.note).toBe('seed=12345 here');
  });

  it('replaces every %seed% with the same generated value when not passed', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%' } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl' });
    const a = (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
    const b = (workflow['7'] as { inputs: { noise_seed: unknown } }).inputs.noise_seed;
    expect(a).toBeTypeOf('number');
    expect(a).toBe(b);
  });
});

describe('renderWorkflowTemplate with %nl%', () => {
  it('writes nl only into explicit %nl% placeholders, never into %prompt%', () => {
    const template = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '%nl%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl', nl: 'A girl.' });
    expect((workflow['3'] as { inputs: { text: unknown } }).inputs.text).toBe('1girl');
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('A girl.');
  });

  it('substitutes an empty string for %nl% when nl is absent', () => {
    const template = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'caption: %nl%', prompt: '%prompt%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl' });
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('caption: ');
  });
});

describe('renderWorkflowTemplate with %negative_prompt%', () => {
  it('writes the per-image negative prompt into the workflow template', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, {
      prompt: '1girl',
      negative_prompt: 'extra people, duplicate character',
      seed: 1,
    });
    const inputs = (workflow['3'] as { inputs: { neg: unknown } }).inputs;
    expect(inputs.neg).toBe('extra people, duplicate character');
  });
});

describe('renderWorkflowTemplate with %width% / %height%', () => {
  const SIZED = JSON.stringify({
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%' } },
  });

  it('renders width/height as numbers (EmptyLatentImage rejects strings)', () => {
    const workflow = renderWorkflowTemplate(SIZED, { prompt: '2girls', width: 1216, height: 832 });
    const inputs = (workflow['5'] as { inputs: { width: unknown; height: unknown } }).inputs;
    expect(inputs.width).toBe(1216);
    expect(inputs.height).toBe(832);
    expect(inputs.width).toBeTypeOf('number');
  });

  it('throws when the workflow uses the placeholders but no size was resolved', () => {
    expect(() => renderWorkflowTemplate(SIZED, { prompt: '1girl' })).toThrow(ComfyUIError);
    expect(() => renderWorkflowTemplate(SIZED, { prompt: '1girl' })).toThrow('%width%');
  });

  it('ignores a missing size entirely when the workflow hardcodes its own dimensions', () => {
    // 存量工作流(尺寸写死)必须零影响——画幅是 opt-in 特性
    const legacy = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    });
    const workflow = renderWorkflowTemplate(legacy, { prompt: '1girl' });
    const inputs = (workflow['5'] as { inputs: { width: unknown; height: unknown } }).inputs;
    expect(inputs.width).toBe(512);
    expect(inputs.height).toBe(512);
  });
});

/**
 * 取消路径:必须按任务在队列里的位置分流。
 * 旧实现无脑 POST /interrupt——并发出图时取消排在后面的任务会打断**正在跑的别的任务**。
 */
describe('generateComfyImage 取消', () => {
  const CONN = {
    url: 'http://127.0.0.1:8188',
    workflow: TEMPLATE,
    qualityTags: '',
    negativePrompt: '',
    resolution: '',
    portraitSize: '',
    landscapeSize: '',
  } as unknown as Parameters<typeof generateComfyImage>[0];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 记录取消阶段打到哪些端点、带什么 body。 */
  function stubFetch(queueBody: unknown) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.includes('/queue')) return json(queueBody);
        // history 永远返回空:任务「未完成」,轮询会一直等,直到 abort
        if (url.includes('/history/')) return json({});
        return json({});
      }),
    );
    return calls;
  }

  /**
   * 等到轮询真正开始(出现 /history 请求)再取消。
   * 不能只等 /prompt:那时 queueDirect 可能还没返回,取消监听尚未注册。
   */
  async function waitForPolling(calls: Array<{ url: string }>): Promise<void> {
    await vi.waitFor(() => expect(calls.some(c => c.url.includes('/history/'))).toBe(true));
  }

  it('任务仍在排队 → 用 /queue delete 摘除,不 interrupt', async () => {
    const calls = stubFetch({
      queue_running: [[0, 'other-running-task']],
      queue_pending: [[1, 'pid-1']],
    });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      const cancelCall = calls.find(c => c.url.includes('/queue') && c.body);
      expect(cancelCall?.body).toEqual({ delete: ['pid-1'] });
    });
    // 关键:没有打断正在跑的那个任务
    expect(calls.some(c => c.url.includes('/interrupt'))).toBe(false);
  });

  it('任务正在执行 → interrupt 且带自己的 prompt_id', async () => {
    const calls = stubFetch({ queue_running: [[0, 'pid-1']], queue_pending: [] });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      const interrupt = calls.find(c => c.url.includes('/interrupt'));
      // 带 prompt_id:新版 ComfyUI 据此校验,旧版无视 body 但我们已确认在跑的就是自己
      expect(interrupt?.body).toEqual({ prompt_id: 'pid-1' });
    });
    // 排队中的任务才用 delete,这里不该发
    expect(calls.some(c => c.url.includes('/queue') && c.body)).toBe(false);
  });

  it('onQueue 上报排队位置(正在跑的也算在前面)', async () => {
    stubFetch({
      queue_running: [[0, 'other']],
      queue_pending: [
        [1, 'ahead-1'],
        [2, 'pid-1'],
      ],
    });
    const reported: Array<number | null> = [];
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal, {
      onQueue: ahead => reported.push(ahead),
    });
    // 前面 1 个 pending(ahead-1)+ 1 个 running = 2
    await vi.waitFor(() => expect(reported).toContain(2));
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('队列位置查不到时两条都发(否则「在跑但查不到」会漏中断、白烧 GPU)', async () => {
    // 队列返回不可解析的形状 → fetchQueuePosition 得到 null(位置未知)
    const calls = stubFetch({ nonsense: true });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      expect(calls.find(c => c.url.includes('/queue') && c.body)?.body).toEqual({
        delete: ['pid-1'],
      });
      expect(calls.find(c => c.url.includes('/interrupt'))?.body).toEqual({ prompt_id: 'pid-1' });
    });
  });
});

/**
 * 简易模式:预设不带 JSON,由 comfyTemplates 按模板组装。
 * 与 custom 模式在「拿到可提交 JSON」处汇合,故这里只验提交体是组装结果。
 */
describe('generateComfyImage 简易模式', () => {
  const SIMPLE_CONN = {
    url: 'http://127.0.0.1:8188',
    workflow: '',
    mode: 'simple',
    simple: {
      ...simpleDefaults(),
      model: 'illustrious.safetensors',
      positive: 'masterpiece',
      negative: 'worst quality',
    },
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
  } as unknown as Parameters<typeof generateComfyImage>[0];

  afterEach(() => vi.unstubAllGlobals());

  function stubSuccessFetch() {
    const calls: Array<{ url: string; body: unknown }> = [];
    const json = (data: unknown) => ({ ok: true, json: async () => data, text: async (): Promise<string> => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.includes('/history/')) {
          return json({
            'pid-1': {
              status: { completed: true },
              outputs: { '8': { images: [{ filename: 'BaiBai_00001_.png', type: 'output' }] } },
            },
          });
        }
        if (url.includes('/view')) {
          return { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }), text: async (): Promise<string> => '' };
        }
        return json({});
      }),
    );
    return calls;
  }

  it('提交的是组装出的工作流(固定词+生成词拼接,尺寸取自预设)', async () => {
    const calls = stubSuccessFetch();
    const result = await generateComfyImage(SIMPLE_CONN, {
      prompt: '1girl',
      negative_prompt: 'extra people',
      seed: 42,
      size: 'portrait',
    });
    expect(result.filename).toBe('BaiBai_00001_.png');

    const submit = calls.find(c => c.url.endsWith('/prompt'));
    const prompt = (submit?.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(prompt['1'].class_type).toBe('CheckpointLoaderSimple');
    expect(prompt['1'].inputs.ckpt_name).toBe('illustrious.safetensors');
    expect(prompt['3'].inputs.text).toBe('masterpiece, 1girl');
    expect(prompt['4'].inputs.text).toBe('worst quality, extra people');
    expect(prompt['5'].inputs).toMatchObject({ width: 832, height: 1216 });
    expect(prompt['6'].inputs.seed).toBe(42);
    result.revoke();
  });

  it('配置不齐(未选模型)时走 ComfyUIError,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const conn = {
      ...SIMPLE_CONN,
      simple: { ...simpleDefaults(), model: '' },
    } as unknown as Parameters<typeof generateComfyImage>[0];
    await expect(generateComfyImage(conn, { prompt: '1girl' })).rejects.toThrow(ComfyUIError);
    await expect(generateComfyImage(conn, { prompt: '1girl' })).rejects.toThrow('模型');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
