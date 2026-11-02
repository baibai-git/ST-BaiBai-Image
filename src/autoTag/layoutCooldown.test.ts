import { describe, expect, it, vi } from 'vitest';
import { mangaDefaults, normalizeManga, type MangaSettings } from '@/manga/layouts';
import { parseImagePlan, type ImagePlan } from './protocol';
import { createLayoutSelection, layoutCandidates, LAYOUT_HISTORY_KEY, recordLayoutRound, relaxLayoutSelection, setLayoutSelectionMessage, validateLayoutSelection, withLayoutTurn } from './layoutCooldown';
import type { ChatMsg } from '@/api/client';

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
    expect(messages[0].content).toContain('跨轮版式冷却已关闭');
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
    expect(messages[1].content).toContain('portrait: b、c、d、e');
    expect(messages[1].content).toContain('layout_fallback');
    relaxLayoutSelection(selection); setLayoutSelectionMessage(messages, selection);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('portrait: a、b、c、d、e');
    expect(messages[0].content).toBe('fixed geometry');
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
