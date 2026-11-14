import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 画师串库的存量与脏数据处理。
 *
 * 与 ComfyUI 工作流库**刻意相反**的三条,是本文件的主要看点:
 * 1. 库允许为空,`naiDefaults` 也不播种任何条目——画师串是可选调味,
 *    凭空塞一条会让人以为自己被套了某种画风;
 * 2. 方案的 `artistId` 悬空时清成空串,**不**回落第一条。回落等于给用户静默换一套画风,
 *    而下拉显示的正是那一条(看起来就是自己设的),几乎无法排查;
 * 3. 老配置升级后正向提示词输出必须逐字节不变(老 activeArtistId 折成默认方案的 artistId)。
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

describe('NAI 画师串库', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量配置没有这两个键 → 空库 + 不使用,不抛(升级后出图提示词零变化)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.plans[0].artistId).toBe('');
  });

  it('nai 键整个缺失 → 同样是空库 + 不使用', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.plans[0].artistId).toBe('');
  });

  it('新格式原样保留,当前项不被动(迁移幂等)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: '厚涂', prompt: 'artist:wlop', quality: 'masterpiece', negative: 'lowres' },
        { id: 'art_b', name: '赛璐璐', prompt: 'artist:as109', quality: '', negative: '' },
      ],
      activeArtistId: 'art_b',
    });
    expect(settings.nai.artistPresets.map(a => a.id)).toEqual(['art_a', 'art_b']);
    expect(settings.nai.artistPresets.map(a => a.name)).toEqual(['厚涂', '赛璐璐']);
    expect(settings.nai.artistPresets[0].quality).toBe('masterpiece');
    expect(settings.nai.artistPresets[0].negative).toBe('lowres');
    expect(settings.nai.plans[0].artistId).toBe('art_b');
  });

  it('存量条目没有绑定的正/负面词键 → 补空串,老渠道级值留在方案兼容字段', async () => {
    // 绑定字段上线前的老数据只有 id/name/prompt;补空串让实际出图回落官方词,
    // 老渠道值仅作数据保留,不再插入「画师串 → 官方」之间。
    const settings = await hydrateWithNai({
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_a',
    });
    const preset = settings.nai.artistPresets[0];
    expect(preset.quality).toBe('');
    expect(preset.negative).toBe('');
    // 画师串没绑词 → 方案照抄老渠道级覆盖值(仅供兼容,不参与出图)
    expect(settings.nai.plans[0].qualityTags).toBe('channel q');
    expect(settings.nai.plans[0].undesiredContent).toBe('channel n');
  });

  it('绑定字段是非字符串脏数据 → 归空串,不整条丢弃', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: 42, negative: null }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets[0].quality).toBe('');
    expect(settings.nai.artistPresets[0].negative).toBe('');
    expect(settings.nai.plans[0].artistId).toBe('art_a');
  });

  it('previewPath:合法字符串保留,缺失/脏数据视为无预览', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: 'A', prompt: '', previewPath: '/user/images/柏宝绘_画师串/art_a.jpg' },
        { id: 'art_b', name: 'B', prompt: '' },
        { id: 'art_c', name: 'C', prompt: '', previewPath: 42 },
        { id: 'art_d', name: 'D', prompt: '', previewPath: '' },
      ],
      activeArtistId: '',
    });
    const [a, b, c, d] = settings.nai.artistPresets;
    expect(a.previewPath).toBe('/user/images/柏宝绘_画师串/art_a.jpg');
    expect(b.previewPath).toBeUndefined();
    expect(c.previewPath).toBeUndefined();
    expect(d.previewPath).toBeUndefined();
  });

  it('当前项指向已删条目 → 清成空串,**不**回落第一条', async () => {
    // 与 normalizeComfyUI 的「悬空回落 workflows[0]」刻意不同:那里工作流是必需品,
    // 这里回落会给用户静默套上一套没选过的画风,每张图都变样却查不出原因。
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_gone',
    });
    expect(settings.nai.plans[0].artistId).toBe('');
    // 库本身不受影响,条目还在
    expect(settings.nai.artistPresets).toHaveLength(1);
  });

  it('库为空数组但 id 非空 → id 清空,库保持空(不补条目,与工作流库的恒非空相反)', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'art_x' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.plans[0].artistId).toBe('');
  });

  it('activeArtistId 不是字符串 → 清成空串', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 42,
    });
    expect(settings.nai.plans[0].artistId).toBe('');
  });

  it('条目缺字段/含脏数据 → 逐项补齐,不整条丢弃', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ name: 'no id' }, null, { id: 'art_c', prompt: 42 }],
      activeArtistId: 'art_c',
    });

    expect(settings.nai.artistPresets).toHaveLength(3);
    const [first, second, third] = settings.nai.artistPresets;
    // 缺 id 的补一个,名字保留
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    // null 条目也补齐成可用的空槽位,名字按序号给
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('画师串 2');
    expect(second.prompt).toBe('');
    // 非字符串 prompt 归空串;有效 id 仍被老 activeArtistId(折进方案)认到
    expect(third.prompt).toBe('');
    expect(settings.nai.plans[0].artistId).toBe('art_c');
  });

  it('prompt 是空串的条目照样保留(那是用户面对的空槽位,不是垃圾数据)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: '待填', prompt: '' }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets).toHaveLength(1);
    expect(settings.nai.plans[0].artistId).toBe('art_a');
  });

  it('activeNaiArtist 取当前方案引用的那条;未选 / 悬空时返回 null', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            artistPresets: [
              { id: 'art_a', name: 'A', prompt: 'artist:a' },
              { id: 'art_b', name: 'B', prompt: 'artist:b' },
            ],
            activeArtistId: 'art_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeNaiArtist, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeNaiArtist()?.name).toBe('B');
    expect(activeNaiArtist()?.prompt).toBe('artist:b');

    // 切到「不使用」
    settings.nai.plans[0].artistId = '';
    expect(activeNaiArtist()).toBeNull();

    // 悬空(UI 运行中把库改坏这种时序)也返回 null,而不是兜底成第一条
    settings.nai.plans[0].artistId = 'art_gone';
    expect(activeNaiArtist()).toBeNull();
  });

  it('newNaiArtist 连续调用 id 不重复(同一毫秒内也不撞)', async () => {
    const { newNaiArtist } = await import('@/state/settings');
    const ids = [newNaiArtist(), newNaiArtist(), newNaiArtist()].map(a => a.id);
    expect(new Set(ids).size).toBe(3);
    // art_ 前缀不与 wf_ / ch_ 的 id 空间相撞
    expect(ids.every(id => id.startsWith('art_'))).toBe(true);
  });
});

