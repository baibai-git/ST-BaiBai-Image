import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTagGenSelection } from './presetMode';

const mocks = vi.hoisted(() => ({
  available: null as boolean | null,
  settings: {
    assignments: {
      tagGen: '',
    },
    apiPresets: {
      mainApi: {
        mode: 'named-preset' as 'independent' | 'current-preset' | 'named-preset',
        presetName: '专用预设',
      },
      channels: {} as Record<string, { mode: 'independent' | 'current-preset' | 'named-preset'; presetName: string }>,
    },
  },
}));

vi.mock('@/api/client', () => ({
  isStPresetAvailable: vi.fn(() => mocks.available),
}));

vi.mock('@/state/settings', () => ({
  settings: mocks.settings,
}));

describe('指定预设失效回退', () => {
  beforeEach(() => {
    mocks.available = null;
    mocks.settings.assignments.tagGen = '';
    mocks.settings.apiPresets.mainApi = { mode: 'named-preset', presetName: '专用预设' };
    mocks.settings.apiPresets.channels = {};
  });

  it('确认预设仍存在时保持指定预设模式', () => {
    mocks.available = true;
    expect(resolveTagGenSelection()).toEqual({
      mode: 'named-preset',
      presetName: '专用预设',
      removedPreset: '',
    });
  });

  it('确认预设被删除时自动切换独立模式并清除失效名称', () => {
    mocks.available = false;
    expect(resolveTagGenSelection()).toEqual({ mode: 'independent', removedPreset: '专用预设' });
    expect(mocks.settings.apiPresets.mainApi).toEqual({ mode: 'independent', presetName: '' });
  });

  it('TH 未加载或列表读取失败时不误判删除', () => {
    mocks.available = null;
    expect(resolveTagGenSelection().mode).toBe('named-preset');
    expect(mocks.settings.apiPresets.mainApi.presetName).toBe('专用预设');
  });

  it('副 API 使用自己的预设配置，不继承主 API 设置', () => {
    mocks.available = true;
    mocks.settings.assignments.tagGen = 'ch_1';
    mocks.settings.apiPresets.mainApi = { mode: 'independent', presetName: '' };
    mocks.settings.apiPresets.channels.ch_1 = { mode: 'named-preset', presetName: '渠道专用预设' };
    expect(resolveTagGenSelection()).toEqual({
      mode: 'named-preset',
      presetName: '渠道专用预设',
      removedPreset: '',
    });
  });

  it('副渠道预设被删时只清该渠道配置，不改主 API 的模式', () => {
    mocks.available = false;
    mocks.settings.assignments.tagGen = 'ch_1';
    mocks.settings.apiPresets.mainApi = { mode: 'current-preset', presetName: '' };
    mocks.settings.apiPresets.channels.ch_1 = { mode: 'named-preset', presetName: '已删除' };
    expect(resolveTagGenSelection()).toEqual({ mode: 'independent', removedPreset: '已删除' });
    expect(mocks.settings.apiPresets.channels.ch_1).toBeUndefined();
    expect(mocks.settings.apiPresets.mainApi.mode).toBe('current-preset');
  });

  it('尚未选择预设不是删除事件，保留模式供用户补选', () => {
    mocks.available = false;
    mocks.settings.apiPresets.mainApi.presetName = '';
    expect(resolveTagGenSelection()).toEqual({ mode: 'named-preset', presetName: '', removedPreset: '' });
  });
});
