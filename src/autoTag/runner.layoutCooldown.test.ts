import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutSelection, LAYOUT_HISTORY_KEY, setLayoutSelectionMessage } from './layoutCooldown';
import { mangaDefaults } from '@/manga/layouts';
import { requestFloorTags, controlDshSession } from './runner';
import type { ChatMsg } from '@/api/client';
import type { STContext } from '@/st/context';

const h = vi.hoisted(() => ({
  context: null as unknown as STContext, settings: {} as any,
  responses: [] as (string | Error)[], messages: [] as ChatMsg[][],
  save: 'saved' as string, saves: 0, channel: null as any,
}));
vi.mock('@/st/context', () => ({ getContext: () => h.context,
  isAiStoryMessage: (m: any) => !!m && !m.is_user && !m.is_system }));
vi.mock('@/state/settings', () => ({ settings: h.settings, activeComfyPreset: () => ({}),
  getTagGenChannel: () => h.channel, isCurrentChatExcluded: () => false }));
vi.mock('@/api/client', () => {
  const request = async (_messages: ChatMsg[], options: any) => {
    h.messages.push(structuredClone(_messages));
    const raw = h.responses.shift();
    if (raw instanceof Error) throw raw;
    if (!raw) throw new Error('No test response');
    options.validate(raw); return raw;
  };
  return { requestCompletion: (_channel: any, messages: ChatMsg[], options: any) => request(messages, options), requestViaMainApi: request };
});
vi.mock('@/api/dsh', async () => {
  const { requestCompletion } = await import('@/api/client');
  return { dshChatId: (c: STContext) => c.getCurrentChatId(), requestDshCompletion: async (channel: any, messages: ChatMsg[], _context: STContext, options: any) =>
    options.action === 'sync_rules' ? '固定规范已发送' : requestCompletion(channel, messages, options) };
});
vi.mock('@/autoTag/prompt', () => ({
  buildAutoTagFixedMessages: () => [{role:'system',content:'fixed without chat',purpose:'spec'}],
  autoTagProfile: () => ({ layout: true, nl: false, naiCharPrompts: false, lockedSize: null }),
  autoTagLayoutSelection: (context: STContext) => createLayoutSelection(context, h.settings.manga,
    { portrait: { width: 1152, height: 1728 }, landscape: null }, null),
  buildAutoTagMessages: async (_context: STContext, _floor: number, _options: any, _memory: any, _target: any, _library: any, _note: any, _profile: any, selection: any) => {
    const messages: ChatMsg[] = [{ role: 'system', content: 'fixed geometry', purpose: 'spec' }];
    if (selection) setLayoutSelectionMessage(messages, selection);
    return messages;
  },
}));
vi.mock('@/autoTag/bookMemory', () => ({ readBookMemory: () => null }));
vi.mock('@/autoTag/charAnchors', () => ({ resolveCharAnchors: () => ({ text: '', entries: [] }),
  applyPositionedCharRefs: (text: string) => ({ text, unknown: [] }) }));
vi.mock('@/state/charTags', () => ({ BBI_CHAR_EXTRA_KEY: 'test_chars', CHAR_TAG_FIELDS: [],
  charTagsBeforeFloor: () => [], lockedCharTagNames: () => new Set(), readCharTagFloorDelta: () => undefined,
  makeCharTagFloorDelta: () => ({}), recomputeCharTags: vi.fn(), emptyCharFields: vi.fn(),
  createCharTagNewOp: vi.fn(), createCharTagSetOp: vi.fn() }));
vi.mock('@/floor/autoGenerate', () => ({ clearAutoGenerateForFloor: vi.fn(), consumeAutoGenerate: vi.fn(), markForAutoGenerate: vi.fn() }));
vi.mock('@/st/messageEdit', () => ({ applyMessageText: async (floor: number, build: (text: string) => string | null) => {
  h.saves++;
  if (h.save === 'throw') throw new Error('save failed');
  if (h.save !== 'saved') return h.save;
  const text = build(h.context.chat[floor].mes);
  if (text === null) return 'build-failed';
  await Promise.resolve(); h.context.chat[floor].mes = text;
  return 'saved';
} }));

