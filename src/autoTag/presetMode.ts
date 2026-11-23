import { isStPresetAvailable } from '@/api/client';
import { settings, type TagGenMode } from '@/state/settings';

export interface TagGenSelection {
  mode: TagGenMode;
  presetName?: string;
  /** 本次发现并已移除的失效预设名;没有回退为空串。 */
  removedPreset: string;
}

/**
 * 解析本次 tag 生成方式。指定预设被明确删除时自动回到独立模式,让生成仍可继续;
 * TH 未加载/列表读取失败返回 null,不能把它当成“预设不存在”而改掉用户选择。
 */
export function resolveTagGenSelection(): TagGenSelection {
  const channelId = settings.assignments.tagGen;
  const prefs = channelId ? settings.apiPresets.channels[channelId] : settings.apiPresets.mainApi;
  const mode = prefs?.mode ?? 'independent';
  if (mode !== 'named-preset') return { mode, removedPreset: '' };

  const presetName = prefs?.presetName ?? '';
  // 尚未选择是配置未完成,不是“旧预设被删”;保留模式让请求层提示用户选择。
  if (!presetName || isStPresetAvailable(presetName) !== false) {
    return { mode, presetName, removedPreset: '' };
  }

  if (channelId) delete settings.apiPresets.channels[channelId];
  else settings.apiPresets.mainApi = { mode: 'independent', presetName: '' };
  return { mode: 'independent', removedPreset: presetName };
}
