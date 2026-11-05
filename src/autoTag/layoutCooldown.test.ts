import { describe, expect, it, vi } from 'vitest';
import { mangaDefaults, normalizeManga, type MangaSettings } from '@/manga/layouts';
import { parseImagePlan, type ImagePlan } from './protocol';
import { createLayoutSelection, layoutCandidates, LAYOUT_HISTORY_KEY, prepareLayoutSelectionMessage, recordLayoutRound, relaxLayoutSelection, setLayoutSelectionMessage, validateLayoutSelection, withLayoutTurn } from './layoutCooldown';
import type { ChatMsg } from '@/api/client';

vi.mock('@/manga/atlas', async importOriginal => ({
  ...await importOriginal<typeof import('@/manga/atlas')>(),
  rasterizeLayoutAtlas: vi.fn(async () => 'data:image/png;base64,AA=='),
}));

const sizes = { portrait: { width: 1152, height: 1728 }, landscape: { width: 1728, height: 1152 } };
const panels = [{ position: 'one', slots: { F: [-800, -500, 800, 500] as [number, number, number, number] } }];
function manga(): MangaSettings {
  return { ...mangaDefaults(), enabled: true, custom: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, canvas: sizes.portrait, portrait: panels })) };
}
function context(rounds: unknown = []) {
  return { chatMetadata: { [LAYOUT_HISTORY_KEY]: rounds }, saveMetadataDebounced: vi.fn() };
}
function plan(...ids: string[]): ImagePlan {
  return { images: ids.map(id => ({ position: 'P1', sourceLine: 0, tag: JSON.stringify({ layout: id }), nl: '', negative: '', characters: [], size: 'portrait' })), changes: [] };
}
const ids = (selection: ReturnType<typeof createLayoutSelection>) => layoutCandidates(selection).portrait.map(layout => layout.id);