function response(...ids: string[]): string {
  return JSON.stringify({ images: ids.map(id => ({ position: 'P1', tag: JSON.stringify({ layout: id }), size: 'portrait' })), changes: [] });
}
beforeEach(() => {
  vi.stubGlobal('toastr', { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() });
  h.context = { chat: [0, 1].map(() => ({ mes: 'An adult opens a book.', is_user: false, is_system: false })),
    chatMetadata: {}, name1: 'User', name2: 'Char', getCurrentChatId: () => 'chat', saveMetadataDebounced: vi.fn() } as unknown as STContext;
  Object.assign(h.settings, { enabled: true, defaultBackend: 'comfyui', excludes: { customStripTags: [] },
    autoTag: { enabled: true, minImages: 1, maxImages: 2, retryCount: 1, autoGenerate: false, dshSession: false },
    manga: { ...mangaDefaults(), enabled: true, custom: ['a', 'b', 'c'].map(id => ({ id, canvas: { width: 1152, height: 1728 }, portrait: [{ position: 'one', slots: { F: [-800, -500, 800, 500] } }] })) } });
  h.responses = []; h.messages = []; h.save = 'saved'; h.saves = 0; h.channel = null;
});

describe('runner layout adoption', () => {
  it('single-image mode accepts two portraits with one full-page ID, including retry, without consuming cooldown history', async () => {
    h.settings.autoTag.minImages = 2;
    h.settings.manga.singleImageMode = true;
    h.settings.manga.custom = [{id:'a',canvas:{width:1152,height:1728},portrait:[{position:'one',slots:{F:[-864,-576,864,576]}}]}];
    h.context.chatMetadata[LAYOUT_HISTORY_KEY] = [['a']];
    h.responses = [new Error('network'),response('a','a')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1].at(-1)?.content).toContain('同轮可复用ID');
    expect(h.messages[1].at(-1)?.content).not.toContain('请遵守本轮版式冷却白名单与同轮去重要求');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a']]);
    expect(h.saves).toBe(1);
  });

  it('counts a successful accepted request once after a network retry', async () => {
    h.responses = [new Error('network'), response('a')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(2);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a']]);
    expect(h.saves).toBe(1);
  });

  it.each(['throw', 'build-failed'])('does not count a result when persistence is %s', async state => {
    h.save = state; h.responses = [response('a')];
    await requestFloorTags(0);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toBeUndefined();
  });

  it('does not count rejected responses and retries same-round duplicates', async () => {
    h.responses = [response('a', 'a'), response('a', 'b')];
    await requestFloorTags(0);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a', 'b']]);
    expect(h.saves).toBe(1);
    h.responses = [response('a'), response('a')];
    await requestFloorTags(1);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a', 'b']]);
  });

  it('relaxes the oldest tier with a new whitelist, adopting only the final response', async () => {
    h.context.chatMetadata[LAYOUT_HISTORY_KEY] = [['a']];
    h.responses = ['{"images":[],"changes":[],"layout_fallback":"Other candidates cannot hold the dialogue."}', response('a')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0].at(-1)?.content).toContain('竖版（portrait）：可选 2 套；ID：b、c');
    expect(h.messages[1].at(-1)?.content).toContain('竖版（portrait）：可选 3 套；ID：a、b、c');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['a']]);
    expect(h.saves).toBe(1);
  });

  it('serializes two floors so the second sees the first accepted layout', async () => {
    h.responses = [response('a'), response('b')];
    await Promise.all([requestFloorTags(0), requestFloorTags(1)]);
    expect(h.messages[1].at(-1)?.content).toContain('竖版（portrait）：可选 2 套；ID：b、c');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['b']]);
  });

  it('releases only the oldest tier needed to satisfy the minimum distinct-page count', async () => {
    h.settings.autoTag.minImages = 2;
    h.context.chatMetadata[LAYOUT_HISTORY_KEY] = [['a'], ['b']];
    h.responses = [response('a', 'c')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].at(-1)?.content).toContain('竖版（portrait）：可选 2 套；ID：a、c');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['b'], ['a', 'c']]);
  });

  it('counts a successful empty decision but never a fixed-rule sync', async () => {
    h.settings.autoTag.minImages = 0; h.responses = [response()];
    await requestFloorTags(0);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([[]]);
    h.channel = {}; h.settings.autoTag.dshSession = true;
    await controlDshSession('sync_rules');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([[]]);
  });
});

it('dedicated manual controls work without a selected Tavern chat or story floor',async()=>{
  h.settings.autoTag.dshSession=true;h.settings.autoTag.dshDedicated=true;h.channel={id:'dsh'};
  h.context.getCurrentChatId=()=>'';h.context.chat=[];
  await expect(controlDshSession('sync_rules')).resolves.toBe('固定规范已发送');
  h.settings.autoTag.dshDedicated=false;
  await expect(controlDshSession('sync_rules')).rejects.toThrow('打开一个酒馆聊天');
});
