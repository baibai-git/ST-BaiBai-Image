import { describe, expect, it } from 'vitest';

import { checkSlotHealth, floorIdOf, HOST_HIDE_CLASS } from '@/floor/slotHealth';

/**
 * 仓里没装 jsdom(vitest 跑在 node),故用鸭子类型的假节点。
 * checkSlotHealth / floorIdOf 刻意只碰极小的 DOM 表面(isConnected / closest /
 * classList.contains / getAttribute),正是为了能这样锁住判据。
 */
function fakeHost(options: {
  connected?: boolean;
  /** closest(selector) 的返回值表;缺的选择器返回 null。 */
  ancestors?: Record<string, unknown>;
}): Element {
  const { connected = true, ancestors = {} } = options;
  return {
    isConnected: connected,
    closest: (selector: string) => ancestors[selector] ?? null,
  } as unknown as Element;
}

function fakeMesText(classes: string[]): unknown {
  return { classList: { contains: (name: string) => classes.includes(name) } };
}

function fakeMes(mesid: string | null): unknown {
  return { getAttribute: (name: string) => (name === 'mesid' ? mesid : null) };
}

describe('checkSlotHealth', () => {
  it('reports ok for a connected anchor under a visible .mes_text', () => {
    const host = fakeHost({ ancestors: { '.mes_text': fakeMesText([]) } });
    expect(checkSlotHealth(host)).toBe('ok');
  });

  it('reports detached when the anchor left the document', () => {
    // ST 的 updateMessageBlock / messageEditCancel 整体重写 .mes_text 的结果
    const host = fakeHost({ connected: false, ancestors: { '.mes_text': fakeMesText([]) } });
    expect(checkSlotHealth(host)).toBe('detached');
  });

  it('reports detached for a missing host', () => {
    expect(checkSlotHealth(null)).toBe('detached');
    expect(checkSlotHealth(undefined)).toBe('detached');
  });

  it('reports hidden-by-host when the ancestor .mes_text carries the hide class', () => {
    // ST 给「有 media 且 inline_image===false」的楼挂 inline_media,style.css 里是 display:none
    const host = fakeHost({ ancestors: { '.mes_text': fakeMesText([HOST_HIDE_CLASS]) } });
    expect(checkSlotHealth(host)).toBe('hidden-by-host');
  });

  /**
   * 顺序锁:脱离文档的元素 closest() 仍会沿着**已断开的子树**往上走,而那份被 ST
   * 换下来的 .mes_text 完全可能带着 inline_media。若先判 hidden 再判 detached,
   * 这种楼会被误诊成「只是被藏了」——于是不重挂、只去改一个不在文档里的节点,
   * 卡片永远回不来。detached 必须优先。
   */
  it('prefers detached over hidden when both look true', () => {
    const host = fakeHost({
      connected: false,
      ancestors: { '.mes_text': fakeMesText([HOST_HIDE_CLASS]) },
    });
    expect(checkSlotHealth(host)).toBe('detached');
  });

  it('reports ok when the anchor is connected but has no .mes_text ancestor', () => {
    // 别把「结构不认识」当成异常去反复重挂:不知道怎么救的情况下什么都别做
    expect(checkSlotHealth(fakeHost({}))).toBe('ok');
  });
});

describe('floorIdOf', () => {
  it('reads the floor number from the enclosing .mes', () => {
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('7') } }))).toBe(7);
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('0') } }))).toBe(0);
  });

  it('returns null when there is no enclosing .mes', () => {
    // 该楼整个不在文档里(切聊天/懒渲染卸载):交给渲染事件,不在自愈里瞎猜
    expect(floorIdOf(fakeHost({}))).toBeNull();
    expect(floorIdOf(null)).toBeNull();
  });

  it('returns null for a missing or non-numeric mesid', () => {
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes(null) } }))).toBeNull();
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('') } }))).toBeNull();
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('abc') } }))).toBeNull();
    // 负数不是合法楼层号,别拿它去索引 chat
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('-1') } }))).toBeNull();
  });
});
