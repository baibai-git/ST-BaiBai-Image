import { describe, expect, it } from 'vitest';

import { SlotRegistry } from '@/floor/registry';

describe('SlotRegistry', () => {
  it('重渲染楼层时清理该楼各卡片和候选回复，保留其它楼层和聊天的卡片', () => {
    const registry = new SlotRegistry();
    const register = (chat: string, floor: number, swipe: number, slot: number) => {
      const card = { container: {} as ShadowRoot, vnode: {} as never };
      registry.set(registry.key(chat, floor, swipe, slot), card);
      return card;
    };
    register('chat', 1, 0, 0);
    register('chat', 1, 0, 1);
    register('chat', 1, 1, 0);
    const nextFloor = register('chat', 10, 0, 0);
    const otherChat = register('other', 1, 0, 0);

    const stale = registry.keysByMessage('chat', 1);
    expect(stale).toHaveLength(3);
    for (const key of stale) registry.delete(key);
    expect(registry.all()).toEqual([nextFloor, otherChat]);
  });
});
