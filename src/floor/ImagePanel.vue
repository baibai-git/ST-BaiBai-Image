<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import Card from '@/floor/Card.vue';
import { imagePanel, panelSeq, readPanelSlots, type PanelSlot } from '@/floor/panelSlots';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext } from '@/st/context';
import { parseImageTagContent } from '@/st/imageTagRegex';
import '@/floor/card.css';

const panel = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const close = () => (imagePanel.open = false);
const refresh = () => imagePanel.revision++;

interface PanelRect { x: number; y: number; width: number; height: number }
const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Gesture = 'move' | typeof edges[number];
const positionKey = 'bbi.imagePanel.rect.v1';
const narrowScreen = window.matchMedia('(max-width: 640px)');
const desktop = ref(!narrowScreen.matches);
const viewport = ref(readViewport());
const savedRect = ref(loadRect());
const draftRect = ref<PanelRect | null>(null);
let gesture: { mode: Gesture; pointerId: number; x: number; y: number; start: PanelRect } | null = null;

function readViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function loadRect(): PanelRect | null {
  try {
    const rect = JSON.parse(localStorage.getItem(positionKey) ?? 'null');
    if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return rect;
  } catch {
    // 无法读取本机设置时使用默认位置。
  }
  return null;
}

function saveRect(rect: PanelRect | null): void {
  savedRect.value = rect;
  try {
    if (rect) localStorage.setItem(positionKey, JSON.stringify(rect));
    else localStorage.removeItem(positionKey);
  } catch {
    // 存储不可用时仍可在当前面板使用。
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const bounds = computed(() => {
  const { width, height } = viewport.value;
  const margin = Math.min(12, Math.floor(Math.min(width, height) / 4));
  return {
    margin,
    right: width - margin,
    bottom: height - margin,
    minWidth: Math.min(280, width - 2 * margin),
    minHeight: Math.min(220, height - 2 * margin),
  };
});

const panelRect = computed<PanelRect>(() => {
  const { margin, right, bottom, minWidth, minHeight } = bounds.value;
  const preferred = draftRect.value ?? savedRect.value;
  const width = clamp(preferred?.width ?? 400, minWidth, right - margin);
  const height = clamp(preferred?.height ?? Math.min(680, Math.round(viewport.value.height * 0.8)), minHeight, bottom - margin);
  return {
    x: clamp(preferred?.x ?? right - width, margin, right - width),
    y: clamp(preferred?.y ?? margin, margin, bottom - height),
    width,
    height,
  };
});

const panelStyle = computed(() => {
  if (!desktop.value) return undefined;
  const { x, y, width, height } = panelRect.value;
  return { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` };
});

function adjustRect(start: PanelRect, mode: Gesture, dx: number, dy: number): PanelRect {
  const { margin, right, bottom, minWidth, minHeight } = bounds.value;
  if (mode === 'move') {
    return {
      ...start,
      x: clamp(start.x + dx, margin, right - start.width),
      y: clamp(start.y + dy, margin, bottom - start.height),
    };
  }
  const endX = start.x + start.width;
  const endY = start.y + start.height;
  const x = mode.includes('w') ? clamp(start.x + dx, margin, endX - minWidth) : start.x;
  const y = mode.includes('n') ? clamp(start.y + dy, margin, endY - minHeight) : start.y;
  const nextX = mode.includes('e') ? clamp(endX + dx, x + minWidth, right) : endX;
  const nextY = mode.includes('s') ? clamp(endY + dy, y + minHeight, bottom) : endY;
  return { x, y, width: nextX - x, height: nextY - y };
}

function startGesture(event: PointerEvent, mode: Gesture): void {
  if (!desktop.value || gesture || event.button !== 0 || (event.target as Element).closest('button')) return;
  const { pointerId, clientX: x, clientY: y } = event;
  (event.currentTarget as HTMLElement).setPointerCapture(pointerId);
  gesture = { mode, pointerId, x, y, start: panelRect.value };
  event.preventDefault();
}

function updateGesture(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  draftRect.value = adjustRect(gesture.start, gesture.mode, event.clientX - gesture.x, event.clientY - gesture.y);
}

function finishGesture(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (event.type === 'pointerup' && draftRect.value) {
    updateGesture(event);
    saveRect(panelRect.value);
  }
  gesture = null;
  draftRect.value = null;
}

function resetRect(): void {
  gesture = null;
  draftRect.value = null;
  saveRect(null);
}

function onViewportChange(): void {
  viewport.value = readViewport();
  desktop.value = !narrowScreen.matches;
  gesture = null;
  draftRect.value = null;
}

function onHeaderKey(event: KeyboardEvent): void {
  const steps: Record<string, [number, number]> = {
    ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16],
  };
  const delta = steps[event.key];
  if (!desktop.value || !delta || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  saveRect(adjustRect(panelRect.value, event.shiftKey ? 'se' : 'move', ...delta));
}

const groups = computed(() => {
  void imagePanel.revision;
  const ctx = getContext();
  const chatId = ctx?.getCurrentChatId();
  if (!ctx || !chatId) return [];
  return ctx.chat.flatMap((message, floor) => {
    const slots = readPanelSlots(message);
    if (!slots.length) return [];
    const swipeId = message.swipe_id ?? 0;
    const store = readStore(message);
    const images = slots.map((slot, index) => {
      const seq = panelSeq(index);
      const hash = promptHash(slot.tag);
      const { tag: prompt, ...content } = parseImageTagContent(slot.tag);
      const history = historyEntries(store, swipeId, hash, seq);
      return {
        slot,
        props: {
          ...content, chatId, messageId: floor, swipeId, seq, prompt, tag: slot.tag, history,
          staleEntry: history.length ? null : latestStaleEntry(store, swipeId, hash, seq),
        },
      };
    });
    return [{ floor, chatId, swipeId, images }];
  });
});

async function jumpToText(floor: number, slot: PanelSlot): Promise<void> {
  const selector = `#chat .mes[mesid="${floor}"]`;
  let message = document.querySelector<HTMLElement>(selector);
  if (!message) {
    const first = document.querySelector('#chat .mes[mesid]');
    const count = first ? Number(first.getAttribute('mesid')) - floor : 0;
    const chatId = getContext()?.getCurrentChatId();
    if (count > 0 && chatId) {
      try {
        const hostScript = '/script.js';
        const host = await import(/* @vite-ignore */ hostScript);
        if (getContext()?.getCurrentChatId() !== chatId) return;
        await host.showMoreMessages?.(count);
        if (getContext()?.getCurrentChatId() !== chatId) return;
        message = document.querySelector<HTMLElement>(selector);
      } catch {
        // 某些宿主版本需要用户手动展开更早的楼层。
      }
    }
  }
  if (!message) {
    toastr.info('酒馆尚未加载这条历史楼层，加载更早的消息后即可定位', '柏宝绘');
    return;
  }
  const normalized = (text: string) => text.replace(/[\s*_`~]/g, '');
  const anchor = normalized(slot.excerpt);
  const paragraphs = message.querySelectorAll<HTMLElement>('.mes_text p, .mes_text li');
  const matches = anchor ? Array.from(paragraphs).filter(node => normalized(node.textContent ?? '').includes(anchor)) : [];
  close();
  (matches.length === 1 ? matches[0] : message).scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function focusFloor(): Promise<void> {
  await nextTick();
  if (imagePanel.floor !== null) {
    panel.value?.querySelector(`[data-floor="${imagePanel.floor}"]`)?.scrollIntoView({ block: 'start' });
  }
}

let unsubscribe = () => {};
onMounted(() => {
  window.addEventListener('resize', onViewportChange);
  const ctx = getContext();
  if (ctx?.eventSource.off) {
    const { eventSource, eventTypes } = ctx;
    const events = [eventTypes.CHAT_CHANGED, eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_DELETED,
      eventTypes.MESSAGE_UPDATED, eventTypes.CHARACTER_MESSAGE_RENDERED];
    events.filter(Boolean).forEach(event => eventSource.on(event, refresh));
    unsubscribe = () => events.filter(Boolean).forEach(event => eventSource.off?.(event, refresh));
  }
  refresh();
  closeButton.value?.focus();
  void focusFloor();
});
onUnmounted(() => {
  window.removeEventListener('resize', onViewportChange);
  unsubscribe();
});
watch(() => imagePanel.floor, focusFloor);
</script>

<template>
  <aside
    ref="panel"
    class="bbi-image-panel"
    :data-desktop="desktop ? '' : undefined"
    :style="panelStyle"
    role="dialog"
    aria-label="聊天插图"
    @keydown.esc.stop="close"
    @pointermove="updateGesture"
    @pointerup="finishGesture"
    @pointercancel="finishGesture"
    @lostpointercapture="finishGesture"
  >
    <header
      class="image-panel-header"
      :tabindex="desktop ? 0 : undefined"
      :title="desktop ? '拖动标题栏移动。方向键移动，Shift + 方向键调整大小' : undefined"
      @pointerdown="startGesture($event, 'move')"
      @keydown.self="onHeaderKey"
    >
      <h2>聊天插图</h2>
      <div class="image-panel-actions">
        <button v-if="desktop" type="button" title="恢复默认位置和大小" aria-label="恢复默认位置和大小" @click="resetRect">
          <Icon name="refresh" />
        </button>
        <button ref="closeButton" class="image-panel-close" type="button" aria-label="关闭看图面板" @click="close">
          <Icon name="close" />
        </button>
      </div>
    </header>
    <div class="image-panel-scroll">
      <p v-if="!groups.length" class="image-panel-empty">这个聊天还没有保存到面板的插图。</p>
      <section v-for="group in groups" :key="`${group.chatId}/${group.floor}/${group.swipeId}`" :data-floor="group.floor">
        <h3>第 {{ group.floor }} 楼</h3>
        <article v-for="{ slot, props } in group.images" :key="props.seq" class="image-panel-item">
          <button class="image-panel-jump" type="button" @click="jumpToText(group.floor, slot)">回到正文</button>
          <Card v-bind="props" />
        </article>
      </section>
    </div>
    <template v-if="desktop">
      <div
        v-for="edge in edges"
        :key="edge"
        class="image-panel-resize"
        :data-edge="edge"
        aria-hidden="true"
        @pointerdown="startGesture($event, edge)"
      ></div>
    </template>
  </aside>
</template>

<style scoped>
.bbi-image-panel {
  position: fixed;
  inset: 0 auto auto 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  color: var(--bbi-ink);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px #0004;
  overflow: hidden;
}
.image-panel-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; padding: 12px 14px; }
.image-panel-header h2 { margin: 0; font-size: 17px; }
.image-panel-actions { display: flex; gap: 6px; }
.image-panel-actions button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  color: var(--bbi-ink);
  background: var(--bbi-surface-2);
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.image-panel-actions button:hover { background: var(--bbi-border); }
.image-panel-scroll { flex: 1; min-height: 0; overflow: auto; padding: 0 14px 14px; }
.image-panel-scroll h3 { border-top: 1px solid var(--bbi-border); padding-top: 12px; font-size: 14px; }
.image-panel-item { margin-bottom: 12px; }
.image-panel-jump { border: 0; padding: 2px 0 4px; background: transparent; color: var(--bbi-accent); cursor: pointer; }
.image-panel-empty { padding: 20px 0; }
[data-desktop] .image-panel-header { cursor: move; touch-action: none; user-select: none; }
[data-desktop] .image-panel-scroll { margin-inline: 8px; padding-inline: 6px; }
[data-desktop] .image-panel-item :deep(.bbi-figure__stage),
[data-desktop] .image-panel-item :deep(.bbi-figure__img) { width: 100%; max-height: none; }
.image-panel-resize { position: absolute; z-index: 3; touch-action: none; }
.image-panel-resize:is([data-edge='n'], [data-edge='s']) { left: 14px; right: 14px; height: 8px; cursor: ns-resize; }
.image-panel-resize:is([data-edge='e'], [data-edge='w']) { top: 14px; bottom: 14px; width: 8px; cursor: ew-resize; }
.image-panel-resize:is([data-edge='n'], [data-edge='ne'], [data-edge='nw']) { top: 0; }
.image-panel-resize:is([data-edge='s'], [data-edge='se'], [data-edge='sw']) { bottom: 0; }
.image-panel-resize:is([data-edge='e'], [data-edge='ne'], [data-edge='se']) { right: 0; }
.image-panel-resize:is([data-edge='w'], [data-edge='nw'], [data-edge='sw']) { left: 0; }
.image-panel-resize:is([data-edge='ne'], [data-edge='nw'], [data-edge='se'], [data-edge='sw']) { width: 16px; height: 16px; }
.image-panel-resize:is([data-edge='ne'], [data-edge='sw']) { cursor: nesw-resize; }
.image-panel-resize:is([data-edge='nw'], [data-edge='se']) { cursor: nwse-resize; }
.image-panel-resize:is([data-edge='se'], [data-edge='sw'])::after {
  position: absolute;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-bottom: 1px solid var(--bbi-ink-muted);
  content: '';
}
.image-panel-resize[data-edge='sw']::after { left: 3px; border-left: 1px solid var(--bbi-ink-muted); border-bottom-left-radius: 3px; }
.image-panel-resize[data-edge='se']::after { right: 3px; border-right: 1px solid var(--bbi-ink-muted); border-bottom-right-radius: 3px; }
@media (max-width: 640px) {
  .bbi-image-panel { inset: 0; width: auto; border-radius: 0; padding-bottom: env(safe-area-inset-bottom); }
  .image-panel-header { padding-top: max(12px, env(safe-area-inset-top)); }
  .image-panel-actions button { width: 44px; height: 44px; }
}
</style>
