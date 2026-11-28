import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyMessageText } from '@/st/messageEdit';

function installContext(context: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    SillyTavern: { getContext: () => context },
  });
  vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
}

afterEach(() => vi.unstubAllGlobals());

describe('safe message editing', () => {
  it('updates mes and the active swipe, then emits edit/update events', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['旧页', '原文'],
      swipe_id: 1,
    };
    const emit = vi.fn(async () => undefined);
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: { emit },
      eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
    });

    await expect(
      applyMessageText(0, text => `${text}\n<bbi_image>scene</bbi_image>`, 'chat-a', 1),
    ).resolves.toBe('saved');
    expect(message.mes).toContain('<bbi_image>scene</bbi_image>');
    expect(message.swipes[1]).toBe(message.mes);
    expect(saveChat).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenNthCalledWith(1, 'edited', 0);
    expect(emit).toHaveBeenNthCalledWith(2, 'updated', 0);
  });

  it('builds on the current text so another plugin\'s edit survives the write', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '别的插件刚改过的正文',
      swipes: ['别的插件刚改过的正文'],
      swipe_id: 0,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    const buildNext = (text: string) => `${text}\n<bbi_image>scene</bbi_image>`;
    await expect(applyMessageText(0, buildNext, 'chat-a', 0)).resolves.toBe('saved');
    expect(message.mes).toBe('别的插件刚改过的正文\n<bbi_image>scene</bbi_image>');
    expect(saveChat).toHaveBeenCalledOnce();
  });

  it('abandons the write when buildNext returns null', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '整篇换掉的正文',
      swipes: ['整篇换掉的正文'],
      swipe_id: 0,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    await expect(applyMessageText(0, () => null, 'chat-a', 0)).resolves.toBe('build-failed');
    expect(message.mes).toBe('整篇换掉的正文');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('does not write into another swipe with identical text', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '相同正文',
      swipes: ['相同正文', '相同正文'],
      swipe_id: 1,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(0, () => '新正文', 'chat-a', 0),
    ).resolves.toBe('swipe-changed');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('accepts a replaced message object with the same identity', async () => {
    const original = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      send_date: '2026-08-27 10:00:00',
      extra: {},
    };
    // 别的插件整体换壳(chat[i] = {...chat[i], mes}):同一条消息,不该判成楼层变化
    const replacement = { ...original, mes: '别的插件改写后的正文', extra: {} };
    const context = {
      chat: [replacement],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
      eventSource: {},
      eventTypes: {},
    };
    installContext(context);

    await expect(
      applyMessageText(0, text => `${text}!`, 'chat-a', 0, original),
    ).resolves.toBe('saved');
    expect(replacement.mes).toBe('别的插件改写后的正文!');
    expect(context.saveChat).toHaveBeenCalledOnce();
  });

  it('rejects a different message in the slot (floor deleted, index shifted)', async () => {
    const original = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      send_date: '2026-08-27 10:00:00',
      extra: {},
    };
    const other = { ...original, send_date: '2026-08-27 11:22:33', extra: {} };
    const context = {
      chat: [other],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
      eventSource: {},
      eventTypes: {},
    };
    installContext(context);

    await expect(
      applyMessageText(
        0,
        () => '新正文',
        'chat-a',
        0,
        original,
        { key: 'bbiCharChanges', value: { v: 1, swipe: 0, ops: [] } },
      ),
    ).resolves.toBe('floor-changed');
    expect(other.mes).toBe('原文');
    expect(other.extra).toEqual({});
    expect(context.saveChat).not.toHaveBeenCalled();
  });

  it('rolls back message extra when saving fails', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      extra: { keep: true },
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => {
        throw new Error('save failed');
      }),
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(
        0,
        () => '新正文',
        'chat-a',
        0,
        message,
        { key: 'bbiCharChanges', value: { v: 1, swipe: 0, ops: [] } },
      ),
    ).rejects.toThrow('save failed');
    expect(message.mes).toBe('原文');
    expect(message.extra).toEqual({ keep: true });
  });
});
