import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 接入点库(地址 + 密钥)的存量折叠与脏数据处理。
 *
 * 起因是「公益站换着用」:同一套出图参数,要在多个出口之间切。故只有 url/key 随条目走,
 * 模型/采样器/尺寸/vibe/画师串一概留在渠道级 —— 换站不该逼人重配一遍参数。
 *
 * 与画师串库**相反**的两条口径(与工作流库同侧),是本文件的主要看点:
 * 1. 库恒非空,且恒含内置官方那条:地址是必需品,空了直接出不了图;
 * 2. activeEndpointId 悬空回落 endpoints[0],**不**清空。画师串回落等于静默换画风
 *    (每张图都变样却查不出),接入点回落只是换个出口、出错会当场报连接失败,代价不对等。
 *
 * 另有一条只属于这里:官方条的 url 由 normalize 强制纠回,手改 settings.json 也拗不过。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: nai === undefined ? {} : { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

const OFFICIAL = 'https://image.novelai.net';

describe('NAI 接入点库 · 存量折叠', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('nai 键整个缺失 → 只有官方那一条,且被选中', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].url).toBe(OFFICIAL);
    expect(settings.nai.activeEndpointId).toBe('nep_official');
  });

  it('存量用官方地址 → key 折进官方那条,**不**多出一条重复项', async () => {
    const settings = await hydrateWithNai({ url: OFFICIAL, key: 'nai-old' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('nai-old');
    expect(settings.nai.activeEndpointId).toBe('nep_official');
  });

  it('存量地址留空 → 同样折进官方那条(空地址不值得单开一行)', async () => {
    const settings = await hydrateWithNai({ url: '', key: 'nai-old' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('nai-old');
  });

  it('存量地址带尾斜杠的官方 → 视作官方,仍折成一条', async () => {
    const settings = await hydrateWithNai({ url: `${OFFICIAL}/`, key: 'k' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('k');
  });

  it('存量用第三方站 → 收成第一条并保持选中,官方条**追加在后**', async () => {
    // 顺序是刻意的:官方排前面会把用户正在用的出口挤到第二行,看起来像被换掉了。
    const settings = await hydrateWithNai({ url: 'https://nai.example.org', key: 'sk-x' });
    expect(settings.nai.endpoints.map(e => e.url)).toEqual(['https://nai.example.org', OFFICIAL]);
    expect(settings.nai.endpoints[0].key).toBe('sk-x');
    expect(settings.nai.activeEndpointId).toBe(settings.nai.endpoints[0].id);
    expect(settings.nai.endpoints[1].id).toBe('nep_official');
  });

  it('迁移后旧字段原样留着(回滚用,不参与出图)', async () => {
    const settings = await hydrateWithNai({ url: 'https://nai.example.org', key: 'sk-x' });
    expect(settings.nai.key).toBe('sk-x');
    expect(settings.nai.url).toBe('https://nai.example.org');
  });

  it('迁移幂等:已是新格式就原样保留,当前项不被动', async () => {
    const first = await hydrateWithNai({
      endpoints: [
        { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
        { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
      ],
      activeEndpointId: 'nep_a',
    });
    expect(first.nai.endpoints.map(e => e.id)).toEqual(['nep_a', 'nep_official']);
    expect(first.nai.endpoints[0].name).toBe('公益站 A');
    expect(first.nai.endpoints[0].key).toBe('ka');
    expect(first.nai.activeEndpointId).toBe('nep_a');
  });
});

describe('NAI 接入点库 · 恒非空与官方条不变式', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('官方条被手工删掉 → 自动补回(库里永远有一个能用的出口)', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_a',
    });
    expect(settings.nai.endpoints.map(e => e.id)).toEqual(['nep_a', 'nep_official']);
    // 补回来不抢选中:用户当前用的还是 A
    expect(settings.nai.activeEndpointId).toBe('nep_a');
  });

  it('官方条的 url 被手改 → 强制纠回官方地址', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_official', name: '假官方', url: 'https://evil.example', key: 'k' }],
      activeEndpointId: 'nep_official',
    });
    expect(settings.nai.endpoints[0].url).toBe(OFFICIAL);
    // 名字也归回内置名(官方条不可改名,脏数据同样纠正);key 是用户自己的,保留
    expect(settings.nai.endpoints[0].name).toBe('NovelAI 官方');
    expect(settings.nai.endpoints[0].key).toBe('k');
  });

  it('endpoints 是空数组 → 按「没有新格式」走存量折叠,而不是留空库', async () => {
    const settings = await hydrateWithNai({ endpoints: [], url: 'https://a.example', key: 'ka' });
    expect(settings.nai.endpoints.map(e => e.url)).toEqual(['https://a.example', OFFICIAL]);
  });

  it('activeEndpointId 悬空 → 回落第一条,**不**清成空串', async () => {
    const settings = await hydrateWithNai({
      endpoints: [
        { id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' },
        { id: 'nep_b', name: 'B', url: 'https://b.example', key: 'kb' },
      ],
      activeEndpointId: 'nep_gone',
    });
    expect(settings.nai.activeEndpointId).toBe('nep_a');
    expect(settings.nai.endpoints).toHaveLength(3); // A、B、补回的官方
  });

  it('activeEndpointId 不是字符串 → 同样回落第一条', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 42,
    });
    expect(settings.nai.activeEndpointId).toBe('nep_a');
  });

  it('条目缺字段/含脏数据 → 逐项补齐,不整条丢弃', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ name: 'no id' }, null, { id: 'nep_c', url: 42, key: null }],
      activeEndpointId: 'nep_c',
    });
    const [first, second, third] = settings.nai.endpoints;
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('接入点 2');
    expect(second.url).toBe('');
    // 非字符串归空串;有效 id 仍被 activeEndpointId 认到
    expect(third.url).toBe('');
    expect(third.key).toBe('');
    expect(settings.nai.activeEndpointId).toBe('nep_c');
  });

  it('连续新建接入点不会把不同条目当成同一条', async () => {
    const { newNaiEndpoint } = await import('@/state/settings');
    const ids = [newNaiEndpoint(), newNaiEndpoint(), newNaiEndpoint()].map(e => e.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('effectiveNai:出图只认当前接入点', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('url/key 取当前条,其余出图参数一律沿用渠道级(换站不用重配)', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            url: 'https://legacy.example',
            key: 'legacy-key',
            model: 'nai-diffusion-4-5-full',
            steps: 33,
            endpoints: [
              { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
              { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
            ],
            activeEndpointId: 'nep_a',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, effectiveNai, settings } = await import('@/state/settings');
    await hydrateSettings();

    const conn = effectiveNai();
    expect(conn.url).toBe('https://a.example');
    expect(conn.key).toBe('ka');
    // 渠道级参数原样带过来,不因换站而变
    expect(conn.model).toBe('nai-diffusion-4-5-full');
    expect(conn.steps).toBe(33);

    // 切回官方:同一套参数,换个出口
    settings.nai.activeEndpointId = 'nep_official';
    expect(effectiveNai().url).toBe(OFFICIAL);
    expect(effectiveNai().key).toBe('ko');
    expect(effectiveNai().steps).toBe(33);
  });

  it('运行中把 activeEndpointId 改坏 → activeNaiEndpoint 回落第一条,不返回 undefined', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_a',
    });
    const { activeNaiEndpoint } = await import('@/state/settings');
    settings.nai.activeEndpointId = 'nep_gone';
    expect(activeNaiEndpoint().id).toBe('nep_a');
  });
});
