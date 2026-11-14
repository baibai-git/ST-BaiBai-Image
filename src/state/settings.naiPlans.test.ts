import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 出图方案库:老渠道级平铺设置 → 「默认方案」的迁移,以及方案引用的修复与解析。
 *
 * 看点:
 * 1. 迁移的唯一目标是**升级后出图零变化**:老的平铺字段原样进默认方案;老的
 *    「画师串绑定词 → 渠道值 → 官方词」三级回落,把当时实际生效的那份抄进方案;
 *    老 vibe 的逐张 enabled 折成方案的 vibeIds。
 * 2. 已有 plans 就不再迁移:顶层残留的老平铺字段一概不看(迁移只跑一次)。
 * 3. 三种引用的悬空口径各不相同:接入点回落第一条(地址是必需品)、画师串清空
 *    (回落等于静默换画风)、vibe 逐条剔除。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

const OFFICIAL = 'https://image.novelai.net';

function vibe(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, dataPath: `/user/files/${id}.json`, modelKeys: ['v4-5full'], strength: 0.6, ...extra };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
});

describe('老渠道级设置 → 默认方案', () => {
  it('平铺字段原样折进唯一一套「默认方案」,并被选中', async () => {
    const { settings } = await hydrateWithNai({
      url: 'https://nai.example.org',
      key: 'sk-x',
      model: 'nai-diffusion-4-5-curated',
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      sampler: 'k_dpmpp_2m',
      steps: 33,
      scale: 6,
      cfgRescale: 0.2,
      noiseSchedule: 'exponential',
      seed: 123,
      varietyBoost: false,
      normalizeRefStrength: false,
      naturalLanguage: false,
      orientationLock: 'portrait',
      portraitSize: '896×1152',
      landscapeSize: '1152×896',
      concurrency: 2,
    });
    expect(settings.nai.plans).toHaveLength(1);
    const plan = settings.nai.plans[0];
    expect(settings.nai.activePlanId).toBe(plan.id);
    expect(plan).toMatchObject({
      name: '默认方案',
      // 老的第三方地址收成接入点第一条,方案引用它
      endpointId: settings.nai.endpoints[0].id,
      model: 'nai-diffusion-4-5-curated',
      artistId: '',
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      sampler: 'k_dpmpp_2m',
      steps: 33,
      scale: 6,
      cfgRescale: 0.2,
      noiseSchedule: 'exponential',
      seed: 123,
      varietyBoost: false,
      normalizeRefStrength: false,
      vibeIds: [],
      naturalLanguage: false,
      orientationLock: 'portrait',
      portraitSize: '896×1152',
      landscapeSize: '1152×896',
    });
    expect(settings.nai.endpoints[0]).toMatchObject({ url: 'https://nai.example.org', key: 'sk-x' });
    // 并发是接入点(站/账号)的事,不随方案走:老的全局值落到当时在用的那条上
    expect(settings.nai.endpoints[0].concurrency).toBe(2);
    expect(settings.nai).not.toHaveProperty('concurrency');
    // 不留平铺影子字段:唯一真相在方案里
    expect(settings.nai).not.toHaveProperty('model');
    expect(settings.nai).not.toHaveProperty('steps');
  });

  it('当时选中的画师串绑了正/负面词 → 绑定值抄进方案(老规则里它压过渠道值)', async () => {
    const { settings, effectiveNai } = await hydrateWithNai({
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: ' bound q ', negative: 'bound n' }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.plans[0]).toMatchObject({
      artistId: 'art_a',
      qualityTags: 'bound q',
      undesiredContent: 'bound n',
    });
    // 画师串条目本身的绑定词保留,但出图只看方案的框
    expect(settings.nai.artistPresets[0].quality).toBe(' bound q ');
    expect(effectiveNai().qualityTags).toBe('bound q');
  });

  it('只绑了一边 → 另一边仍取渠道值;画师串没选中时绑定词不参与', async () => {
    const half = await hydrateWithNai({
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      artistPresets: [{ id: 'art_a', name: 'A', prompt: '', quality: '', negative: 'bound n' }],
      activeArtistId: 'art_a',
    });
    expect(half.settings.nai.plans[0]).toMatchObject({ qualityTags: 'channel q', undesiredContent: 'bound n' });

    vi.resetModules();
    const off = await hydrateWithNai({
      qualityTags: '',
      artistPresets: [{ id: 'art_a', name: 'A', prompt: '', quality: 'bound q', negative: '' }],
      activeArtistId: '',
    });
    // 空串 = 跟随官方词,是老配置的真实状态,不能被没选中的画师串顶掉
    expect(off.settings.nai.plans[0].qualityTags).toBe('');
  });

  it('老 vibe 的 enabled 折成方案的 vibeIds,条目本身不再带开关', async () => {
    const { settings, effectiveNai } = await hydrateWithNai({
      vibes: [vibe('v1', { enabled: true }), vibe('v2', { enabled: false }), vibe('v3', { enabled: true })],
    });
    expect(settings.nai.plans[0].vibeIds).toEqual(['v1', 'v3']);
    expect(settings.nai.vibes.every(v => !('enabled' in v))).toBe(true);
    expect(effectiveNai().vibes.map(v => v.id)).toEqual(['v1', 'v3']);
  });

  it('老配置里悬空的 activeEndpointId / activeArtistId 照新规则修', async () => {
    const { settings } = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_gone',
      activeArtistId: 'art_gone',
    });
    expect(settings.nai.plans[0].endpointId).toBe('nep_a');
    expect(settings.nai.plans[0].artistId).toBe('');
  });
});

