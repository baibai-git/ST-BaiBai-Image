import type { ChatMsg } from '@/api/client';
import { randomUuid } from '@/randomUuid';
import type { STContext } from '@/st/context';

export interface LlmPresetEntry {
  id: string;
  name: string;
  role: ChatMsg['role'];
  content: string;
  enabled: boolean;
  triggerMode: 'always' | 'trigger';
  triggerWords: string;
  andTriggerWords: string;
}

export interface LlmPreset {
  id: string;
  name: string;
  entries: LlmPresetEntry[];
  /** 仅用于本次请求的变量覆盖，不写入聊天变量。 */
  variables: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function presetVariables(value: unknown): Record<string, string> {
  const obj = record(value);
  if (!obj || Object.values(obj).some(v => typeof v !== 'string')) {
    throw new Error('变量必须是 JSON 对象，变量名和值都用字符串');
  }
  return Object.fromEntries(Object.entries(obj)) as Record<string, string>;
}

function normalizePreset(value: unknown, name: string, preserveId = false): LlmPreset {
  const obj = record(value);
  if (!obj || !Array.isArray(obj.entries)) throw new Error(`预设「${name}」缺少 entries 数组`);
  const entries = obj.entries.map((value, index): LlmPresetEntry => {
    const e = record(value);
    if (!e || typeof e.content !== 'string') throw new Error(`「${name}」第 ${index + 1} 条缺少 content 文本`);
    if (e.role !== undefined && !['system', 'user', 'assistant'].includes(String(e.role))) {
      throw new Error(`「${name}」第 ${index + 1} 条 role 必须为 system/user/assistant`);
    }
    if (e.triggerMode !== undefined && e.triggerMode !== 'always' && e.triggerMode !== 'trigger') {
      throw new Error(`「${name}」第 ${index + 1} 条 triggerMode 必须为 always/trigger`);
    }
    return {
      id: typeof e.id === 'string' ? e.id : randomUuid(),
      name: typeof e.name === 'string' ? e.name : `条目 ${index + 1}`,
      role: (e.role ?? 'user') as ChatMsg['role'],
      content: e.content,
      enabled: e.enabled !== false,
      triggerMode: e.triggerMode === 'trigger' ? 'trigger' : 'always',
      triggerWords: typeof e.triggerWords === 'string' ? e.triggerWords : '',
      andTriggerWords: typeof e.andTriggerWords === 'string' ? e.andTriggerWords : '',
    };
  });
  return {
    id: preserveId && typeof obj.id === 'string' ? obj.id : randomUuid(),
    name: name.trim() || '自定义预设', entries,
    variables: obj.variables === undefined ? {} : presetVariables(obj.variables),
  };
}

/** st-chatu8 单个/整组上下文预设导出，以及配置包中的上下文预设。整批校验后再写入。 */
export function importLlmPresets(raw: string, fallbackName = '自定义预设'): LlmPreset[] {
  const root = record(JSON.parse(raw.replace(/^\uFEFF/, '')));
  if (!root) throw new Error('预设文件必须是 JSON 对象');
  if (Array.isArray(root.entries)) {
    return [normalizePreset(root, typeof root.name === 'string' ? root.name : fallbackName)];
  }
  const profiles = record(root.context_presets ?? root.test_context_profiles ?? root.context_profiles) ?? root;
  const pairs = Object.entries(profiles);
  if (!pairs.length) throw new Error('文件中没有 LLM 预设');
  return pairs.map(([name, value]) => normalizePreset(value, name));
}

/** 存储坏了一条仅丢弃该条；旧配置没有预设则保留内置行为。 */
export function hydrateLlmPresets(value: unknown): LlmPreset[] {
  if (!Array.isArray(value)) return [];
  const presets: LlmPreset[] = [];
  for (const item of value) {
    try {
      const obj = record(item);
      const preset = normalizePreset(item, typeof obj?.name === 'string' ? obj.name : '', true);
      if (presets.some(p => p.id === preset.id)) preset.id = randomUuid();
      presets.push(preset);
    } catch { /* Ignore only invalid stored presets. */ }
  }
  return presets;
}

export function exportLlmPresets(presets: LlmPreset[]): string {
  // Object.fromEntries safely handles names such as __proto__.
  return JSON.stringify(Object.fromEntries(presets.map(p => [p.name, {
    entries: p.entries, variables: p.variables,
  }])), null, 2);
}

function triggerMatches(words: string, text: string): boolean {
  // 与 st-chatu8 一致：英文逗号分隔、区分大小写的子串 OR。
  return words.split(',').map(w => w.trim()).filter(Boolean).some(w => text.includes(w));
}

function variableValue(variables: unknown, name: string): string | undefined {
  const vars = record(variables);
  if (!vars) return undefined;
  let value: unknown = Object.hasOwn(vars, name) ? vars[name] : undefined;
  if (value === undefined) {
    value = name.split('.').reduce<unknown>((v, key) => {
      const obj = record(v);
      return obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
    }, vars);
  }
  return value === undefined || value === null ? undefined
    : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export interface PresetPromptData {
  context: STContext;
  body: string;
  previous: string;
  worldInfo: string;
  library: string;
  userDemand: string;
  maxImages: number;
  triggerText: string;
}

export function buildLlmPresetMessages(preset: LlmPreset, data: PresetPromptData): ChatMsg[] {
  const macros: Record<string, string> = {
    正文: data.body, 正文信息: data.body, bodyText: data.body, contextText: data.body,
    上下文: data.previous, context: data.previous, 楼层信息: data.body,
    世界书: data.worldInfo, 世界书触发: data.worldInfo, worldbook: data.worldInfo,
    用户需求: data.userDemand, userDemand: data.userDemand,
    角色启用列表: data.library, 通用角色启用列表: data.library,
    // 服装并不在柏宝绘固定外貌库中，交给模型从正文/角色设定提取。
    通用服装启用列表: '', char: data.context.name2, user: data.context.name1,
  };
  const readVariable = (name: string) => variableValue(preset.variables, name)
    ?? variableValue(data.context.chatMetadata.variables, name)
    ?? (name === '生图数量' ? String(data.maxImages) : '');
  return preset.entries.filter(e => e.enabled && e.content.trim() && (
    e.triggerMode !== 'trigger' || (triggerMatches(e.triggerWords, data.triggerText)
      && (!e.andTriggerWords.trim() || triggerMatches(e.andTriggerWords, data.triggerText)))
  )).map(e => {
    // 单遍替换，正文/世界书里含宏时不会作为预设代码再次展开。
    const content = e.content.replace(/\{@getvar::([^@]+)@\}|\{\{getvar::([^}]+)\}\}|\{\{([^{}]+)\}\}/g,
      (token, custom: string | undefined, standard: string | undefined, macro: string | undefined) => {
        if (custom !== undefined || standard !== undefined) return readVariable((custom ?? standard!).trim());
        return Object.hasOwn(macros, macro!) ? macros[macro!] : data.context.substituteParams?.(token) ?? token;
      });
    return { role: e.role, content };
  });
}
