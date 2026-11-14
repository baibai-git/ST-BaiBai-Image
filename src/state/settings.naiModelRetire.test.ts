import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 4.5 以下的 NAI 模型下线(NAI_MODELS 只留 4.5/V5)后的存量处理。
 *
 * 关键点:白名单收窄会**改写**用户存着的模型 —— 画风、Anlas 消耗与 vibe 编码 key 全变。
 * 这是有意接受的代价(那批模型已基本无人使用),所以这里锁的不是「别改」,而是
 * 「只改该改的那些、且留下痕迹」:在列模型一个字节都不许动,下线模型必须回落到
 * 默认模型并打一条 console.warn(否则「我的模型自己变了」这类反馈无据可查)。
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithModel(model: unknown) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai: { model } } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('NAI 旧模型下线后的存量模型处理', () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    warn = vi.fn();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('console', { ...console, warn });
  });

  it.each(['nai-diffusion-3', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'])(
    '已下线的 %s 回落到默认模型,并留一条告警',
    async retired => {
      const settings = await hydrateWithModel(retired);
      expect(settings.nai.plans[0].model).toBe('nai-diffusion-5-full');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(retired));
    },
  );

  it.each([
    'nai-diffusion-5-full',
    'nai-diffusion-5-full-medium',
    'nai-diffusion-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
  ])('在列的 %s 原样保留,不打扰', async kept => {
    const settings = await hydrateWithModel(kept);
    expect(settings.nai.plans[0].model).toBe(kept);
    expect(warn).not.toHaveBeenCalled();
  });

  it('压根没存过模型的配置走默认值,不算「被下线」', async () => {
    const settings = await hydrateWithModel(undefined);
    expect(settings.nai.plans[0].model).toBe('nai-diffusion-5-full');
    expect(warn).not.toHaveBeenCalled();
  });
});
