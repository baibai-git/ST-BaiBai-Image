import { h, render, watch, type VNode } from 'vue';

import Card from '@/floor/Card.vue';
import { clearAutoGenerateFlags } from '@/floor/autoGenerate';
import { cardStyleSheet, cardStyleTextFallback } from '@/floor/cardStyles';
import { onChatMutation } from '@/floor/chatObserver';
import { setNaiConcurrency } from '@/floor/genQueue';
import { clearAllGen, pruneGenSlots } from '@/floor/genState';
import { SlotRegistry } from '@/floor/registry';
import { checkSlotHealth, floorIdOf } from '@/floor/slotHealth';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext, type STContext } from '@/st/context';
import { BBI_SLOT_SELECTOR, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';

/**
 * 楼层水合框架（DESIGN-FLOOR-UI.md §5.2 / §6）。
 *
 * 渲染事件触发 → 定位楼层 .mes_text → 锚点列表（DOM 顺序）与
 * parseImageTags(message.mes) 解析出的 tag 列表按序一一配对 → 每个锚点
 * 挂载一张卡片。锚点每次渲染重建，水合每次事件重建，全程幂等。
 *
 * 卡片渲进锚点自己的 **shadow root**（不是锚点本身）：楼层在 ST 的 light DOM 里，
 * ST 全局样式与用户装的美化主题会直接改到卡片上。shadow 边界双向隔离，
 * 与 index.ts 主窗口同构，只是从「一个大 host」变成「每槽位一个小 host」。
 *
 * 【两层触发,缺一不可】
 * 1. 事件层(bindFloorHydration):ST 的渲染事件,覆盖正常路径,便宜且及时;
 * 2. 自愈层(bindSlotSelfHealing):MutationObserver 兜住**不发事件**的路径。
 *
 * 第 2 层不是防御第三方插件,首先是防御 ST 自己:updateMessageBlock 直接
 * `.mes_text.html(...)` 且不发任何事件,messageEditCancel/Done 用 `.empty()`,
 * 右滑生成写 `.mes_text.html('...')`。锚点活在 .mes_text **里面**,这些路径一律
 * 把它连同 shadow root 一起删掉,而事件层对此完全无感。用户报的
 * 「图在生成、楼层里看不到界面」就是它——genState 是模块级的,卡片死了生成照样跑完。
 *
 * 相邻的柏宝书没这个毛病,不是因为它更结实,是因为它的宿主挂在 .mes_text **外面**
 * 当兄弟节点,`.html()`/`.empty()` 只清 innerHTML,碰不到兄弟。而本插件的卡片必须
 * 落在 tag 的行内位置(多 tag 楼层要按位置分别成图),搬不出去——同一条约束下
 * 当初也否掉了官方 extra.media 方案(architecture.md §6)。故自愈是位置约束下的唯一解。
 */

export const slotRegistry = new SlotRegistry();

let bound = false;
let healingBound = false;

/**
 * 可继承的排版属性——shadow DOM 不隔离继承，这些会透过 host 从 ST 漏进来。
 * 与 index.ts 的 INHERITED_RESET 同一份职责（那里是主窗口 host，这里是每张卡片 host）；
 * 卡片要**跟随聊天字号**故不钉 font-size，只钉会破坏布局与配色的那些。
 */
const CARD_INHERITED_RESET: Record<string, string> = {
  'font-style': 'normal',
  'font-weight': '400',
  'font-variant': 'normal',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  'line-height': '1.6',
  direction: 'ltr',
};

/**
 * 备好锚点的 shadow root:挂样式 + 钉死继承属性(幂等)。
 * 锚点每次楼层渲染都是新元素,但 MESSAGE_UPDATED 等事件下也可能复用同一元素,
 * 故 attachShadow 前先查 shadowRoot——重复 attach 会抛。
 */
function ensureShadow(anchor: HTMLElement): ShadowRoot {
  const existing = anchor.shadowRoot;
  if (existing) return existing;

  const shadow = anchor.attachShadow({ mode: 'open' });
  const sheet = cardStyleSheet();
  if (sheet) {
    // 全部卡片共享同一个 CSSStyleSheet 对象:N 张卡零重复、零重复解析
    shadow.adoptedStyleSheets = [sheet];
  } else {
    // 老浏览器兜底:每个 shadow 一份 <style>
    const style = document.createElement('style');
    style.textContent = cardStyleTextFallback();
    shadow.appendChild(style);
  }

  for (const [prop, value] of Object.entries(CARD_INHERITED_RESET)) {
    anchor.style.setProperty(prop, value, 'important');
  }
  return shadow;
}

/** 楼层 .mes_text 元素；楼层不在 DOM（未渲染/群聊懒渲染）时返回 null。 */
function findMesText(messageId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mes[mesid="${messageId}"] .mes_text`);
}

function unmountKey(key: string): void {
  const record = slotRegistry.get(key);
  if (!record) return;
  // 显式卸载：锚点容器可能已脱离 DOM（.mes_text 被 ST 整体重写），
  // render(null, container) 对已脱离元素依然安全。
  render(null, record.container);
  slotRegistry.delete(key);
}

/** 卸载并清空全部记录（切聊天 / 删除楼层后全量重建）。 */
function unmountAll(): void {
  for (const key of slotRegistry.keys()) {
    unmountKey(key);
  }
}

/**
 * 水合单条消息的全部槽位。
 *
 * 差分策略(替代旧版「先全卸再全挂」):同 key 且锚点元素没变 → render 同类型组件
 * 做 props patch,组件实例与 DOM(尤其 <img>)原样保留;锚点换了(ST 重渲染重建了
 * .mes_text)或新槽位 → 卸载旧记录重挂;本楼不再需要的记录(tag 变少 / swipe 切换 /
 * 楼层离屏 / 消息删除)卸载。
 *
 * 为什么值得:任一槽位出图成功都会触发本楼重水合,旧实现把所有卡片的 <img> 重建,
 * 每张图都重新发起请求(ST 静态服务 max-age=0,每次都要重验证)——楼层里图越多,
 * 一次出图完成的请求风暴越大。patch 路径下 src 不变则 DOM 不动,零请求。
 */
export function hydrateMessage(messageId: number, ctx: STContext): void {
  const chatId = ctx.getCurrentChatId();
  const message = ctx.chat[messageId];

  /** 本次水合后「应该存在」的槽位:key → {锚点, vnode}。消息没了就留空,下面统一卸载。 */
  const desired = new Map<string, { anchor: HTMLElement; vnode: VNode }>();

  if (message) {
    const tags = parseImageTags(message.mes);
    const swipeId = message.swipe_id ?? 0;
    // 槽位可能整个消失(用户删掉 tag / swipe 到 tag 更少的一版):那些槽位再没有卡片
    // 来对账,运行态记录会永久留存,日后同 key 复现时被新卡片误认领。按 tag 数剪掉越界的。
    pruneGenSlots(chatId ?? '-', messageId, swipeId, tags.length);

    if (tags.length > 0) {
      const mesText = findMesText(messageId);
      // 楼层不在 DOM(未渲染/群聊懒渲染):desired 留空,本楼旧记录被卸载,等下次渲染事件
      if (mesText) {
        const anchors = [...mesText.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
        if (anchors.length !== tags.length) {
          console.warn(
            `[柏宝绘] 楼层 #${messageId} 锚点 ${anchors.length} 个 ≠ 生图 tag ${tags.length} 个,按少者配对`,
          );
        }
        const count = Math.min(anchors.length, tags.length);

        for (let seq = 0; seq < count; seq++) {
          const key = slotRegistry.key(chatId, messageId, swipeId, seq);
          // 从 extra 恢复:当前 tag 原文重算 hash 匹配同槽位历史 → ready(可翻页);
          // 无匹配但有旧提示词结果 → stale(DESIGN-FLOOR-UI.md §7.1)。
          const store = readStore(message);
          const hash = promptHash(tags[seq]);
          const history = historyEntries(store, swipeId, hash, seq);
          const entry = history.length ? history[history.length - 1] : null;
          const staleEntry = entry ? null : latestStaleEntry(store, swipeId, hash, seq);
          const content = parseImageTagContent(tags[seq]);
          desired.set(key, {
            anchor: anchors[seq],
            vnode: h(Card, {
              prompt: content.tag,
              nl: content.nl,
              negative: content.negative,
              characters: content.characters,
              size: content.size,
              tag: tags[seq],
              messageId,
              seq,
              swipeId,
              history,
              staleEntry,
              // key 的一部分:与 registry.key 的占位口径一致(chatId 缺失时用 '-')
              chatId: chatId ?? '-',
            }),
          });
        }
      }
    }
  }

  // 卸载本楼不在期望集合内的旧记录(跨 swipeId)
  for (const key of slotRegistry.keysByMessage(chatId, messageId)) {
    if (!desired.has(key)) unmountKey(key);
  }

  // 挂载或差分更新
  for (const [key, { anchor, vnode }] of desired) {
    const existing = slotRegistry.get(key);
    if (existing && existing.container.host === anchor) {
      // 同锚点:render 同类型组件 → props patch,不重挂 DOM、不重跑 onMounted。
      // autoGenerate 标记由 onMounted 消费,但它只出现在「刚写入 tag」的锚点上
      // (写正文必触发 ST 重渲染、锚点必重建),走不到这条分支。
      existing.vnode = vnode;
      render(vnode, existing.container);
    } else {
      // 卡片渲进锚点的 shadow root,与 ST 样式双向隔离;主题跟随设置(默认 st = 融入宿主配色)
      if (existing) unmountKey(key);
      const shadow = ensureShadow(anchor);
      anchor.setAttribute('data-theme', settings.ui.cardTheme || 'st');
      render(vnode, shadow);
      slotRegistry.set(key, { container: shadow, vnode });
    }
  }
}

