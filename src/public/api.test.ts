import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activeTagKind, backendStatus, decideSeed, generateImage } from '@/generate';
import type { GenerationMeta } from '@/generationMeta';
import { saveExternalImage } from '@/floor/storage';
import {
  generate,
  getBackendStatus,
  getCharacters,
  publicError,
  toPublicError,
} from '@/public/api';
import {
  charTagLib,
  emptyCharFields,
  setGlobalCharTagSource,
  type CharTagEntry,
} from '@/state/charTags';
import { settings } from '@/state/settings';

vi.mock('@/generate', () => ({
  activeTagKind: vi.fn(() => 'illustration'),
  backendStatus: vi.fn(),
  decideSeed: vi.fn(() => 4242),
  generateImage: vi.fn(),
}));

vi.mock('@/floor/storage', () => ({ saveExternalImage: vi.fn(async () => '/user/images/x.png') }));

vi.mock('@/st/context', () => ({ getContext: () => ({ name2: '小雪' }) }));

function entry(overrides: Partial<CharTagEntry> = {}): CharTagEntry {
  return {
    name: '阿黛尔',
    fields: { ...emptyCharFields(), sex: '1girl', hair: 'short silver hair' },
    raw: '',
    nl: 'a girl with silver hair',
    source: 'ai',
    desc: '银色短发',
    history: [{ field: 'hair', from: '', to: 'short silver hair', reason: '', floor: 3, at: 1 }],
    ...overrides,
  };
}

function fakeResult(url = 'data:image/png;base64,AAAA') {
  return { url, filename: 'x.png', format: 'png', revoke: vi.fn() };
}

function fakeMeta(): GenerationMeta {
  return {
    backend: 'nai',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    positive: '',
    negative: '',
    artist: null,
    vibes: [],
    params: {},
  };
}

function ready(overrides: Partial<ReturnType<typeof backendStatus>> = {}) {
  vi.mocked(backendStatus).mockReturnValue({
    backend: 'nai',
    configured: true,
    model: 'nai-diffusion-4-5-full',
    supportsCharacters: true,
    reason: '',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decideSeed).mockReturnValue(4242);
  vi.mocked(activeTagKind).mockReturnValue('illustration');
  charTagLib.entries = [];
  setGlobalCharTagSource(() => []);
});

describe('getCharacters', () => {
  it('computes tag from fields via the shared builder', () => {
    charTagLib.entries = [entry()];
    expect(getCharacters().characters[0].tag).toBe('1girl, short silver hair');
  });

  it('falls back to the legacy raw string when fields are empty', () => {
    charTagLib.entries = [entry({ fields: emptyCharFields(), raw: ' 1girl, blonde ' })];
    expect(getCharacters().characters[0].tag).toBe('1girl, blonde');
  });

  it('hands out a copy: mutating the result never touches the live library', () => {
    charTagLib.entries = [entry()];
    const list = getCharacters();
    list.characters[0].name = '被改了';
    list.characters[0].fields.hair = '被改了';
    list.characters.push({ ...list.characters[0], name: '凭空多的' });

    expect(charTagLib.entries).toHaveLength(1);
    expect(charTagLib.entries[0].name).toBe('阿黛尔');
    expect(charTagLib.entries[0].fields.hair).toBe('short silver hair');
  });

  it('never leaks the change history', () => {
    charTagLib.entries = [entry()];
    expect('history' in getCharacters().characters[0]).toBe(false);
  });

  it('marks global-library-only entries as global scope', () => {
    const global = entry({ name: '全局角色' });
    setGlobalCharTagSource(() => [global]);
    charTagLib.entries = [entry(), global];

    const byName = Object.fromEntries(getCharacters().characters.map(c => [c.name, c.scope]));
    expect(byName).toEqual({ 阿黛尔: 'chat', 全局角色: 'global' });
  });

  it('rejects a non-integer floor instead of silently returning the current library', () => {
    expect(() => getCharacters({ floor: 1.5 })).toThrow(/floor/);
    try {
      getCharacters({ floor: 1.5 });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('invalid_args');
    }
  });
});