describe('已是方案格式', () => {
  it('原样保留,当前方案不被动;顶层残留的老平铺字段不再迁移', async () => {
    const { settings } = await hydrateWithNai({
      model: 'nai-diffusion-4-5-curated', // 回滚往返留下的老字段,不该再覆盖方案
      endpoints: [{ id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'k' }],
      plans: [
        { id: 'np_a', name: '厚涂', model: 'nai-diffusion-4-5-full', steps: 30 },
        { id: 'np_b', name: '赛璐璐', model: 'nai-diffusion-5-full', scale: 4 },
      ],
      activePlanId: 'np_b',
    });
    expect(settings.nai.plans.map(p => p.name)).toEqual(['厚涂', '赛璐璐']);
    expect(settings.nai.plans.map(p => p.model)).toEqual(['nai-diffusion-4-5-full', 'nai-diffusion-5-full']);
    expect(settings.nai.plans[0].steps).toBe(30);
    expect(settings.nai.plans[1].scale).toBe(4);
    expect(settings.nai.activePlanId).toBe('np_b');
  });

  it('三种引用各按各的口径修:接入点回落第一条、画师串清空、vibe 逐条剔除', async () => {
    const { settings } = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      vibes: [vibe('v1'), vibe('v2')],
      plans: [
        { id: 'np_a', endpointId: 'nep_gone', artistId: 'art_gone', vibeIds: ['v2', 'v_gone', 'v2', 42] },
        { id: 'np_b', endpointId: 'nep_official', artistId: 'bi_default', vibeIds: [] },
        { id: 'np_c', endpointId: 'nep_a', artistId: 'art_a', vibeIds: ['v1'] },
      ],
      activePlanId: 'np_a',
    });
    const [a, b, c] = settings.nai.plans;
    expect(a).toMatchObject({ endpointId: 'nep_a', artistId: '', vibeIds: ['v2'] });
    // 内置画师串不在用户库里也不算悬空;补回的官方接入点照样认得
    expect(b).toMatchObject({ endpointId: 'nep_official', artistId: 'bi_default' });
    expect(c).toMatchObject({ endpointId: 'nep_a', artistId: 'art_a', vibeIds: ['v1'] });
  });

  it('activePlanId 悬空 → 回落第一套;plans 是空数组 → 补一套出厂方案,不重跑迁移', async () => {
    const dangling = await hydrateWithNai({
      plans: [{ id: 'np_a', name: 'A' }, { id: 'np_b', name: 'B' }],
      activePlanId: 'np_gone',
    });
    expect(dangling.settings.nai.activePlanId).toBe('np_a');

    vi.resetModules();
    const empty = await hydrateWithNai({ plans: [], model: 'nai-diffusion-4-5-curated', steps: 40 });
    expect(empty.settings.nai.plans).toHaveLength(1);
    // 空数组是脏数据而非「还没迁移」:顶层老字段不该被折进来
    expect(empty.settings.nai.plans[0]).toMatchObject({ model: 'nai-diffusion-5-full', steps: 28 });
    expect(empty.settings.nai.activePlanId).toBe(empty.settings.nai.plans[0].id);
  });

  it('条目缺字段/含脏数据 → 逐项补齐,名字按序号给', async () => {
    const { settings } = await hydrateWithNai({
      plans: [null, { id: 'np_b', steps: 999, orientationLock: 'sideways', model: 'nai-diffusion-2' }],
    });
    const [first, second] = settings.nai.plans;
    expect(first.id).toMatch(/^nplan_/);
    expect(first.name).toBe('方案 1');
    expect(second.name).toBe('方案 2');
    expect(second.steps).toBe(50);
    expect(second.orientationLock).toBe('auto');
    expect(second.model).toBe('nai-diffusion-5-full');
  });
});

