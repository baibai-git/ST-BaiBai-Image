import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
  listeners: new Map<string, Array<() => void>>(),
  dispatched: [] as string[],
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

function setupWindowStub() {
  mocks.listeners.clear();
  mocks.dispatched.length = 0;
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, cb: () => void) => {
      const list = mocks.listeners.get(type) ?? [];
      list.push(cb);
      mocks.listeners.set(type, list);
    }),
    dispatchEvent: vi.fn((event: { type?: string }) => {
      if (event?.type) mocks.dispatched.push(event.type);
    }),
  });
  vi.stubGlobal(
    'CustomEvent',
    class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  );
}

async function hydrateWith(extensionSettings: Record<string, any>) {
  mocks.context = {
    extensionSettings,
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('API 预设模式共享存储（baibai_api_preset_settings）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    setupWindowStub();
  });

  it('无共享存储且默认全独立时，不创建空共享存储，保持消费者模式', async () => {
    const ext: Record<string, any> = {
      baibai_image: {
        assignments: { tagGen: 'ch_1' },
        channels: [{ id: 'ch_1', name: '渠道1', url: 'https://example.com', model: 'm' }],
      },
    };
    const state = await hydrateWith(ext);
    expect(state.assignments).toEqual({ tagGen: 'ch_1' });
    expect(state.apiPresets).toEqual({
      mainApi: { mode: 'independent', presetName: '' },
      channels: {},
    });
    expect(ext.baibai_api_preset_settings).toBeUndefined();
  });

  it('从共享存储领养主 API 与副渠道预设配置，并清理已删渠道残留与非法值', async () => {
    const ext: Record<string, any> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 2,
        channels: [{ id: 'ch_live', name: '在线渠道', url: 'https://example.com', model: 'm' }],
      },
      baibai_api_preset_settings: {
        schemaVersion: 1,
        revision: 5,
        mainApi: { mode: 'named-preset', presetName: '主用预设' },
        channels: {
          ch_live: { mode: 'current-preset', presetName: '非指定模式忽略名称' },
          ch_gone: { mode: 'named-preset', presetName: '残留预设' },
          ch_bad: { mode: 'unknown', presetName: '非法模式' },
        },
      },
    };
    const state = await hydrateWith(ext);
    expect(state.apiPresets).toEqual({
      mainApi: { mode: 'named-preset', presetName: '主用预设' },
      channels: {
        ch_live: { mode: 'current-preset', presetName: '' },
      },
    });
  });

  it('修改预设配置时写入独立共享存储并广播，且不污染 baibai_api_channels 渠道对象', async () => {
    const ext: Record<string, any> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 1,
        channels: [{ id: 'ch_1', name: '渠道1', url: 'https://example.com', model: 'm' }],
      },
    };
    const state = await hydrateWith(ext);

    state.apiPresets.mainApi = { mode: 'current-preset', presetName: '' };
    state.apiPresets.channels.ch_1 = { mode: 'named-preset', presetName: '专用生图预设' };
    await nextTick();

    expect(ext.baibai_api_preset_settings).toMatchObject({
      schemaVersion: 1,
      mainApi: { mode: 'current-preset', presetName: '' },
      channels: {
        ch_1: { mode: 'named-preset', presetName: '专用生图预设' },
      },
    });
    expect(mocks.dispatched).toContain('st-baibai-api-preset-settings:changed');
    // 共享渠道对象不被写入任何预设字段，旧版柏宝书 normalizeChannel 不会产生冲突或抹掉数据
    expect(Object.keys(ext.baibai_api_channels.channels[0])).not.toContain('tagGenMode');
    expect(Object.keys(ext.baibai_api_channels.channels[0])).not.toContain('presetMode');
  });

  it('收到其他柏宝插件广播时实时同步最新预设配置；其他插件修改渠道列表不会影响独立预设存储', async () => {
    const ext: Record<string, any> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 1,
        channels: [{ id: 'ch_1', name: '渠道1', url: 'https://example.com', model: 'm' }],
      },
      baibai_api_preset_settings: {
        schemaVersion: 1,
        revision: 1,
        mainApi: { mode: 'independent', presetName: '' },
        channels: {
          ch_1: { mode: 'current-preset', presetName: '' },
        },
      },
    };
    const state = await hydrateWith(ext);

    // 模拟旧版柏宝书编辑并回写 baibai_api_channels（改了模型名，但完全不认识预设键）
    ext.baibai_api_channels = {
      schemaVersion: 1,
      revision: 2,
      channels: [{ id: 'ch_1', name: '渠道1', url: 'https://example.com', model: 'new-model' }],
    };
    for (const cb of mocks.listeners.get('st-baibai-api-channels:changed') ?? []) cb();
    expect(state.channels[0].model).toBe('new-model');
    expect(state.apiPresets.channels.ch_1).toEqual({ mode: 'current-preset', presetName: '' });

    // 模拟新版兄弟插件更新了独立共享存储并广播事件
    ext.baibai_api_preset_settings = {
      schemaVersion: 1,
      revision: 2,
      mainApi: { mode: 'named-preset', presetName: '全员预设' },
      channels: {
        ch_1: { mode: 'named-preset', presetName: '新渠道预设' },
      },
    };
    for (const cb of mocks.listeners.get('st-baibai-api-preset-settings:changed') ?? []) cb();
    expect(state.apiPresets).toEqual({
      mainApi: { mode: 'named-preset', presetName: '全员预设' },
      channels: {
        ch_1: { mode: 'named-preset', presetName: '新渠道预设' },
      },
    });
  });

  it('其他插件删除渠道后，广播同步自动清理对应渠道的预设配置', async () => {
    const ext: Record<string, any> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 1,
        channels: [{ id: 'ch_1', name: '渠道1', url: 'https://example.com', model: 'm' }],
      },
      baibai_api_preset_settings: {
        schemaVersion: 1,
        revision: 1,
        mainApi: { mode: 'independent', presetName: '' },
        channels: {
          ch_1: { mode: 'current-preset', presetName: '' },
        },
      },
    };
    const state = await hydrateWith(ext);

    ext.baibai_api_channels = { schemaVersion: 1, revision: 2, channels: [] };
    for (const cb of mocks.listeners.get('st-baibai-api-channels:changed') ?? []) cb();
    expect(state.apiPresets.channels.ch_1).toBeUndefined();
  });
});