/** Hydrate currently displayed messages without tearing down cards that still have the same anchors. */
function hydrateVisible(ctx: STContext): void {
  for (let messageId = 0; messageId < ctx.chat.length; messageId++) {
    hydrateMessage(messageId, ctx);
  }
}

/** Full rebuild for chat changes or message deletion. */
export function hydrateAll(ctx: STContext): void {
  unmountAll();
  hydrateVisible(ctx);
}

const LATE_HYDRATION_DELAY = 100;

/**
 * 自愈:体检已挂载的槽位,把死掉的重挂;被宿主整段藏掉的只留痕(见 warnHiddenByHost)。
 *
 * 便宜是硬要求——它挂在 rAF 节流的 `#chat` observer 上,流式渲染期间每帧都可能跑。
 * 成本上限是 O(已挂载卡片数)(实测量级 <20),每张只做 `isConnected` 属性读 +
 * 一次 `closest()`;**只有真发现异常**才碰 DOM。绝不在这里调 hydrateVisible:
 * 那会对每条消息跑 parseImageTags + readStore + promptHash,那才是真卡顿。
 *
 * 重挂按楼去重:一楼多卡时,`.mes_text` 被整体换掉意味着该楼所有槽位一起死,
 * 逐个 hydrateMessage 会把同一楼重水合 N 次。
 *
 * 不必担心自激循环:hydrateMessage 写 DOM 会再唤醒一次本回调,但那一轮体检里
 * 这些槽位已是 ok(锚点在文档内),不再产生写操作,循环到此为止。而 observer 只订阅
 * childList、不订阅 attributes,写 data-theme/内联样式压根不会唤醒它。
 */
