import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMsg, DshSessionRequest, WireMessage } from './client';
import { requestDshCompletion } from './dsh';
import { layoutAtlasMessages } from '@/manga/atlas';
import { newChannel, settings } from '@/state/settings';
import type { STContext } from '@/st/context';

const options = { bridgeManaged: true, protocolKey: 'manga' };

function fixture(managed = false) {
  const channel = { ...newChannel(), name: 'DSH', model: 'dsh-default', url: 'http://127.0.0.1:43121/clients/baibaohui/v1' };
  const state = {
    calls: [] as { session: DshSessionRequest; messages: WireMessage[] }[],
    lostAtlas: false, chatId: 'chat-a', remoteSession: 'existing', remoteRules: 'PREVIOUS_RULES', imageLimit: 1024,
  };
  const context = {
    chatMetadata: {}, name2: 'Story', getCurrentChatId: () => state.chatId,
    getRequestHeaders: () => ({}), saveMetadataDebounced() {},
  } as unknown as STContext;
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/bridge/capabilities')) return Response.json({
      layout_atlas: { supported: true, mode: 'session-prefix-v1', ...(managed ? { managed } : {}) },
      skill_updates: { mode: 'per-request', toggle: 'skill_enabled', retry: 'frozen-version' },
      client_endpoints: [{ id: 'baibaohui', skillId: 'moss-layout-spec', persistentSession: true }],
      image_input: {
        supported: true, modes: ['data_url'], roles: ['user'], media_types: ['image/png'],
        max_images_per_message: 20, max_bytes_per_image: state.imageLimit, max_total_bytes: 1024,
      },
    });
    const body = JSON.parse(String(init?.body));
    const session: DshSessionRequest = JSON.parse(body.custom_include_body).dsh_session;
    state.calls.push({ session, messages: body.messages });
    const atlas = session.layout_atlas;
    if (state.lostAtlas && atlas?.message_indices.length === 0) {
      return Response.json({ error: { message: 'Gone' } }); // Legacy Tavern proxy wraps the 410.
    }
    state.lostAtlas = false;
    if (session.fixed_message_count) {
      const rules = JSON.stringify(body.messages.slice(0, session.fixed_message_count));
      if (session.action === 'generate' && session.session_id !== state.remoteSession && rules !== state.remoteRules) {
        state.remoteSession = 'unexpected-branch';
      }
      state.remoteRules = rules;
    }
    return Response.json({
      dsh_session: { session_id: state.remoteSession, skill_id: session.skill_id, layout_atlas_hash: atlas?.hash },
      choices: session.action === 'generate' ? [{ message: { content: 'result' } }] : [],
    });
  });
  const send = (revision: string, whitelist: string, contract = 'HOST_CONTRACT') => {
    const messages: ChatMsg[] = [
      { role: 'system', purpose: 'contract', content: contract },
      { role: 'system', purpose: 'spec', content: 'LOCAL_SPEC' },
      { role: 'user', content: whitelist },
      ...layoutAtlasMessages(['data:image/png;base64,AAAA'], ['portrait'], 4, revision.repeat(64), 'SLOT_CATALOG'),
    ];
    return requestDshCompletion(channel, messages, context, options);
  };
  return { state, context, send };
}

afterEach(() => { settings.autoTag.dshRuleSource = 'plugin'; vi.unstubAllGlobals(); });

it.each(['skill', 'plugin'] as const)('keeps the shared session on the rolled-back bridge and uploads atlas revisions with %s rules', async source => {
  settings.autoTag.dshRuleSource = source;
  const { state, context, send } = fixture();
  await send('a', 'ALLOW_A');
  state.chatId = 'chat-b';
  context.chatMetadata = {};
  await send('a', 'ALLOW_B', 'REVISED_HOST_CONTRACT');
  await send('b', 'ALLOW_C');

  const [sync, ...generated] = state.calls;
  expect(sync.session.action).toBe('sync_rules');
  expect(sync.session.session_id).toBeUndefined();
  expect(state.remoteSession).toBe('existing');
  expect(generated.map(({ session }) => session.session_id)).toEqual(['existing', 'existing', 'existing']);
  expect(generated.map(({ messages }) => JSON.stringify(messages).includes('SLOT_CATALOG'))).toEqual([true, false, true]);
  const second = generated[1];
  expect(second.messages.map(message => message.content)).toContain('ALLOW_B');
  expect(second.messages.map(message => message.content)).toContain('REVISED_HOST_CONTRACT');
  expect(second.messages.some(message => Array.isArray(message.content))).toBe(false);
  expect(second.session.skill_id).toBe(source === 'skill' ? 'moss-layout-spec' : undefined);
  expect(state.calls.every(({ session }) => !session.layout_atlas && !session.session_mode)).toBe(true);
});

it('resubmits a full catalog once if a shared session silently changes', async () => {
  const { state, send } = fixture();
  await send('a', 'ALLOW_A');
  state.remoteSession = 'replacement';
  await send('a', 'ALLOW_B');
  const [stale, resent] = state.calls.slice(2);
  expect(stale.session.session_id).toBe('existing');
  expect(stale.messages.every(message => typeof message.content === 'string')).toBe(true);
  expect(resent.session.session_id).toBe('replacement');
  expect(JSON.stringify(resent.messages)).toContain('SLOT_CATALOG');
  expect(resent.session.request_id).not.toBe(stale.session.request_id);
  expect(state.calls).toHaveLength(4);
});

it('uses retained-atlas metadata on compatible bridges and recovers the catalog after Gone', async () => {
  const { state, send } = fixture(true);
  await send('a', 'ALLOW_A');
  await send('a', 'ALLOW_B');
  state.lostAtlas = true;
  await send('a', 'ALLOW_C');
  const generated = state.calls.filter(({ session }) => session.action === 'generate');
  expect(generated.map(({ session }) => session.layout_atlas?.message_indices.length)).toEqual([1, 0, 0, 1]);
  expect(generated.map(({ messages }) => JSON.stringify(messages).includes('SLOT_CATALOG'))).toEqual([true, false, false, true]);
  expect(generated.at(-1)?.session.session_id).toBeUndefined();
});

it('checks the image limit if a hash-only request has to upload the atlas again', async () => {
  const { state, send } = fixture(true);
  await send('a', 'ALLOW_A');
  state.lostAtlas = true;
  state.imageLimit = 2;

  await expect(send('a', 'ALLOW_B')).rejects.toThrow('单张版式图片超过');
  expect(state.calls.map(({ session }) => session.layout_atlas?.message_indices.length)).toEqual([undefined, 1, 0]);
});
