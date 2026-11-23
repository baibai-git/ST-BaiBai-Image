import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_HISTORY_KEY } from './layoutCooldown';
import { mangaDefaults } from '@/manga/layouts';
import { requestFloorTags } from './runner';
import { renderWorkflowTemplate } from '@/backends/comfyui';
import { newChannel, newComfyWorkflow, settings } from '@/state/settings';
import { parseImageTags, parseImageTagContent } from '@/st/imageTagRegex';
import type { STContext } from '@/st/context';

const h = {
  context: null as unknown as STContext,
  responses: [] as (string | Error)[],
  messages: [] as { role: string; content: string }[][],
  saved: [] as string[][],
};

const story = 'An adult opens a book.';
function writtenLayouts(floor: number): string[] {
  return parseImageTags(h.context.chat[floor].mes).map(raw => JSON.parse(parseImageTagContent(raw).tag).layout);
}
function candidateText(request: number): string | undefined {
  return h.messages[request]?.find(message => message.content.startsWith('【本轮版式选择范围】'))?.content;
}
function response(...ids: string[]): string {
  return JSON.stringify({ images: ids.map(id => ({ position: 'P1', tag: JSON.stringify({ layout: id }), size: 'portrait' })), changes: [] });
}
beforeEach(() => {
  vi.stubGlobal('toastr', { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() });
  h.context = {
    chat: [0, 1].map(() => ({ name: 'Char', mes: story, is_user: false, is_system: false })),
    chatMetadata: {}, name1: 'User', name2: 'Char', getCurrentChatId: () => 'chat',
    getRequestHeaders: () => ({}), saveMetadataDebounced() {},
    saveChat: async () => { h.saved.push(h.context.chat.map(message => message.mes)); },
    eventSource: { on() {} },
    eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' } as STContext['eventTypes'],
    generateRaw: async ({ prompt }) => {
      if (!Array.isArray(prompt)) throw new Error('Expected chat messages');
      h.messages.push(prompt);
      const raw = h.responses.shift();
      if (raw instanceof Error) throw raw;
      if (!raw) throw new Error('No test response');
      return raw;
    },
  };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => h.context } });
  vi.stubGlobal('document', { querySelector: () => null });
  const preset = { ...newComfyWorkflow(), portraitSize: '1152×1728', orientationLock: 'portrait' as const };
  settings.enabled = true;
  settings.defaultBackend = 'comfyui';
  settings.comfyui.workflows = [preset];
  settings.comfyui.activeWorkflowId = preset.id;
  settings.channels = [];
  settings.assignments.tagGen = '';
  Object.assign(settings.autoTag, { enabled: true, minImages: 1, maxImages: 2, retryCount: 1, autoGenerate: false, dshSession: false, dshDedicated: false });
  settings.manga = { ...mangaDefaults(), enabled: true, custom: ['a', 'b', 'c'].map(id => ({
    id, canvas: { width: 1152, height: 1728 }, portrait: [{ position: 'one', slots: { F: [-800, -500, 800, 500] } }],
  })) };
  h.responses = []; h.messages = []; h.saved = [];
});
afterEach(() => vi.unstubAllGlobals());

it('writes tag-only, nl-only and mixed ComfyUI responses to reusable image cards with the nl preference off', async () => {
  settings.manga.enabled = false;
  settings.autoTag.maxImages = 3;
  settings.comfyui.workflows[0].naturalLanguage = false;
  const nl = 'An adult opens a book near the window.';
  h.responses = [JSON.stringify({
    images: [
      { position: 'P1', tag: 'adult, book, window' },
      { position: 'P1', nl },
      { position: 'P1', tag: 'adult, book', nl },
    ],
  })];

  await requestFloorTags(0);

  expect(h.messages).toHaveLength(1);
  expect(h.messages[0].some(message => message.content.includes('只写 tag、只写 nl，或两个都写'))).toBe(true);
  expect(h.saved).toHaveLength(1);
  const template = '{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"%prompt%","description":"%nl%"}}}';
  const savedPrompts = parseImageTags(h.saved[0][0]).map(raw => {
    const prompt = parseImageTagContent(raw);
    return renderWorkflowTemplate(template, { prompt: prompt.tag, nl: prompt.nl })['1'].inputs;
  });
  expect(savedPrompts).toEqual([
    { text: 'adult, book, window', description: '' },
    { text: nl, description: '' },
    { text: 'adult, book', description: nl },
  ]);
});

