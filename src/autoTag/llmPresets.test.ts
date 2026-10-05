import { describe, expect, it } from 'vitest';
import { buildLlmPresetMessages, exportLlmPresets, hydrateLlmPresets, importLlmPresets } from '@/autoTag/llmPresets';
import type { STContext } from '@/st/context';

const sample = {
  夜景: { entries: [
    { role: 'system', content: '拍摄规则', enabled: true },
    { role: 'assistant', content: '已就绪', enabled: true },
    { role: 'system', content: '不应发送', enabled: false },
    { role: 'system', content: '常亮', enabled: true, triggerMode: 'trigger', triggerWords: '灯,烛', andTriggerWords: '室内,屋' },
    { role: 'user', content: '{{正文}}|{{上下文}}|{{世界书触发}}|{{用户需求}}|{@getvar::生图数量@}|{{getvar::年龄}}|{@getvar::人物.颜色@}|{{char}}' },
  ] },
};
const data = {
  context: { name1: '用户', name2: '角色', chatMetadata: { variables: { 年龄: 25, 人物: { 颜色: '蓝' } } } } as unknown as STContext,
  body: '角色走进室内，打开灯。{{char}}', previous: '傍晚', worldInfo: '现代城市',
  library: '外貌库', userDemand: '画夜景', maxImages: 2, triggerText: '角色走进室内，打开灯。',
};

describe('st-chatu8 LLM presets', () => {
  it('preserves message roles/order, skips disabled entries, and requires both trigger groups', () => {
    const [preset] = importLlmPresets(JSON.stringify(sample));
    const messages = buildLlmPresetMessages(preset, data);
    expect(messages.map(m => m.role)).toEqual(['system', 'assistant', 'system', 'user']);
    expect(messages.map(m => m.content)).toContain('常亮');
    expect(buildLlmPresetMessages(preset, { ...data, triggerText: '户外的灯' }).map(m => m.content)).not.toContain('常亮');
    expect(buildLlmPresetMessages(preset, { ...data, triggerText: '' }).map(m => m.content)).not.toContain('常亮');
  });

  it('expands context macros once, chat variables and request-only overrides', () => {
    const [preset] = importLlmPresets(JSON.stringify(sample));
    preset.variables = { 年龄: '30' };
    expect(buildLlmPresetMessages(preset, data).at(-1)?.content)
      .toBe('角色走进室内，打开灯。{{char}}|傍晚|现代城市|画夜景|2|30|蓝|角色');
    expect(data.context.chatMetadata.variables).toEqual({ 年龄: 25, 人物: { 颜色: '蓝' } });
  });

  it('imports a named bundle or single preset and round-trips all entry flags/variables', () => {
    const [p] = importLlmPresets(JSON.stringify({ test_context_profiles: sample }));
    p.variables = { 色温: '冷' };
    const [copy] = importLlmPresets(exportLlmPresets([p]));
    expect(copy.name).toBe(p.name);
    expect(copy.entries).toEqual(p.entries);
    expect(copy.variables).toEqual(p.variables);
    expect(copy.id).not.toBe(p.id);
    expect(importLlmPresets(JSON.stringify({ entries: sample.夜景.entries }), '单个')[0].name).toBe('单个');
  });

  it('rejects malformed mixed imports atomically, and hydrates valid saved presets only', () => {
    expect(() => importLlmPresets(JSON.stringify({ ...sample, 坏预设: { entries: [{ content: 4 }] } }))).toThrow('content');
    expect(() => importLlmPresets('[]')).toThrow('JSON 对象');
    expect(() => importLlmPresets('{"API":{"api_key":"do-not-import"}}')).toThrow('entries');
    const [p] = importLlmPresets(JSON.stringify(sample));
    expect(hydrateLlmPresets([p, { name: '坏预设' }])).toEqual([p]);
    expect(hydrateLlmPresets(undefined)).toEqual([]);
  });

  it('does not treat special object keys as inherited macros or preset names', () => {
    const [p] = importLlmPresets('{"__proto__":{"entries":[{"content":"{{constructor}}|{{getvar::missing}}"}]}}');
    expect(buildLlmPresetMessages(p, data)[0].content).toBe('{{constructor}}|');
    expect(JSON.parse(exportLlmPresets([p]))).toHaveProperty('__proto__');
  });
});
