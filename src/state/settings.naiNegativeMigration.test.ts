import { beforeEach, describe, expect, it, vi } from 'vitest';

import { naiDefaultUndesired } from '@/backends/nai';

/**
 * 「附加负面」并入负面提示词一个框后的存量迁移。
 * 关键点:老配置里的 negativePrompt 若不搬进 undesiredContent,升级后会静默失效——
 * 用户当初排除掉的内容会悄悄回到画面里,而 UI 上看不出任何异常。
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
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('负面提示词并框迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量附加负面折进负面提示词,按当年顺序:附加在前 + 官方词在后', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-full',
      negativePrompt: 'bad hands',
    });
    expect(settings.nai.plans[0].undesiredContent).toBe(`bad hands, ${naiDefaultUndesired('nai-diffusion-4-5-full')}`);
    // 搬完不留影子字段:方案里只有一个负面框
    expect(settings.nai.plans[0]).not.toHaveProperty('negativePrompt');
  });

  it('折进去时用的是该配置自己的模型,不是默认模型', async () => {
    // 与默认模型(5-full)不同的另一个在列模型:已下线的旧模型会被白名单改写成默认,
    // 那样就测不出「用的是谁的模型」了。
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-curated',
      negativePrompt: 'bad hands',
    });
    expect(settings.nai.plans[0].undesiredContent).toBe(
      `bad hands, ${naiDefaultUndesired('nai-diffusion-4-5-curated')}`,
    );
  });

  it('已有 undesiredContent 时不动它(迁移只跑一次,不会重复追加)', async () => {
    const settings = await hydrateWithNai({ undesiredContent: 'mine only', negativePrompt: 'bad hands' });
    expect(settings.nai.plans[0].undesiredContent).toBe('mine only');
  });

  it('已迁移过、且用户有意清空成跟随官方 → 保持空串,不被再折一次', async () => {
    const settings = await hydrateWithNai({ undesiredContent: '', negativePrompt: 'bad hands' });
    expect(settings.nai.plans[0].undesiredContent).toBe('');
  });

  it('没有存量附加负面 → 留空(跟随模型官方词)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full' });
    expect(settings.nai.plans[0].undesiredContent).toBe('');
  });
});