export function healSlots(): void {
  let floorsToRehydrate: Set<number> | null = null;

  for (const record of slotRegistry.all()) {
    const host = record.container.host;
    const health = checkSlotHealth(host);
    if (health === 'ok') continue;

    if (health === 'hidden-by-host') {
      // 锚点还在、shadow root 也在,重挂多少次都没用:是祖先 .mes_text 整段被
      // ST 的 inline_media 规则藏了(本楼有 extra.media 且 inline_image === false,
      // 原生出图/打标扩展会写这个组合)。**刻意不去强改它**,只留痕,见 warnHiddenByHost。
      warnHiddenByHost(host);
      continue;
    }

    const floor = floorIdOf(host);
    // 找不到楼层号:该楼整个不在文档里(切聊天/懒渲染卸载),等渲染事件即可。
    // 记录留着不动——hydrateMessage 会在楼层回来时按 desired 集合正常对账。
    if (floor === null) continue;
    (floorsToRehydrate ??= new Set()).add(floor);
  }

  if (!floorsToRehydrate) return;
  const ctx = getContext();
  if (!ctx) return;
  for (const floor of floorsToRehydrate) hydrateMessage(floor, ctx);
}

/** 已提示过的楼层(同一楼别每帧刷一行日志)。 */
const hiddenWarned = new Set<number>();