describe('layout cooldown', () => {
  it('keeps three accepted rounds, survives reload and isolates chats; valid empty rounds count once', () => {
    const a = context(), b = context();
    for (const round of [['a', 'a'], ['b'], ['c'], []]) recordLayoutRound(a, round);
    expect(a.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['b'], ['c'], []]);
    expect(a.saveMetadataDebounced).toHaveBeenCalledTimes(4);
    const restored = context(JSON.parse(JSON.stringify(a.chatMetadata[LAYOUT_HISTORY_KEY])));
    expect(ids(createLayoutSelection(restored, manga(), sizes, null))).toEqual(['a', 'd', 'e']);
    expect(ids(createLayoutSelection(b, manga(), sizes, null))).toContain('b');
  });

  it('uses the configured window immediately, supports zero, and keeps bounded history for later increases', () => {
    const c = context([['a'], ['b'], ['c']]), m = manga();
    m.cooldownRounds = 1;
    expect(ids(createLayoutSelection(c, m, sizes, null))).toEqual(['a', 'b', 'd', 'e']);
    m.cooldownRounds = 2;
    expect(ids(createLayoutSelection(c, m, sizes, null))).toEqual(['a', 'd', 'e']);
    m.cooldownRounds = 0;
    const off = createLayoutSelection(c, m, sizes, null);
    expect(ids(off)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(() => validateLayoutSelection(plan('a', 'a'), off)).toThrow(/同轮/);
    const messages: ChatMsg[] = []; setLayoutSelectionMessage(messages, off);
    expect(messages[0].content).toContain('跨轮冷却已关闭');
    for (let n = 0; n < 40; n++) recordLayoutRound(c, [String(n)]);
    expect(c.chatMetadata[LAYOUT_HISTORY_KEY]).toHaveLength(30);
    expect(normalizeManga({}).cooldownRounds).toBe(3);
    for (const [value, expected] of [[0, 0], [8, 8], [4.9, 4], [-1, 0], [99, 30], [NaN, 3], ['bad', 3]] as const) {
      expect(normalizeManga({ cooldownRounds: value }).cooldownRounds).toBe(expected);
    }
    expect(normalizeManga(JSON.parse(JSON.stringify({ cooldownRounds: 7 }))).cooldownRounds).toBe(7);
  });

  it('filters cooldown, disabled layouts, canvas and orientation before offering candidates', () => {
    const m = manga(); m.disabled = ['b'];
    const selection = createLayoutSelection(context([['a']]), m, sizes, 'portrait');
    expect(ids(selection)).toEqual(['c', 'd', 'e']);
    expect(layoutCandidates(selection).landscape).toEqual([]);
    expect(Object.values(createLayoutSelection(context(), m, { portrait: null, landscape: null }, null).layouts).flat()).toEqual([]);
  });

  it('releases oldest rounds first, preserves newer overlapping use, and stops when exhausted', () => {
    const selection = createLayoutSelection(context([['a', 'b'], ['b', 'c'], ['d']]), manga(), sizes, null);
    expect(ids(selection)).toEqual(['e']);
    expect(relaxLayoutSelection(selection)).toBe(true);
    expect(ids(selection)).toEqual(['a', 'e']);
    expect(relaxLayoutSelection(selection)).toBe(true);
    expect(ids(selection)).toEqual(['a', 'b', 'c', 'e']);
    expect(relaxLayoutSelection(selection)).toBe(true);
    expect(ids(selection)).toContain('d');
    expect(relaxLayoutSelection(selection)).toBe(false);
  });

  it('automatically releases the oldest effective tier when all compatible layouts are cooling', () => {
    const selection = createLayoutSelection(context([['a', 'b'], ['c'], ['d', 'e']]), manga(), sizes, null);
    expect(selection.released).toBe(1);
    expect(ids(selection)).toEqual(['a', 'b']);
    const malformed = createLayoutSelection(context([null, ['a', 1, 'a'], {}, ['b']]), manga(), sizes, null);
    expect(ids(malformed)).toEqual(['c', 'd', 'e']);
  });

  it('rejects cooled IDs, wrong direction, malformed layout tags, and duplicate IDs within a round', () => {
    const selection = createLayoutSelection(context([['a']]), manga(), sizes, null);
    expect(() => validateLayoutSelection(plan('a'), selection)).toThrow(/白名单/);
    expect(() => validateLayoutSelection(plan(' a '), selection)).toThrow(/白名单/);
    expect(validateLayoutSelection(plan(' b '), selection)).toEqual(['b']);
    expect(() => validateLayoutSelection(plan('b', 'b'), selection)).toThrow(/同轮/);
    const wrong = plan('b'); wrong.images[0].size = 'landscape';
    expect(() => validateLayoutSelection(wrong, selection)).toThrow(/白名单/);
    expect(() => validateLayoutSelection(plan('missing'), selection)).toThrow(/白名单/);
    const broken = plan('b'); broken.images[0].tag = '{';
    expect(() => validateLayoutSelection(broken, selection)).toThrow();
    expect(validateLayoutSelection(plan('b', 'c'), selection)).toEqual(['b', 'c']);
  });

  it('updates one dynamic whitelist outside fixed DSH messages', () => {
    const selection = createLayoutSelection(context([['a']]), manga(), sizes, null);
    const messages: ChatMsg[] = [{ role: 'system', content: 'fixed geometry', purpose: 'spec' }];
    setLayoutSelectionMessage(messages, selection);
    expect(messages[1].purpose).toBeUndefined();
    expect(messages[1].content).not.toContain('解除 0');
    expect(messages[1].content).toContain('暂不可选 ID：a');
    expect(messages[1].content).toContain('竖版（portrait）：可选 4 套；ID：b、c、d、e');
    expect(messages[1].content).toContain('layout_fallback');
    expect(messages[1].content).toContain('【本轮候选版式空间目录】');
    expect(messages[1].content).not.toContain('- a｜');
    expect(messages[1].content).toContain('- b｜1 格｜画布 1152×1728');
    relaxLayoutSelection(selection); setLayoutSelectionMessage(messages, selection);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('竖版（portrait）：可选 5 套；ID：a、b、c、d、e');
    expect(messages[1].content).toContain('- a｜1 格｜画布 1152×1728');
    expect(messages[0].content).toBe('fixed geometry');
  });

  it('sends geometry only for enabled, size-compatible, uncooled candidates, with current selection notes',()=> {
    const m=manga();
    m.disabled=['b']; m.selectionNotes='CURRENT_SELECTION_NOTES';
    m.custom.push({id:'wrong-canvas',canvas:{width:1000,height:2000},portrait:panels});
    const messages:ChatMsg[]=[];
    setLayoutSelectionMessage(messages,createLayoutSelection(context([['a']]),m,sizes,'portrait'));
    expect(messages[0].content).toContain('- c｜');
    for (const id of ['a','b','wrong-canvas']) expect(messages[0].content).not.toContain(`- ${id}｜`);
    expect(messages[0].content).toContain('CURRENT_SELECTION_NOTES');
    expect(messages[0].content).toContain('横版（landscape）：暂无可选版式，本轮不可选此方向。');
    expect(messages[0].content).not.toContain('landscape(');
  });

  it('protects the complete multi-paragraph whitelist while retaining its replaceable header', () => {
    const m = manga(); m.selectionNotes = 'FIRST_PARAGRAPH\n\nLAST_PARAGRAPH';
    const selection = createLayoutSelection(context([['a']]), m, sizes, 'portrait');
    const messages: ChatMsg[] = [];
    setLayoutSelectionMessage(messages, selection);
    const content = messages[0].content;
    expect(content).toMatch(/^【本轮版式选择范围】\n<<<STB-KEEP>>>\n/);
    expect(content).toMatch(/\n<<<STB-\/KEEP>>>$/);
    const range = content.split('<<<STB-KEEP>>>')[1].split('<<<STB-/KEEP>>>')[0];
    expect(range).toContain('槽位 F');
    expect(range).toContain('【可选网格区域】');
    expect(range).toContain('G1+G2+G4+G5');
    expect(range).toContain('FIRST_PARAGRAPH\n\nLAST_PARAGRAPH');
    relaxLayoutSelection(selection); setLayoutSelectionMessage(messages, selection);
    expect(messages).toHaveLength(1);
    expect(messages[0].content.match(/<<<STB-KEEP>>>/g)).toHaveLength(1);
    expect(messages[0].content).toContain('ID：a、b、c、d、e');
  });

  it('protects exact atlas slot keys as well as the separate per-round whitelist', async () => {
    const selection = createLayoutSelection(context(), manga(), sizes, 'portrait');
    selection.visual = true;
    const messages: ChatMsg[] = [];
    await prepareLayoutSelectionMessage(messages, selection);
    expect(messages[0].content).toMatch(/<<<STB-KEEP>>>[\s\S]*ID：a、b、c、d、e[\s\S]*<<<STB-\/KEEP>>>/);
    const atlas = messages.find(message => message.atlasCatalog);
    expect(atlas?.content).toMatch(/^【会话完整版式图册】/);
    expect(atlas?.atlasCatalog).toMatch(/<<<STB-KEEP>>>[\s\S]*槽位 F[\s\S]*<<<STB-\/KEEP>>>$/);
    expect(atlas?.atlasCatalog).toMatch(/<<<STB-KEEP>>>[\s\S]*【可选网格区域】[\s\S]*G1 G2 G3[\s\S]*<<<STB-\/KEEP>>>$/);
  });

  it('accepts an explicit fallback control only when permitted, without adopting images or changes', () => {
    const segments = [{ id: 'P1', sourceLine: 0, text: 'A scene.' }];
    const raw = JSON.stringify({ images: [], changes: [{ name: 'ignore' }], layout_fallback: 'No candidate has enough text capacity.' });
    expect(parseImagePlan(raw, segments, 2, 2, true, true)).toEqual({ images: [], changes: [], layoutFallback: 'No candidate has enough text capacity.' });
    expect(() => parseImagePlan(raw, segments, 0, 2)).toThrow(/layout_fallback/);
    expect(() => parseImagePlan('{"images":[],"layout_fallback":""}', segments, 0, 2, true, true)).toThrow();
    expect(() => parseImagePlan('{"images":[{}],"layout_fallback":"reason"}', segments, 0, 2, true, true)).toThrow();
  });

  it('serializes same-chat planning through adoption and releases the queue after failure', async () => {
    const trace: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withLayoutTurn('chat', async () => { trace.push('first'); await held; trace.push('saved'); });
    const second = withLayoutTurn('chat', async () => { trace.push('second'); });
    await Promise.resolve(); expect(trace).toEqual(['first']);
    release(); await Promise.all([first, second]);
    expect(trace).toEqual(['first', 'saved', 'second']);
    await expect(withLayoutTurn('chat', async () => { throw new Error('save failed'); })).rejects.toThrow();
    await withLayoutTurn('chat', async () => { trace.push('recovered'); });
    expect(trace.at(-1)).toBe('recovered');
  });
});