describe('内置画师串(bi_*)与新老用户', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('全新安装(没有任何已存设置)→ 默认启用内置「默认画师串」', async () => {
    // 默认只在这条路径生效:stored 整个不存在时,模块级默认值直接被写进 extension_settings。
    mocks.context = {
      extensionSettings: {},
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();
    expect(settings.nai.plans[0].artistId).toBe('bi_default');
    expect(settings.nai.artistPresets).toEqual([]); // 用户库仍为空:内置条不进 settings
  });

  it('老用户:已存的 activeArtistId 原样折进方案(空串 = 不使用,不会被默认值顶掉)', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-full',
      artistPresets: [],
      activeArtistId: '',
    });
    expect(settings.nai.plans[0].artistId).toBe('');
  });

  it('老用户的存量 nai 段没有 activeArtistId 键 → 空串,不吃新装默认', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.plans[0].artistId).toBe('');
  });

  it('选中内置条目的配置:用户库为空也不算悬空,normalize 不清掉', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'bi_default' });
    expect(settings.nai.plans[0].artistId).toBe('bi_default');
  });

  it('bi_ 前缀但 id 不存在(内置条目下线后)→ 仍按悬空清成空串', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'bi_gone' });
    expect(settings.nai.plans[0].artistId).toBe('');
  });
});