describe('getBackendStatus', () => {
  it('exposes readiness without the api key or service url', () => {
    settings.nai.endpoints[0].key = 'pst-secret-key';
    settings.nai.endpoints[0].url = 'https://image.novelai.net';
    settings.comfyui.servers[0].url = 'http://127.0.0.1:8188';
    ready();

    const status = getBackendStatus();
    // 白名单口径:内部结构日后加字段也不会静默泄漏出去
    expect(Object.keys(status).sort()).toEqual([
      'apiVersion', 'backend', 'configured', 'model', 'pluginVersion', 'reason', 'supportsCharacters',
    ]);
    const dumped = JSON.stringify(status);
    expect(dumped).not.toContain('pst-secret-key');
    expect(dumped).not.toContain('novelai.net');
    expect(dumped).not.toContain('8188');
  });

  it('passes the human-readable reason through when not configured', () => {
    ready({ configured: false, reason: '未填写 NAI API Key' });
    expect(getBackendStatus()).toMatchObject({ configured: false, reason: '未填写 NAI API Key' });
  });

  it('reports a comic plan as not configured (third parties only send illustration prompts)', async () => {
    ready({ backend: 'comfyui', supportsCharacters: false });
    vi.mocked(activeTagKind).mockReturnValue('comic');
    expect(getBackendStatus()).toMatchObject({ configured: false, reason: expect.stringContaining('漫画') });
    await expect(generate({ prompt: '1girl' })).rejects.toMatchObject({ code: 'not_configured' });
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });
});

describe('toPublicError', () => {
  it('keeps an already-coded error as-is', () => {
    const original = publicError('invalid_args', 'x');
    expect(toPublicError(original)).toBe(original);
  });

  it('reads AbortError by name, not by instanceof (third-party signals cross realms)', () => {
    const foreign = new Error('已取消');
    foreign.name = 'AbortError';
    expect(toPublicError(foreign).code).toBe('aborted');
  });

  it('separates rate limiting from other backend failures', () => {
    expect(toPublicError(new Error('NAI 请求失败 (429)')).code).toBe('rate_limited');
    expect(toPublicError(new Error('工作流 JSON 无效')).code).toBe('backend_error');
  });

  it('codes non-Error throws instead of crashing on .message', () => {
    expect(toPublicError('炸了').code).toBe('backend_error');
  });
});

