import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMangaFrames, buildMangaSpec, mangaDefaults, normalizeManga, planningLayouts, type MangaSettings } from './layouts';
import { buildLayoutAtlases } from './atlas';
import { createLayoutSelection, layoutCandidates, prepareLayoutSelectionMessage, validateLayoutSelection } from '@/autoTag/layoutCooldown';
import { autoTagProfile, buildAutoTagFixedMessages } from '@/autoTag/prompt';
import { settings } from '@/state/settings';
import type { ChatMsg } from '@/api/client';
import type { ImagePlan } from '@/autoTag/protocol';

vi.mock('./atlas', async original => ({
  ...await original<typeof import('./atlas')>(),
  rasterizeLayoutAtlas: vi.fn(async () => 'data:image/png;base64,AA=='),
}));

const size = { width: 100, height: 200 };
function manga(): MangaSettings {
  return { ...mangaDefaults(), enabled: true, singleImageMode: true, catalogMode: 'image', custom: [
    { id: 'single', canvas: size, portrait: [{ position: 'one', slots: {
      F: [-100,-50,100,50], C: [-90,-45,90,45], S: [-80,-40,90,40], TR: [-80,0,-10,40],
    } }] },
    { id: 'partial', canvas: size, portrait: [{ position: 'one', slots: { F: [-90,-50,90,50] } }] },
    { id: 'multi', canvas: size, portrait: [
      { position: 'one', slots: { F: [-100,-50,0,50] } },
      { position: 'two', slots: { F: [0,-50,100,50] } },
    ] },
  ] };
}
function page(layout = 'single') {
  return { layout, summary: { canvas: 'single', caption: 'One illustration.' },
    items: [{ panel: 1, slot: 'F', label: 'object', caption: 'panel 1, a quiet room.' }] };
}
const oldManga = settings.manga, oldBackend = settings.defaultBackend;
afterEach(() => { settings.manga = oldManga; settings.defaultBackend = oldBackend; });

describe('single-image mode', () => {
  it('defaults off, persists an explicit toggle, and does not hide the saved editor library', () => {
    expect(normalizeManga({}).singleImageMode).toBe(false);
    const restored = normalizeManga(JSON.parse(JSON.stringify(manga())));
    expect(restored.singleImageMode).toBe(true);
    expect(restored.custom.map(x => x.id)).toEqual(['single','partial','multi']);
    expect(planningLayouts(restored,'portrait').map(x => x.id)).toEqual(['single']);
    expect(planningLayouts({ ...restored, singleImageMode: false },'portrait').some(x => x.id === 'multi')).toBe(true);
    expect(() => createLayoutSelection({chatMetadata:{}},restored,{portrait:null,landscape:null},null)).toThrow(/没有.*启用全页单格/);
  });

  it('allows two portrait images to reuse the only full-page ID with cooldown history present', async () => {
    const selection = createLayoutSelection({ chatMetadata: { baibai_layout_rounds: [['single']] } }, manga(), { portrait: size, landscape: null }, 'portrait');
    expect(selection.rounds).toBe(0);
    expect(layoutCandidates(selection).portrait.map(x => x.id)).toEqual(['single']);
    const plan = { images: [{size:'portrait',tag:JSON.stringify(page())},{size:'portrait',tag:JSON.stringify(page())}] } as ImagePlan;
    expect(validateLayoutSelection(plan,selection)).toEqual(['single']);
    expect(() => validateLayoutSelection(plan,{ ...selection, singleImageMode: false })).toThrow(/同轮/);
    const messages: ChatMsg[] = [];
    await prepareLayoutSelectionMessage(messages,selection);
    const combined = messages.map(x => x.content).join('\n');
    expect(combined).toContain('同轮可复用同一ID');
    expect(combined).not.toContain('同轮多页必须使用不同 ID');
    expect(combined).not.toContain('同轮多页仍必须使用不同 ID');
  });

  it('rejects a multi-panel, partial-frame or wrong-canvas payload at compilation', () => {
    expect(() => applyMangaFrames(JSON.stringify(page()),manga(),size)).not.toThrow();
    for (const layout of ['multi','partial']) {
      expect(() => applyMangaFrames(JSON.stringify(page(layout)),manga(),size)).toThrow(/全页单格/);
    }
    const wrong = page(); wrong.summary.canvas = 'multi_panel';
    expect(() => applyMangaFrames(JSON.stringify(wrong),manga(),size)).toThrow(/canvas/);
    const other = page(); other.items[0].panel = 2;
    expect(() => applyMangaFrames(JSON.stringify(other),manga(),size)).toThrow(/panel/);
  });

  it('keeps the host contract in single mode and distinguishes identity from current clothing', () => {
    settings.manga = manga(); settings.defaultBackend = 'comfyui';
    const options = { ...settings.autoTag, minImages: 2, maxImages: 2 };
    const messages = buildAutoTagFixedMessages(options,{layout:true,nl:false,naiCharPrompts:false,lockedSize:'portrait'},'【角色固定外貌库】fixture');
    const contract = messages.find(x => x.purpose === 'contract')!.content;
    expect(contract).toContain('【本轮单图模式】');
    expect(contract).toContain('当前明确状态优先');
    expect(contract).toContain('[locked]锁档案，不锁临时穿着状态');
    expect(contract).not.toContain('短事件漫画页（每格一个瞬间）');
    expect(contract).not.toContain('用词一字不改，不得自行改写或增删其固定外貌');
    const example = JSON.parse(contract.split('\n').find(line => line.startsWith('{"images":'))!);
    expect(example.images).toHaveLength(2);
    expect(example.images.map((image:{tag:string}) => JSON.parse(image.tag).layout)).toEqual(['single','single']);
    const spec = buildMangaSpec(settings.manga,false);
    expect(spec).toContain('semi-transparent bubble fill');
    expect(spec).not.toContain('simultaneous inset');
    expect(spec).not.toContain('先确定格数');
    const frozen = autoTagProfile();
    settings.manga.singleImageMode = false;
    expect(buildAutoTagFixedMessages(settings.autoTag,frozen).find(x => x.purpose === 'contract')?.content).toContain('【本轮单图模式】');
    expect(buildMangaSpec(settings.manga,false)).toContain('simultaneous inset');
  });

  it('shows only existing legend roles, distinguishing C from an absent E', () => {
    const [atlas] = buildLayoutAtlases({ portrait: planningLayouts(manga(),'portrait'), landscape: [] });
    expect(atlas.svg).toContain('F = full frame');
    expect(atlas.svg).toContain('Inner content C');
    expect(atlas.svg).not.toContain('Background C / E');
    expect(atlas.svg).not.toContain('Edge overlap E');
  });

  it('splits a rectangular C or corner text region, but rejects actual nonrectangular reuse', () => {
    for (const slot of ['C','TR']) {
      const input = { ...page(), items: ['甲','乙'].map(text => ({ panel: 1, slot, label: 'text', text, caption: 'panel 1, printed lettering in a semi-transparent bubble.' })) };
      const result = JSON.parse(applyMangaFrames(JSON.stringify(input),manga(),size));
      expect(result.items[0].bbox[2]).toBeLessThanOrEqual(result.items[1].bbox[0]);
      if (slot === 'TR') {
        const shaped = manga();
        shaped.custom[0].portrait![0].shapes = { TR: [[0,-80],[40,-70],[40,-10],[0,-10]] };
        expect(() => applyMangaFrames(JSON.stringify(input),shaped,size)).toThrow(/非矩形/);
      }
    }
  });
});
