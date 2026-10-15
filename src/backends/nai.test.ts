import { describe, expect, it } from 'vitest';

import {
  applyVibes,
  buildNaiParameters,
  BUILTIN_NAI_ARTISTS,
  fullNegativePrompt,
  fullPositivePrompt,
  isBuiltinNaiArtist,
  naiArtistPrompt,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiEndpoint,
  naiRandomSeed,
  parseNaiv4vibe,
  parseResolution,
  skipCfgAboveSigma,
  unzipNaiImage,
  vibeModelKey,
  NaiError,
} from '@/backends/nai';
import type { NaiArtistPreset, NaiModel, NaiSettings, NaiVibe, NaiVibeData } from '@/state/settings';
import { strToU8, zipSync } from 'fflate';

function nai(overrides: Partial<NaiSettings> = {}): NaiSettings {
  return {
    fullPresets: [],
    activeFullPresetId: '',
    url: 'https://image.novelai.net',
    qualityTags: '',
    negativePrompt: '',
    resolution: '832×1216',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    key: 'nai-test',
    endpoints: [{ id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'nai-test' }],
    activeEndpointId: 'nep_official',
    model: 'nai-diffusion-4-5-full',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    concurrency: 1,
    vibes: [],
    artistPresets: [],
    activeArtistId: '',
    naturalLanguage: true,
    orientationLock: 'auto',
    ...overrides,
  };
}

function vibe(overrides: Partial<NaiVibe> = {}): NaiVibe {
  return {
    id: 'v1',
    name: '测试Vibe',
    dataPath: '/user/files/v1.json',
    thumbnailPath: '/user/files/v1.jpg',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: 'v4-5full:ZW5jb2Rpbmc=',
    strength: 0.6,
    enabled: true,
    group: '',
    ...overrides,
  };
}

function vibeData(overrides: Partial<NaiVibeData> = {}): NaiVibeData {
  return {
    image: 'aW1hZ2U=',
    thumbnail: '',
    encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
    ...overrides,
  };
}

