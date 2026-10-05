import { describe, expect, it } from 'vitest';
import { parsePresetImagePlan } from '@/autoTag/presetProtocol';
import { injectImageTags } from '@/autoTag/protocol';
import { parseImageTagContent } from '@/st/imageTagRegex';

const segments = [
  { id: 'P1', sourceLine: 0, text: '小雪走进房间。' },
  { id: 'P2', sourceLine: 2, text: '她站在窗前看夜景。' },
];
const output = `<thinking>不应解析这里的 <images><image>示例</image></images></thinking>
<images><image><regex>站在窗前看夜景</regex><Tag_think>secret internal notes</Tag_think><size>768x512</size>
<prompts><scene_composition>A room at night, cinematic lighting</scene_composition>
<character_1><prompt>小雪, long silver hair, looking out of a window</prompt></character_1></prompts></image></images>`;

describe('legacy LLM preset output adaptation', () => {
  it('maps literal anchors, combines scene/characters for ComfyUI and excludes reasoning', () => {
    const plan = parsePresetImagePlan(output, segments, 1, 2, false);
    expect(plan.images[0]).toMatchObject({ position: 'P2', sourceLine: 2, size: 'landscape', characters: [] });
    expect(plan.images[0].tag).toBe('A room at night, cinematic lighting, 小雪, long silver hair, looking out of a window');
    const source = '小雪走进房间。\n\n她站在窗前看夜景。';
    const injected = injectImageTags(source, plan.images);
    expect(injected).toContain(source);
    expect(injected).not.toContain('internal notes');
    const raw = injected.match(/<bbi_image>[\s\S]*?<\/bbi_image>/)?.[0];
    expect(raw).toBeTruthy();
    expect(parseImageTagContent(raw!).tag).toBe(plan.images[0].tag);
  });

  it('preserves native character prompts for NAI and accepts a P identifier', () => {
    const plan = parsePresetImagePlan(output.replace('站在窗前看夜景</regex>', 'P2</regex>'), segments, 1, 2, true);
    expect(plan.images[0].tag).toBe('A room at night, cinematic lighting');
    expect(plan.images[0].characters).toEqual([{ name: '小雪', tag: '小雪, long silver hair, looking out of a window', nl: '小雪, long silver hair, looking out of a window' }]);
    expect(parsePresetImagePlan(output.replace('站在窗前看夜景</regex>', '⟦P2⟧</regex>'), segments, 1, 2, false).images[0].position).toBe('P2');
  });

  it('rejects ambiguous, missing, and executable-looking anchors rather than inserting in the wrong paragraph', () => {
    for (const anchor of ['P99', '.*', '']) {
      expect(() => parsePresetImagePlan(output.replace('站在窗前看夜景</regex>', `${anchor}</regex>`), segments, 0, 2, false)).toThrow('唯一定位');
    }
    const repeated = segments.map(s => ({ ...s, text: '共同片段' }));
    expect(() => parsePresetImagePlan(output.replace('站在窗前看夜景</regex>', '共同片段</regex>'), repeated, 0, 2, false)).toThrow('唯一定位');
  });

  it('enforces count bounds, accepts empty plans, and rejects unexpanded asset calls', () => {
    expect(parsePresetImagePlan('<images></images>', segments, 0, 2, false).images).toEqual([]);
    expect(() => parsePresetImagePlan('<images></images>', segments, 1, 2, false)).toThrow('最少图片数');
    expect(() => parsePresetImagePlan(output.replace('long silver hair', '${"name":"X"}$'), segments, 1, 2, false)).toThrow('未展开');
    const json = JSON.stringify({ images: [{ position: 'P1', tag: 'night', nl: 'A night scene' }] });
    expect(parsePresetImagePlan(json, segments, 0, 2, false).images[0].nl).toBe('A night scene');
  });
});