describe('runner layout adoption', () => {
  it('single-image mode accepts two portraits with one full-page ID, including retry, without consuming cooldown history', async () => {
    settings.autoTag.minImages = 2;
    settings.manga.singleImageMode = true;
    settings.manga.custom = [{id:'a',canvas:{width:1152,height:1728},portrait:[{position:'one',slots:{F:[-864,-576,864,576]}}]}];
    h.context.chatMetadata[LAYOUT_HISTORY_KEY] = [['a']];
    h.responses = [new Error('network'),response('a','a')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1].at(-1)?.content).toContain('同轮可复用ID');
    expect(h.messages[1].at(-1)?.content).not.toContain('请遵守本轮版式冷却白名单与同轮去重要求');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a']]);
    expect(writtenLayouts(0)).toEqual(['a', 'a']);
    expect(h.saved).toEqual([[h.context.chat[0].mes, story]]);
  });

  it('counts a successful accepted request once after a network retry', async () => {
    h.responses = [new Error('network'), response('a')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(2);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a']]);
    expect(writtenLayouts(0)).toEqual(['a']);
    expect(h.saved).toEqual([[h.context.chat[0].mes, story]]);
  });

  it.each(['throw', 'build-failed'])('does not count a result when persistence is %s', async state => {
    const insertedElsewhere = '<bbi_image>already added</bbi_image>';
    if (state === 'throw') h.context.saveChat = async () => { throw new Error('save failed'); };
    else {
      const upstream = h.context.generateRaw!;
      h.context.generateRaw = async opts => {
        h.context.chat[0].mes += insertedElsewhere;
        return upstream(opts);
      };
    }
    h.responses = [response('a')];
    await requestFloorTags(0);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toBeUndefined();
    expect(h.context.chat[0].mes).toBe(state === 'throw' ? story : story + insertedElsewhere);
    expect(h.saved).toEqual([]);
  });

  it('does not count rejected responses and retries same-round duplicates', async () => {
    h.responses = [response('a', 'a'), response('a', 'b')];
    await requestFloorTags(0);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a', 'b']]);
    expect(writtenLayouts(0)).toEqual(['a', 'b']);
    h.responses = [response('a'), response('a')];
    await requestFloorTags(1);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a', 'b']]);
    expect(h.context.chat[1].mes).toBe(story);
  });

  it('relaxes the oldest tier with a new whitelist, adopting only the final response', async () => {
    h.context.chatMetadata[LAYOUT_HISTORY_KEY] = [['a']];
    h.responses = ['{"images":[],"changes":[],"layout_fallback":"Other candidates cannot hold the dialogue."}', response('a')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(2);
    expect(candidateText(0)).toContain('竖版（portrait）：可选 2 套；ID：b、c');
    expect(candidateText(1)).toContain('竖版（portrait）：可选 3 套；ID：a、b、c');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['a']]);
    expect(writtenLayouts(0)).toEqual(['a']);
  });

  it('serializes two floors so the second sees the first accepted layout', async () => {
    h.responses = [response('a'), response('b')];
    await Promise.all([requestFloorTags(0), requestFloorTags(1)]);
    expect(candidateText(1)).toContain('竖版（portrait）：可选 2 套；ID：b、c');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['b']]);
  });

  it('releases only the oldest tier needed to satisfy the minimum distinct-page count', async () => {
    settings.autoTag.minImages = 2;
    h.context.chatMetadata[LAYOUT_HISTORY_KEY] = [['a'], ['b']];
    h.responses = [response('a', 'c')];
    await requestFloorTags(0);
    expect(h.messages).toHaveLength(1);
    expect(candidateText(0)).toContain('竖版（portrait）：可选 2 套；ID：a、c');
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([['a'], ['b'], ['a', 'c']]);
  });

  it('counts a successful decision to skip illustration without writing the story', async () => {
    settings.autoTag.minImages = 0; h.responses = [response()];
    await requestFloorTags(0);
    expect(h.context.chatMetadata[LAYOUT_HISTORY_KEY]).toEqual([[]]);
    expect(h.context.chat[0].mes).toBe(story);
    expect(h.saved).toEqual([]);
  });
});

it('uses the ST-bridge entry without local session switches and updates fixed rules in the same session', async () => {
  const channel = {
    ...newChannel(), url: 'http://localhost:43121/clients/baibaohui/v1', key: 'fixture', model: 'dsh-default',
  };
  settings.channels = [channel];
  settings.assignments.tagGen = channel.id;
  settings.autoTag.dshSession = false;
  settings.autoTag.dshDedicated = true;
  settings.autoTag.dshUserMessages = true;
  settings.autoTag.dshRuleSource = 'skill';
  settings.autoTag.dshSkillRequest = 'Load {{skill_id}} now.';
  settings.autoTag.prompts.jailbreak = 'Initial fixed rule';
  const requests: {messages: {role: string; content: string}[]; session: Record<string, unknown>}[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/bridge/capabilities')) {
      return Response.json({
        skill_updates: { mode: 'per-request', toggle: 'skill_enabled', retry: 'frozen-version' },
        client_endpoints: [{ id: 'baibaohui', skillId: 'moss-layout-spec' }],
      });
    }
    const body = JSON.parse(String(init.body));
    const session = JSON.parse(body.custom_include_body).dsh_session;
    requests.push({ messages: body.messages, session });
    return Response.json({
      dsh_session: { session_id: 'bridge-selected', skill_id: 'moss-layout-spec' },
      choices: session.action==='sync_rules' ? [] : [{ message: { content: response(requests.length === 2 ? 'a' : 'b') } }],
    });
  });
  await requestFloorTags(0);
  settings.autoTag.prompts.jailbreak = 'Revised fixed rule';
  await requestFloorTags(1);

  expect(requests.map(request => request.session.action)).toEqual(['sync_rules', 'generate', 'generate']);
  expect(requests[0].session).not.toHaveProperty('session_id');
  const generations=requests.slice(1);
  expect(generations.map(request => request.messages[0].content)).toEqual(['Initial fixed rule', 'Revised fixed rule']);
  for (const request of generations) {
    expect(request.session).toMatchObject({ action: 'generate', client_id: 'baibaohui', session_id: 'bridge-selected', skill_enabled: true, fixed_message_types: ['prefix', 'contract'] });
    for (const field of ['session_mode', 'task_id']) expect(request.session).not.toHaveProperty(field);
    expect(request.messages.every(message => message.role === 'user')).toBe(true);
    expect(request.messages.at(-1)?.content).toBe('<<<STB-KEEP>>>\nLoad moss-layout-spec now.\n<<<STB-/KEEP>>>');
  }
  expect(writtenLayouts(0)).toEqual(['a']);
  expect(writtenLayouts(1)).toEqual(['b']);
});
