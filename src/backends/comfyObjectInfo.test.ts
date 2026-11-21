import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearComfyModelListsCache,
  fetchComfyModelLists,
  parseObjectInfo,
} from '@/backends/comfyObjectInfo';

vi.mock('@/st/context', () => ({
  getContext: () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  }),
}));

afterEach(() => {
  clearComfyModelListsCache();
  vi.restoreAllMocks();
});

const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illu.safetensors', 'pony.safetensors']] } } },
  UNETLoader: { input: { required: { unet_name: [['flux1-dev.safetensors', 'anima.safetensors']] } } },
  UnetLoaderGGUF: { input: { required: { unet_name: [['anima-Q4.gguf']] } } },
  VAELoader: { input: { required: { vae_name: [['ae.safetensors', 'qwen_image_vae.safetensors']] } } },
  CLIPLoader: { input: { required: { clip_name: [['qwen_2.5_vl_7b.safetensors', 'clip_l.safetensors']] } } },
  DualCLIPLoader: { input: { required: { clip_name1: [['t5xxl_fp8.safetensors', 'clip_l.safetensors']] } } },
  LoraLoader: { input: { required: { lora_name: [['style.safetensors']] } } },
  KSampler: {
    input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'simple']] } },
  },
};

describe('parseObjectInfo', () => {
  it('摘出各类文件列表;clips 取 CLIPLoader 与 DualCLIPLoader 并集去重', () => {
    const lists = parseObjectInfo(OBJECT_INFO);
    expect(lists.checkpoints).toEqual(['illu.safetensors', 'pony.safetensors']);
    expect(lists.unets).toEqual(['flux1-dev.safetensors', 'anima.safetensors']);
    expect(lists.ggufs).toEqual(['anima-Q4.gguf']);
    expect(lists.vaes).toEqual(['ae.safetensors', 'qwen_image_vae.safetensors']);
    expect(lists.clips).toEqual(['qwen_2.5_vl_7b.safetensors', 'clip_l.safetensors', 't5xxl_fp8.safetensors']);
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(lists.samplers).toEqual(['euler', 'dpmpp_2m']);
    expect(lists.schedulers).toEqual(['normal', 'simple']);
  });

  it('节点未装/形状不符时降级为空数组', () => {
    const lists = parseObjectInfo({ KSampler: { input: { required: {} } }, Broken: 42 });
    expect(lists.checkpoints).toEqual([]);
    expect(lists.ggufs).toEqual([]);
    expect(lists.samplers).toEqual([]);
  });
});

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => '' } as Response;
}

describe('fetchComfyModelLists', () => {
  it('浏览器直连成功 → 全量列表,mode=browser', async () => {
    const fetchMock = vi.fn(async (_input: unknown) => jsonResponse(OBJECT_INFO));
    vi.stubGlobal('fetch', fetchMock);
    const lists = await fetchComfyModelLists('http://127.0.0.1:8188');
    expect(lists.mode).toBe('browser');
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8188/object_info');
  });

  it('刷新模型列表能看到 ComfyUI 刚加的 LoRA，之后打开仍能看到', async () => {
    let loras = ['style.safetensors'];
    vi.stubGlobal('fetch', async () => jsonResponse({
      ...OBJECT_INFO, LoraLoader: { input: { required: { lora_name: [loras] } } },
    }));
    expect((await fetchComfyModelLists('http://a:8188')).loras).toEqual(loras);
    loras = [...loras, 'new/detail.safetensors'];
    expect((await fetchComfyModelLists('http://a:8188', { force: true })).loras).toEqual(loras);
    expect((await fetchComfyModelLists('http://a:8188')).loras).toContain('new/detail.safetensors');
  });

  it('网络级失败回退 ST 转发;loras/clips 为空,models 按 UNet:/GGUF: 前缀分类', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/object_info')) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/sd/comfy/models')) {
        return jsonResponse([
          { value: 'illu.safetensors', text: 'illu' },
          { value: 'flux1-dev.safetensors', text: 'UNet: flux1 dev' },
          { value: 'anima-Q4.gguf', text: 'GGUF: anima-Q4' },
        ]);
      }
      if (url.endsWith('/api/sd/comfy/samplers')) return jsonResponse(['euler']);
      if (url.endsWith('/api/sd/comfy/schedulers')) return jsonResponse(['simple']);
      if (url.endsWith('/api/sd/comfy/vaes')) return jsonResponse(['ae.safetensors']);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const lists = await fetchComfyModelLists('http://b:8188');
    expect(lists.mode).toBe('server');
    expect(lists.checkpoints).toEqual(['illu.safetensors']);
    expect(lists.unets).toEqual(['flux1-dev.safetensors']);
    expect(lists.ggufs).toEqual(['anima-Q4.gguf']);
    expect(lists.loras).toEqual([]);
    expect(lists.clips).toEqual([]);
    expect(lists.samplers).toEqual(['euler']);
  });

  it('HTTP 错误是服务端真实反馈,不回退转发', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchComfyModelLists('http://c:8188')).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('空 url 直接报错', async () => {
    await expect(fetchComfyModelLists('  ')).rejects.toThrow('服务地址');
  });
});