describe('方案引用的解析', () => {
  it('naiArtistFor:用户库 → 内置库 → 悬空返回 null(不兜底成第一条)', async () => {
    const { naiArtistFor, newNaiPlan } = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      plans: [{ id: 'np_a' }],
    });
    const plan = newNaiPlan();
    plan.artistId = 'art_a';
    expect(naiArtistFor(plan)?.prompt).toBe('artist:a');
    plan.artistId = 'bi_default';
    expect(naiArtistFor(plan)?.id).toBe('bi_default');
    plan.artistId = 'art_gone';
    expect(naiArtistFor(plan)).toBeNull();
    plan.artistId = '';
    expect(naiArtistFor(plan)).toBeNull();
  });

  it('effectiveNai(plan):各方案各取各的接入点与 vibe,vibe 按库内顺序', async () => {
    const { settings, effectiveNai } = await hydrateWithNai({
      endpoints: [
        { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
        { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
      ],
      vibes: [vibe('v1'), vibe('v2'), vibe('v3')],
      plans: [
        { id: 'np_a', endpointId: 'nep_a', vibeIds: ['v3', 'v1'], steps: 30 },
        { id: 'np_b', endpointId: 'nep_official', vibeIds: [], steps: 20 },
      ],
      activePlanId: 'np_b',
    });
    const [a, b] = settings.nai.plans;
    expect(effectiveNai(a)).toMatchObject({ url: 'https://a.example', key: 'ka', steps: 30 });
    expect(effectiveNai(a).vibes.map(v => v.id)).toEqual(['v1', 'v3']);
    // 缺省取当前方案
    expect(effectiveNai()).toMatchObject({ url: OFFICIAL, key: 'ko', steps: 20, vibes: [] });
    expect(effectiveNai(b)).toEqual(effectiveNai());
  });

  it('切当前方案即整套切换:接入点、参数、vibe 一起变', async () => {
    const { settings, effectiveNai, activeNaiEndpoint } = await hydrateWithNai({
      endpoints: [
        { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
        { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
      ],
      vibes: [vibe('v1')],
      plans: [
        { id: 'np_a', endpointId: 'nep_a', vibeIds: ['v1'], model: 'nai-diffusion-4-5-full' },
        { id: 'np_b', endpointId: 'nep_official', model: 'nai-diffusion-5-full' },
      ],
      activePlanId: 'np_a',
    });
    expect(activeNaiEndpoint().id).toBe('nep_a');
    settings.nai.activePlanId = 'np_b';
    expect(activeNaiEndpoint().id).toBe('nep_official');
    expect(effectiveNai()).toMatchObject({ model: 'nai-diffusion-5-full', vibes: [] });
  });
});