describe('generate', () => {
  it('refuses an empty prompt before touching the backend', async () => {
    ready();
    await expect(generate({ prompt: '   ' })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });

  it('reports not_configured up front rather than firing a doomed request', async () => {
    ready({ configured: false, reason: '未填写 NAI API Key' });
    await expect(generate({ prompt: '1girl' })).rejects.toMatchObject({
      code: 'not_configured',
      message: '未填写 NAI API Key',
    });
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });

  it('routes through the shared generateImage so the NAI gate cannot be bypassed', async () => {
    ready();
    const result = fakeResult();
    vi.mocked(generateImage).mockResolvedValue({
      result, seed: 4242, size: 'landscape', backend: 'nai', charactersApplied: true, meta: fakeMeta(),
    });

    await generate({
      prompt: ' 1girl, moonlight ',
      nl: ' a girl ',
      negative: ' bad hands ',
      characters: [
        { name: '阿黛尔', tag: '1girl, silver hair' },
        { name: '无 tag 的', tag: '  ' },
        null as never,
      ],
      size: 'landscape',
    });

    expect(vi.mocked(generateImage).mock.calls[0][0]).toEqual({
      prompt: '1girl, moonlight',
      nl: 'a girl',
      negative: 'bad hands',
      characters: [{ name: '阿黛尔', tag: '1girl, silver hair', nl: '' }],
      size: 'landscape',
      seed: 4242,
    });
  });

  it('reports charactersApplied=false when the backend dropped them (ComfyUI)', async () => {
    ready({ backend: 'comfyui', model: '默认工作流', supportsCharacters: false });
    vi.mocked(generateImage).mockResolvedValue({
      result: fakeResult(), seed: 7, size: 'portrait', backend: 'comfyui', charactersApplied: false, meta: fakeMeta(),
    });

    const out = await generate({ prompt: '1girl', characters: [{ name: 'a', tag: 'b' }] });
    expect(out.charactersApplied).toBe(false);
    expect(out.backend).toBe('comfyui');
  });

  it('saves to the gallery by default and skips it only when told to', async () => {
    ready();
    vi.mocked(generateImage).mockResolvedValue({
      result: fakeResult(), seed: 4242, size: 'portrait', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });

    const saved = await generate({ prompt: '1girl' });
    expect(saved.path).toBe('/user/images/x.png');
    // 侧写存的是 tag 原文(含 <bbi_image> 壳),图库要拿它反解析出各字段
    const [name, tag, seed] = vi.mocked(saveExternalImage).mock.calls[0];
    expect(name).toBe('小雪');
    expect(tag).toBe('<bbi_image>1girl<size>portrait</size></bbi_image>');
    expect(seed).toBe(4242);

    vi.mocked(saveExternalImage).mockClear();
    vi.mocked(generateImage).mockResolvedValue({
      result: fakeResult(), seed: 4242, size: 'portrait', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });
    const skipped = await generate({ prompt: '1girl', save: false });
    expect(skipped.path).toBeNull();
    expect(vi.mocked(saveExternalImage)).not.toHaveBeenCalled();
  });

  it('records the size the image was actually drawn at, not the requested one (channel lock)', async () => {
    ready();
    vi.mocked(saveExternalImage).mockClear();
    // 渠道锁横图:请求要竖,generateImage 回报实际按横出
    vi.mocked(generateImage).mockResolvedValue({
      result: fakeResult(), seed: 4242, size: 'landscape', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });

    await generate({ prompt: '1girl', size: 'portrait' });
    expect(vi.mocked(generateImage).mock.calls[0][0].size).toBe('portrait');
    const [, tag] = vi.mocked(saveExternalImage).mock.calls[0];
    expect(tag).toBe('<bbi_image>1girl<size>landscape</size></bbi_image>');
  });

  it('still returns the image when saving to the gallery fails', async () => {
    ready();
    vi.mocked(generateImage).mockResolvedValue({
      result: fakeResult(), seed: 4242, size: 'portrait', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });
    vi.mocked(saveExternalImage).mockRejectedValueOnce(new Error('磁盘满了'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await generate({ prompt: '1girl' });
    expect(out.path).toBeNull();
    expect(out.dataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('revokes the blob no matter how the call ends', async () => {
    ready();
    const ok = fakeResult();
    vi.mocked(generateImage).mockResolvedValue({
      result: ok, seed: 1, size: 'portrait', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });
    await generate({ prompt: '1girl', save: false });
    expect(ok.revoke).toHaveBeenCalledTimes(1);

    const failing = fakeResult('blob:http://x/y');
    vi.mocked(generateImage).mockResolvedValue({
      result: failing, seed: 1, size: 'portrait', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(generate({ prompt: '1girl', save: false })).rejects.toMatchObject({
      code: 'backend_error',
    });
    expect(failing.revoke).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('never lets a third-party progress callback break the generation', async () => {
    ready();
    vi.mocked(generateImage).mockResolvedValue({
      result: fakeResult(), seed: 1, size: 'portrait', backend: 'nai', charactersApplied: false, meta: fakeMeta(),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      generate({ prompt: '1girl', save: false }, { onProgress: () => { throw new Error('崩'); } }),
    ).resolves.toMatchObject({ seed: 1 });
  });

  it('normalizes a cancelled generation to code=aborted', async () => {
    ready();
    const abort = new Error('已取消');
    abort.name = 'AbortError';
    vi.mocked(generateImage).mockRejectedValue(abort);
    await expect(generate({ prompt: '1girl' })).rejects.toMatchObject({ code: 'aborted' });
  });
});