describe('naiEndpoint', () => {
  it('自动补 /ai 前缀', () => {
    expect(naiEndpoint('https://image.novelai.net', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
    expect(naiEndpoint('https://mirror.example.com/', 'encode-vibe')).toBe(
      'https://mirror.example.com/ai/encode-vibe',
    );
  });

  it('base 已是完整端点时原样使用', () => {
    expect(naiEndpoint('https://x.com/proxy/ai/generate-image', 'generate-image')).toBe(
      'https://x.com/proxy/ai/generate-image',
    );
  });

  it('空地址报错', () => {
    expect(() => naiEndpoint('  ', 'generate-image')).toThrow(NaiError);
  });
});

describe('parseResolution', () => {
  it('支持 × / x / * 分隔', () => {
    expect(parseResolution('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseResolution('1024x1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('拒绝非 64 倍数与非法格式', () => {
    expect(() => parseResolution('830×1216')).toThrow(/64/);
    expect(() => parseResolution('')).toThrow(NaiError);
    expect(() => parseResolution('4096×4096')).toThrow(/范围/);
  });
});

describe('提示词拼装', () => {
  it('使用模型官方质量词并拼到提示词末尾', () => {
    const full = fullPositivePrompt(nai(), '1girl, sitting');
    expect(full).toBe('1girl, sitting, location, very aesthetic, masterpiece, no text');
  });

  it('按模型切换官方质量词', () => {
    expect(fullPositivePrompt(nai({ model: 'nai-diffusion-4-5-curated' }), '1girl')).toBe(
      '1girl, location, masterpiece, no text, -0.8::feet::, rating:general',
    );
  });

  it('负面 = 模型官方默认词', () => {
    const neg = fullNegativePrompt(nai());
    expect(neg).toContain('worst quality');
  });

  it('负面只认 undesiredContent,不再拼 negativePrompt', () => {
    // 「附加负面」已并入一个框;存量 negativePrompt 由 normalizeNai 折进 undesiredContent
    expect(fullNegativePrompt(nai({ negativePrompt: 'bad hands', undesiredContent: 'lowres' }))).toBe('lowres');
  });

  it('覆盖值优先于模型官方词(正/负各一)', () => {
    expect(fullPositivePrompt(nai({ qualityTags: 'best quality' }), '1girl')).toBe('1girl, best quality');
    expect(fullNegativePrompt(nai({ undesiredContent: 'only this' }))).toBe('only this');
  });

  it('覆盖值留空 = 跟随模型官方词(切模型内容跟着换)', () => {
    // 这是「空串 = 跟随官方」这条存储口径的核心契约
    const asFull = fullPositivePrompt(nai({ qualityTags: '', model: 'nai-diffusion-3' }), '1girl');
    expect(asFull).toBe('1girl, best quality, amazing quality, very aesthetic, absurdres');
    expect(fullNegativePrompt(nai({ undesiredContent: '', model: 'nai-diffusion-3' }))).toContain('{bad}');
  });

  it('纯空白覆盖值等同留空', () => {
    expect(fullPositivePrompt(nai({ qualityTags: '   ' }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ undesiredContent: '  \n ' }))).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('未知模型无官方词时回落空串,不抛', () => {
    expect(naiDefaultQualityTags('nai-diffusion-9')).toBe('');
    expect(naiDefaultUndesired('nai-diffusion-9')).toBe('');
    const odd = nai({ model: 'nai-diffusion-9' as NaiSettings['model'] });
    expect(fullPositivePrompt(odd, '1girl')).toBe('1girl');
    expect(fullNegativePrompt(odd)).toBe('');
  });
});

describe('画师串拼装', () => {
  const preset = (prompt: string, id = 'art_a', extra: Partial<NaiArtistPreset> = {}): NaiArtistPreset => ({
    id,
    name: 'A',
    prompt,
    quality: '',
    negative: '',
    ...extra,
  });

  it('空库 / 未选 → 输出与本功能上线前逐字节一致(存量用户零变化)', () => {
    expect(fullPositivePrompt(nai(), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('画师串拼在最前:画师串 → 画面 tag → 质量词', () => {
    const s = nai({
      artistPresets: [preset('artist:wlop, artist:krenz')],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl, sitting')).toBe(
      'artist:wlop, artist:krenz, 1girl, sitting, location, very aesthetic, masterpiece, no text',
    );
  });

  it('activeArtistId 悬空 → 不使用,绝不回落第一条(那会静默给用户换一套画风)', () => {
    const s = nai({ artistPresets: [preset('artist:a')], activeArtistId: 'art_gone' });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('选中条目内容全空白 → 等同不使用,不留前导逗号', () => {
    // '   ' 是 truthy,filter(Boolean) 兜不住,故 naiArtistPrompt 内部必须 trim
    const s = nai({ artistPresets: [preset('   ')], activeArtistId: 'art_a' });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('与自定义质量词共存,顺序仍是 画师串 → tag → 质量词', () => {
    const s = nai({
      qualityTags: 'best quality',
      artistPresets: [preset('artist:a')],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, best quality');
  });

  it('naiArtistPrompt 三态:空库 / 悬空 / 选中(选中时首尾空白被去掉)', () => {
    expect(naiArtistPrompt(nai())).toBe('');
    expect(naiArtistPrompt(nai({ artistPresets: [preset('artist:a')], activeArtistId: 'art_x' }))).toBe('');
    expect(
      naiArtistPrompt(nai({ artistPresets: [preset(' artist:a ')], activeArtistId: 'art_a' })),
    ).toBe('artist:a');
  });

  it('多条只取选中那一条,不串味', () => {
    const s = nai({
      artistPresets: [preset('artist:a', 'art_a'), preset('artist:b', 'art_b')],
      activeArtistId: 'art_b',
    });
    expect(naiArtistPrompt(s)).toBe('artist:b');
  });
});

describe('配方绑定正/负面词(解析链:配方 → 渠道 → 官方)', () => {
  const preset = (extra: Partial<NaiArtistPreset>): NaiArtistPreset => ({
    id: 'art_a',
    name: 'A',
    prompt: 'artist:a',
    quality: '',
    negative: '',
    ...extra,
  });
  const withPreset = (extra: Partial<NaiArtistPreset>, rest: Partial<NaiSettings> = {}) =>
    nai({ artistPresets: [preset(extra)], activeArtistId: 'art_a', ...rest });

  it('配方绑定的质量词/负面词优先于渠道覆盖值与官方词', () => {
    const s = withPreset(
      { quality: 'recipe quality', negative: 'recipe negative' },
      { qualityTags: 'channel quality', undesiredContent: 'channel negative' },
    );
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, recipe quality');
    expect(fullNegativePrompt(s)).toBe('recipe negative');
  });

  it('配方字段留空 → 跟随渠道覆盖值', () => {
    const s = withPreset({}, { qualityTags: 'channel quality', undesiredContent: 'channel negative' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('配方与渠道都留空 → 模型官方词(与本功能上线前逐字节一致)', () => {
    const s = withPreset({});
    expect(fullPositivePrompt(s, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('只绑定其一:另一个照常回落', () => {
    const s = withPreset({ negative: 'recipe negative' }, { qualityTags: 'channel quality' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('recipe negative');
  });

  it('纯空白绑定值 = 未绑定,继续向下回落', () => {
    const s = withPreset(
      { quality: '   ', negative: ' \n ' },
      { qualityTags: 'channel quality', undesiredContent: 'channel negative' },
    );
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('activeArtistId 悬空 → 配方字段一并失效,走渠道/官方', () => {
    const s = nai({
      artistPresets: [preset({ quality: 'recipe quality', negative: 'recipe negative' })],
      activeArtistId: 'art_gone',
      qualityTags: 'channel quality',
      undesiredContent: 'channel negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('切换配方 = 正/负面词一起切换(需求的核心契约)', () => {
    const s = nai({
      artistPresets: [
        preset({ id: 'art_a', quality: 'q a', negative: 'n a' }),
        preset({ id: 'art_b', prompt: 'artist:b', quality: 'q b', negative: 'n b' }),
      ],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, q a');
    expect(fullNegativePrompt(s)).toBe('n a');
    s.activeArtistId = 'art_b';
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:b, 1girl, q b');
    expect(fullNegativePrompt(s)).toBe('n b');
    // 切到「不使用」→ 回落渠道/官方
    s.activeArtistId = '';
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });
});

describe('NAI V5 support', () => {
  it('uses official model defaults and params_version 4', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated'] as const) {
      expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
      expect(naiDefaultUndesired(model)).toContain('dithering, halftone, screentone');
      const params = buildNaiParameters(nai({ model }), { prompt: '1girl', seed: 42 });
      expect(params.params_version).toBe(4);
      expect(params.v4_prompt).toBeTruthy();
      expect(params.skip_cfg_above_sigma).toBeNull();
      expect(params.sampler).toBe('k_euler');
    }
    const fallback = buildNaiParameters(nai({ model: 'nai-diffusion-5-full', sampler: 'ddim_v3' }), {
      prompt: '1girl',
      seed: 42,
    });
    expect(fallback.sampler).toBe('k_euler_ancestral');
  });

  it('V5 Full 默认负面只排缺陷,不再禁题材/风格/身材/画师', () => {
    // 老版在官方基线上串过一大串社区词,把 chibi、大胸、暗调、具体画师名等都禁了,
    // 会跟正向词与画师串长期打架(原作者已声明弃用)。这里锁死:通用默认不碰题材偏好。
    const neg = naiDefaultUndesired('nai-diffusion-5-full');
    // 官方基线原样保留(V5 调参依赖它,面板也靠这段认出「未自定义」)
    expect(neg).toContain('worst quality, bad quality, jpeg artifacts');
    expect(neg).toContain('dithering, halftone, screentone');
    for (const banned of [
      'chibi',
      'large breasts',
      'huge breasts',
      'dark',
      'high contrast',
      'artist:',
      'artist collaboration',
      '4koma',
      'oekaki',
      'black face',
      'extra people',
      'honey',
      'tight pants',
      'childish',
    ]) {
      expect(neg).not.toContain(banned);
    }
  });

  it('maps Base Tag + NL and native Character Prompts into the V5 caption schema', () => {
    const settings = nai({
      model: 'nai-diffusion-5-full',
      qualityTags: 'very aesthetic',
      artistPresets: [{ id: 'artist', name: 'Artist', prompt: 'artist:test', quality: '', negative: '' }],
      activeArtistId: 'artist',
    });
    const params = buildNaiParameters(settings, {
      prompt: '2girls, classroom, sunset',
      nl: 'Two girls in a sunset classroom.',
      characters: [
        { name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left, waving.' },
        { name: 'B', tag: 'girl, silver hair, red dress', nl: '' },
      ],
      seed: 42,
    });
    const positive = params.v4_prompt as {
      caption: { base_caption: string; char_captions: Array<{ char_caption: string; centers: unknown[] }> };
      use_coords: boolean;
      use_order: boolean;
    };
    const negative = params.v4_negative_prompt as {
      caption: { char_captions: Array<{ char_caption: string; centers: unknown[] }> };
    };
    expect(positive.caption.base_caption).toBe(
      'artist:test, 2girls, classroom, sunset, very aesthetic. Two girls in a sunset classroom.',
    );
    expect(positive.caption.char_captions).toEqual([
      { char_caption: 'girl, black hair, white dress. On the left, waving.', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: 'girl, silver hair, red dress', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(negative.caption.char_captions).toEqual([
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(positive.use_coords).toBe(false);
    expect(positive.use_order).toBe(true);
  });

  it('uses model-specific V5 vibe encodings', () => {
    expect(vibeModelKey('nai-diffusion-5-full')).toBe('v5full');
    expect(vibeModelKey('nai-diffusion-5-curated')).toBe('v5curated');
    const settings = nai({ model: 'nai-diffusion-5-full', vibes: [vibe({ name: 'V5 vibe' })] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const data = vibeData({ encodings: { v5full: { encoding: 'djU=', infoExtracted: 1 } } });
    expect(applyVibes(params, settings, new Map([['v1', data]])).skipped).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([
      { cache_secret_key: expect.any(String), data: 'djU=' },
    ]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  // 回归锁:char_captions 所在字段本就叫 v4_prompt,这套结构是 V4 时代的协议,V5 只是继承。
  // 曾经按 isNai5 卡过,4.5 明明支持却一条角色提示都发不出去(角色外貌全糊进 Base)。
  // 边界在 4.5 而非整个 v4 系:自然语言是 4.5 引入的,原版 NAI4 只吃 tag。
  it('sends native Character Prompts on 4.5 as well as V5, but not on plain NAI 4', () => {
    const values = {
      prompt: '2girls, classroom',
      nl: 'Two girls in a classroom.',
      characters: [{ name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left.' }],
      seed: 1,
    };
    const captionsOf = (model: NaiModel) =>
      (
        buildNaiParameters(nai({ model }), values).v4_prompt as {
          caption: { base_caption: string; char_captions: Array<{ char_caption: string }> };
        }
      ).caption;

    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions.map(c => c.char_caption)]).toEqual([
        model,
        ['girl, black hair, white dress. On the left.'],
      ]);
      // nl 拼接同样开放到 4.5:句点分隔接在 tag 串之后
      expect([model, caption.base_caption.endsWith('. Two girls in a classroom.')]).toEqual([model, true]);
    }

    // 原版 NAI4 保持单串形态:角色提示与 nl 都不发
    for (const model of ['nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions]).toEqual([model, []]);
      expect([model, caption.base_caption.includes('Two girls in a classroom.')]).toEqual([model, false]);
    }
  });
});

describe('buildNaiParameters', () => {
  it('v4 系带 v4_prompt 结构', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 42 });
    expect(p.seed).toBe(42);
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
    const v4 = p.v4_prompt as { caption: { base_caption: string }; use_order: boolean };
    expect(v4.caption.base_caption).toContain('1girl');
    expect(v4.use_order).toBe(true);
    expect(p.reference_image_multiple_cached).toEqual([]);
    expect(p.v4_negative_prompt).toBeTruthy();
    expect(p.ucPreset).toBe(3);
    expect(p.qualityToggle).toBe(true);
  });

  it('NAI3 不带 v4 结构,带原图参考数组与 sm 开关', () => {
    const p = buildNaiParameters(nai({ model: 'nai-diffusion-3' }), { prompt: '1girl', seed: 1 });
    expect(p.v4_prompt).toBeUndefined();
    expect(p.reference_image_multiple).toEqual([]);
    expect(p.reference_information_extracted_multiple).toEqual([]);
    expect(p.sm).toBe(false);
    expect(p.reference_image_multiple_cached).toBeUndefined();
  });

  it('v4_prompt 的 base_caption 与 fullPositivePrompt 同源(含画师串)', () => {
    // 顶层 input(generateNaiImage)与 parameters.v4_prompt 各拼一次的话,NAI3 读 input、
    // NAI4/4.5 读 v4_prompt,两者会拿到不同提示词且只在 NAI3 上暴露。此断言把「同源」钉死:
    // 任何拼装改动都必须留在 fullPositivePrompt 内部,不能在调用点单独加料。
    const s = nai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: '', negative: '' }],
      activeArtistId: 'art_a',
    });
    const p = buildNaiParameters(s, { prompt: '1girl', seed: 1 });
    const v4 = p.v4_prompt as { caption: { base_caption: string } };
    expect(v4.caption.base_caption).toBe(fullPositivePrompt(s, '1girl'));
    expect(v4.caption.base_caption.startsWith('artist:a, 1girl')).toBe(true);
  });

  it('k_euler_ancestral 附加 brownian 修正', () => {
    const p = buildNaiParameters(nai({ sampler: 'k_euler_ancestral' }), { prompt: 'x', seed: 1 });
    expect(p.prefer_brownian).toBe(true);
    expect(p.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('横屏画面取横屏尺寸,skip_cfg_above_sigma 随像素量同步变化', () => {
    const portrait = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    const landscape = buildNaiParameters(nai(), { prompt: '2girls', seed: 1, size: 'landscape' });
    expect(landscape.width).toBe(1216);
    expect(landscape.height).toBe(832);
    // 832×1216 与 1216×832 像素量相同,sigma 也应相同(证明它确实按尺寸推导)
    expect(landscape.skip_cfg_above_sigma).toBe(portrait.skip_cfg_above_sigma);

    const bigLandscape = buildNaiParameters(nai({ landscapeSize: '1536×1024' }), {
      prompt: '2girls',
      seed: 1,
      size: 'landscape',
    });
    expect(bigLandscape.width).toBe(1536);
    expect(Number(bigLandscape.skip_cfg_above_sigma)).toBeGreaterThan(
      Number(portrait.skip_cfg_above_sigma),
    );
  });

  it('缺 size 时按竖屏出图(与改动前的固定默认一致)', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('对应方向未填时回落内置竖屏默认', () => {
    const p = buildNaiParameters(nai({ landscapeSize: '' }), { prompt: 'x', seed: 1, size: 'landscape' });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('固定种子优先于随机', () => {
    const p = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x' });
    expect(p.seed).toBe(123);
    const p2 = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x', seed: 7 });
    expect(p2.seed).toBe(7);
  });
});

describe('skipCfgAboveSigma', () => {
  it('关 variety 时为 null', () => {
    expect(skipCfgAboveSigma(832, 1216, 'nai-diffusion-4-5-full', false)).toBeNull();
  });

  it('4.5 用 58,其余用 19', () => {
    const v45 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-5-full', true)!;
    const v4 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-full', true)!;
    expect(v45 / v4).toBeCloseTo(58 / 19, 5);
  });
});

describe('applyVibes', () => {
  it('NAI4/4.5:编码数据进 cached,强度并进 strength 数组', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(params, nai({ vibes: [vibe()] }), new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    // 随图记录的是面板配置强度与实际发送强度
    expect(applied).toEqual([
      { id: 'v1', name: '测试Vibe', group: '', strength: 0.6, effectiveStrength: 0.6 },
    ]);
    const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].data).toBe('ZW5jb2Rpbmc=');
    expect(cached[0].cache_secret_key).toBeTruthy();
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('缺当前模型编码的 vibe 被跳过并返回名字', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(
      params,
      nai({ vibes: [vibe({ name: '旧模型Vibe', modelKeys: ['v3'] })] }),
      new Map([['v1', vibeData({ encodings: { v3: { encoding: 'eQ==', infoExtracted: 1 } } })]]),
    );
    expect(skipped).toEqual(['旧模型Vibe']);
    expect(applied).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([]);
  });

  it('强度总和超过 1 且开归一化时按比例压回 1', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied } = applyVibes(
      params,
      nai({
        vibes: [vibe({ id: 'a', strength: 0.8 }), vibe({ id: 'b', strength: 0.6 })],
      }),
      new Map([
        ['a', vibeData()],
        ['b', vibeData()],
      ]),
    );
    const strengths = params.reference_strength_multiple as number[];
    expect(strengths[0] + strengths[1]).toBeCloseTo(1, 6);
    // 记录里配置值保持原样，实际发送值反映归一化结果
    expect(applied.map(v => v.strength)).toEqual([0.8, 0.6]);
    expect(applied[0].effectiveStrength).toBeCloseTo(0.8 / 1.4, 6);
    expect(applied[1].effectiveStrength).toBeCloseTo(0.6 / 1.4, 6);
  });

  it('NAI3:参考原图进 reference_image_multiple', () => {
    const settings = nai({ model: 'nai-diffusion-3', vibes: [vibe()] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const { skipped } = applyVibes(params, settings, new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    expect(params.reference_image_multiple).toEqual(['aW1hZ2U=']);
    expect(params.reference_information_extracted_multiple).toEqual([1]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('未启用的 vibe 不参与', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    applyVibes(params, nai({ vibes: [vibe({ enabled: false })] }), new Map([['v1', vibeData()]]));
    expect(params.reference_image_multiple_cached).toEqual([]);
  });
});

describe('vibeModelKey', () => {
  it('按模型映射官方 key', () => {
    expect(vibeModelKey('nai-diffusion-4-5-full')).toBe('v4-5full');
    expect(vibeModelKey('nai-diffusion-4-5-curated')).toBe('v4-5curated');
    expect(vibeModelKey('nai-diffusion-4-full')).toBe('v4full');
    expect(vibeModelKey('nai-diffusion-4-curated-preview')).toBe('v4curated');
    expect(vibeModelKey('nai-diffusion-3')).toBe('v3');
  });
});

describe('parseNaiv4vibe', () => {
  it('解析官方格式', () => {
    const text = JSON.stringify({
      identifier: 'novelai-vibe-transfer',
      version: 1,
      image: 'aW1hZ2U=',
      name: 'abc123-def456',
      thumbnail: 'data:image/png;base64,xx',
      encodings: {
        'v4-5full': {
          k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
        },
      },
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1, strength: 0.7 },
    });
    const v = parseNaiv4vibe(text);
    expect(v.name).toBe('abc123-def456');
    expect(v.encodings['v4-5full'].encoding).toBe('ZW5jb2Rpbmc=');
    expect(v.strength).toBe(0.7);
  });

  it('缺 strength 字段回落 0.6,不静默变成强度 0', () => {
    // 回归:旧实现走 Number(v),而 Number(null) / Number('') 都是 0 ——
    // vibe 会以「强度 0」导入,挂上了却对画面毫无影响,且极难排查。
    const build = (importInfo: unknown) =>
      JSON.stringify({
        identifier: 'novelai-vibe-transfer',
        version: 1,
        image: 'aW1hZ2U=',
        encodings: {
          'v4-5full': {
            k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
          },
        },
        importInfo,
      });
    expect(parseNaiv4vibe(build({ model: 'nai-diffusion-4-5-full' })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: null })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: '' })).strength).toBe(0.6);
  });

  it('拒绝非 vibe JSON', () => {
    expect(() => parseNaiv4vibe('{"foo":1}')).toThrow(/标识/);
    expect(() => parseNaiv4vibe('not json')).toThrow(NaiError);
  });
});

describe('unzipNaiImage', () => {
  it('解出 zip 内第一张图', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = unzipNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('非 zip 数据报友好错误', () => {
    expect(() => unzipNaiImage(strToU8('not a zip').buffer as ArrayBuffer)).toThrow(NaiError);
  });
});

describe('naiRandomSeed', () => {
  it('32 位无符号整数', () => {
    const s = naiRandomSeed();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

describe('内置画师串配方(只读、随版本更新、不进 settings)', () => {
  it('用户库为空时,activeArtistId 命中内置库', () => {
    const s = nai({ artistPresets: [], activeArtistId: 'bi_default' });
    expect(naiArtistPrompt(s)).toBe(BUILTIN_NAI_ARTISTS[0].prompt.trim());
    expect(fullPositivePrompt(s, '1girl')).toBe(
      `${BUILTIN_NAI_ARTISTS[0].prompt.trim()}, 1girl, location, very aesthetic, masterpiece, no text`,
    );
  });

  it('内置配方的 quality/negative 走同一回落链:留空 → 渠道覆盖值', () => {
    // 内置条目当前不绑定正/负面词;这里锁住「留空 = 跟随渠道」的口径,
    // 以后给内置条目加绑定时这条测试会提醒检查链行为。
    const s = nai({
      artistPresets: [],
      activeArtistId: 'bi_default',
      qualityTags: 'channel quality',
      undesiredContent: 'channel negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toContain('channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('isBuiltinNaiArtist:bi_ 前缀命中,用户条目(art_*)不命中', () => {
    expect(isBuiltinNaiArtist('bi_default')).toBe(true);
    expect(isBuiltinNaiArtist('art_abc')).toBe(false);
    expect(isBuiltinNaiArtist('')).toBe(false);
  });

  it('activeArtistId 指向不存在的内置 id(如下线后)→ 不加画师串', () => {
    const s = nai({ artistPresets: [], activeArtistId: 'bi_gone' });
    expect(naiArtistPrompt(s)).toBe('');
  });
});
