import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
const mocks = vi.hoisted(() => ({ context: null as Record<string, any> | null }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));

describe('专用世界书独立持久化', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });
  it('旧配置默认关闭，已有酒馆书单不被修改', async () => {
    const selected = ['Normal'];
    mocks.context = { extensionSettings: { baibai_image: {} }, saveSettingsDebounced: vi.fn(), selectedWorldInfo: selected };
    const { hydrateSettings, settings } = await import('./settings');
    await hydrateSettings();
    expect(settings.worldBooks).toEqual({ enabled: false, names: [] });
    expect(selected).toEqual(['Normal']);
  });
  it('载入时清理无效书名并去重，修改后保存到柏宝绘自身设置', async () => {
    mocks.context = {
      extensionSettings: { baibai_image: { worldBooks: { enabled: true, names: [' A ', '', 'A', 7, 'B'] } } },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, settings } = await import('./settings');
    await hydrateSettings();
    expect(settings.worldBooks).toEqual({ enabled: true, names: ['A', 'B'] });
    settings.worldBooks.names.push('C');
    await nextTick();
    expect(mocks.context!.extensionSettings.baibai_image.worldBooks.names).toEqual(['A', 'B', 'C']);
    expect(mocks.context!.extensionSettings.baibai_exclude_settings ?? {}).not.toHaveProperty('worldBooks');
  });
});