/**
 * 「卡片被宿主整段隐藏」只留痕,不强改。
 *
 * 为什么不顺手钉一条 `display:block !important` 把它拉回来:那条 `display:none`
 * 是 ST 有意为之——`extra.inline_image === false` 的语义正是「这一楼只看图、不看正文」,
 * 由用户或别的扩展设定。强行解除会把人家特意藏起来的正文一并翻出来,对**现在没毛病**
 * 的人是可见的倒退;而且行内样式一旦钉上就撤不掉了(ST 之后按 extra 重算 class,
 * 却管不到我们写的 style),正是那种「改不了又一直在生效」的暗格。
 *
 * 卡片必须落在 tag 的行内位置(多 tag 楼层按位置分别成图),搬不出 .mes_text——
 * 同一条约束当初也否掉了官方 extra.media 方案。故这一类只能如实报告:
 * 日志给出楼层号与原因,便于用户反馈时一句话定位,不假装修好了。
 */
function warnHiddenByHost(host: Element): void {
  const floor = floorIdOf(host);
  const id = floor ?? -1;
  if (hiddenWarned.has(id)) return;
  hiddenWarned.add(id);
  console.warn(
    `[柏宝绘] 楼层 #${floor ?? '?'} 的卡片已挂载但不可见:该楼 .mes_text 被 ST 的 ` +
      'inline_media 规则整段隐藏(本楼有附件图且 extra.inline_image 为 false)。' +
      '这是宿主的有意行为,插件不强行解除;如需看到卡片,请让该楼恢复显示正文。',
  );
}

/** 绑定自愈(幂等)。返回 false = `#chat` 不在文档里,宿主环境异常。 */
export function bindSlotSelfHealing(): boolean {
  if (healingBound) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;
  healingBound = true;
  onChatMutation(healSlots);
  return true;
}

/**
 * Other ST listeners may still replace .mes_text after an event. Hydrate at the end of the
 * event loop, then check once more; an unchanged anchor only receives a cheap Vue props patch.
 */
function scheduleHydration(
  task: (ctx: STContext) => void,
  lateTask: (ctx: STContext) => void = task,
): void {
  const chatId = getContext()?.getCurrentChatId();
  const run = () => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    task(current);
  };
  setTimeout(run, 0);
  setTimeout(() => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    lateTask(current);
  }, LATE_HYDRATION_DELAY);
}

/**
 * Bind message rendering plus the two recovery events used by ST for generation finalization
 * and loading older history.
 */
export function bindFloorHydration(): boolean {
  if (bound) return true;
  const ctx = getContext();
  if (!ctx?.eventSource) return false;

  bound = true;
  const { eventSource, eventTypes } = ctx;
  const onMessage = (messageId: unknown) => {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;
    scheduleHydration(current => hydrateMessage(id, current));
  };
  const onVisibleReload = () => scheduleHydration(hydrateVisible);
  const onGenerationEnded = (messageCount: unknown) => {
    const id = Number(messageCount) - 1;
    if (Number.isInteger(id) && id >= 0) scheduleHydration(current => hydrateMessage(id, current));
    else onVisibleReload();
  };
  const onFullReload = () => {
    clearAutoGenerateFlags();
    // A deleted/switched chat no longer owns in-flight generation work.
    clearAllGen();
    // 楼层号在新聊天里指向别的楼,已提示过的记录一并作废,否则新聊天里同号楼永久静默
    hiddenWarned.clear();
    scheduleHydration(hydrateAll, hydrateVisible);
  };

  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.MESSAGE_UPDATED, onMessage);
  eventSource.on(eventTypes.MESSAGE_SWIPED, onMessage);
  eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
  if (eventTypes.MORE_MESSAGES_LOADED) {
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, onVisibleReload);
  }
  eventSource.on(eventTypes.MESSAGE_DELETED, onFullReload);
  eventSource.on(eventTypes.CHAT_CHANGED, onFullReload);

  scheduleHydration(hydrateAll, hydrateVisible);

  // 自愈层:兜住 ST 与第三方那些「重写 .mes_text 但不发事件」的路径(见文件头注释)
  bindSlotSelfHealing();

  // 卡片主题改了 → 就地改各卡片 host 的 data-theme(不必重水合,令牌是 CSS 变量,自动生效)
  watch(
    () => settings.ui.cardTheme,
    theme => {
      for (const record of slotRegistry.all()) {
        const host = record.container.host;
        if (host instanceof HTMLElement) host.setAttribute('data-theme', theme || 'st');
      }
    },
  );
  // NAI 并发上限 → 闸门(ComfyUI 不限并发,靠服务端队列)
  watch(
    () => settings.nai.concurrency,
    value => setNaiConcurrency(value),
    { immediate: true },
  );
  return true;
}
