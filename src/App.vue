<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import NavBar from '@/components/NavBar.vue';
import FloatingOrb from '@/components/FloatingOrb.vue';
import ImagePanel from '@/floor/ImagePanel.vue';
import { imagePanel } from '@/floor/panelSlots';
import { getPage } from '@/pages/registry';
import { settings } from '@/state/settings';
import { closePanel, cycleTheme, lastOpenedAt, modalHost, THEMES, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, ref } from 'vue';

// 题首主题按钮:显示「下一个」主题的图标与名,点击即切换到它
const nextTheme = computed(() => {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  return THEMES[(i + 1) % THEMES.length];
});

// 是否窄屏(移动端):用于 nav 'auto' 的方向判定 + 抽屉手势开关。
// matchMedia 变化 Vue 不会自动追踪,用 ref 桥接成响应式。
const isNarrow = window.matchMedia('(max-width: 640px)');
const narrowFlag = ref(isNarrow.matches);
const onMq = (e: MediaQueryListEvent) => (narrowFlag.value = e.matches);
onMounted(() => isNarrow.addEventListener('change', onMq));
onUnmounted(() => isNarrow.removeEventListener('change', onMq));

const navPlacement = computed<'top' | 'bottom'>(() => {
  if (ui.navPosition === 'top') return 'top';
  if (ui.navPosition === 'bottom') return 'bottom';
  return narrowFlag.value ? 'bottom' : 'top';
});

const current = computed(() => getPage(ui.activePage));

// —— 遮罩点击关闭:仅当按下与松开都在遮罩本身。
// 避免:1) 移动端打开手势的合成 click 穿透秒关;2) 窗内按下拖到窗外误关。
let pressedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressedOnOverlay = e.target === e.currentTarget;
}

function onOverlayClick(e: MouseEvent) {
  const justOpened = performance.now() - lastOpenedAt < 350;
  if (!justOpened && pressedOnOverlay && e.target === e.currentTarget) closePanel();
  pressedOnOverlay = false;
}

// —— 移动端:下滑关闭抽屉 ——
const dragY = ref(0); // 当前下拉位移(px)
const dragging = ref(false);
let startY = 0;
let activePointer: number | null = null;
const CLOSE_THRESHOLD = 110; // 超过此位移松手即关闭

function onHandleDown(e: PointerEvent) {
  if (!narrowFlag.value) return;
  activePointer = e.pointerId;
  startY = e.clientY;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  // 只跟随向下的位移
  dragY.value = Math.max(0, e.clientY - startY);
}

function onHandleUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragY.value > CLOSE_THRESHOLD) {
    closePanel();
  }
  dragY.value = 0;
}

// 抽屉跟手样式:拖动时禁用过渡,松手时回弹有过渡
const windowStyle = computed(() => {
  if (!narrowFlag.value || dragY.value === 0) return undefined;
  return {
    transform: `translateY(${dragY.value}px)`,
    transition: dragging.value ? 'none' : undefined,
  };
});
</script>

<template>
  <div class="bbi-root" :data-theme="ui.theme">
    <!-- 弹窗 Teleport 宿主:.bbi-root 直接子级,在 .bbi-body 滚动容器之外。
         各页弹窗 Teleport 到此,避开 iOS「可滚动祖先内 fixed 后代定位错乱」(详见 state/ui.ts)。 -->
    <div ref="modalHost"></div>
    <!-- 悬浮球:留在 shadow 内才能用 --bbi-* 主题变量;自身 position:fixed 贴边,不受 host 影响 -->
    <FloatingOrb v-if="ui.showOrb || (settings.enabled && settings.ui.floatingImagePanel)" />
    <ImagePanel v-if="imagePanel.open && !ui.open" />
    <Transition name="bbi-fade">
      <div
        v-if="ui.open"
        class="bbi-overlay"
        @pointerdown="onOverlayPointerDown"
        @click="onOverlayClick"
        @keydown.esc="closePanel"
        tabindex="-1"
      >
        <!-- 窗口常驻于遮罩内(不独立 v-if、不嵌套 Transition):
             嵌套 Transition 在父子 v-if 同时翻转时,子的 leave 不会触发(实测窗口直接随父被移除,
             无任何动画)。改由遮罩 Transition 的 class 作后代选择器驱动窗口的进出场动画
             (见 <style> 里 .bbi-fade-enter-from/.bbi-fade-leave-to 下的 .bbi-window)。 -->
        <div class="bbi-window" :style="windowStyle" role="dialog" aria-modal="true" aria-label="柏宝绘">
            <!-- 移动端抓手:可下滑关闭 -->
            <div
              v-if="navPlacement !== 'top' || narrowFlag"
              class="bbi-grabber"
              @pointerdown="onHandleDown"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
            >
              <span class="bbi-grabber-bar"></span>
            </div>

            <!-- 题首 -->
            <header class="bbi-head">
              <span class="bbi-brand-name">柏宝绘</span>
              <div class="bbi-head-actions">
                <button class="bbi-icon-btn" type="button" :title="`切换主题:${nextTheme.label}`" @click="cycleTheme">
                  <Icon :name="nextTheme.icon" />
                </button>
                <button class="bbi-icon-btn" type="button" title="关闭" @click="closePanel">
                  <Icon name="close" />
                </button>
              </div>
            </header>

            <NavBar v-if="navPlacement === 'top'" placement="top" :narrow="narrowFlag" />

            <main class="bbi-body">
              <Transition name="bbi-page" mode="out-in">
                <component :is="current.component" :key="current.id" />
              </Transition>
            </main>

            <NavBar v-if="navPlacement === 'bottom'" placement="bottom" :narrow="narrowFlag" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* —— 移动端抓手:桌面隐藏 —— */
.bbi-grabber {
  display: none;
}

.bbi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  flex: 0 0 auto;
}

.bbi-brand-name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--bbi-ink);
}

.bbi-head-actions {
  display: flex;
  gap: 8px;
}
.bbi-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}
.bbi-icon-btn:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}

/* —— 过渡:遮罩淡入淡出,窗口靠遮罩的过渡 class 联动(见下) —— */
.bbi-fade-enter-active,
.bbi-fade-leave-active {
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.bbi-fade-enter-from,
.bbi-fade-leave-to {
  opacity: 0;
}

/* 窗口进出场:由遮罩 Transition 的 class 作后代选择器驱动(窗口自身不再套 Transition——
   父子 v-if 同时翻转时子 Transition 的 leave 不触发,实测窗口会无动画直接被移除)。
   进出场两端同款 transform → 对称。PC 微升+略放大;移动端在 media query 里改成滑回底部。 */
.bbi-fade-enter-from .bbi-window,
.bbi-fade-leave-to .bbi-window {
  opacity: 0;
  transform: translateY(16px) scale(0.985);
}

.bbi-page-enter-active,
.bbi-page-leave-active {
  transition:
    opacity 0.13s var(--bbi-ease),
    transform 0.13s var(--bbi-ease);
}
.bbi-page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.bbi-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 窗口过渡:进出场(transform+opacity)与拖动回弹(transform)共用;
   拖动跟手时由内联 style 的 transition:none 覆盖,松手回弹再走这条。 */
.bbi-window {
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    opacity var(--bbi-dur) var(--bbi-ease);
}

/* ============ 移动端:抓手 + 抽屉上滑入场 ============ */
@media (max-width: 640px) {
  .bbi-grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    cursor: grab;
    touch-action: none;
  }
  .bbi-grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--bbi-radius-pill);
    background: var(--bbi-line-strong);
  }
  .bbi-head {
    padding: 4px 16px 12px;
  }
  /* 抽屉从底部滑入 / 滑回底部(纯位移,不淡透明) */
  .bbi-fade-enter-from .bbi-window,
  .bbi-fade-leave-to .bbi-window {
    opacity: 1;
    transform: translateY(100%) scale(1);
  }
  /* 遮罩离场延后淡出:让抽屉先滑回底部,背景殿后再撤,否则窗口随遮罩一起被拉透明,
     滑动过程看不见(窗口是遮罩子元素,父 opacity 会合成到子)。 */
  .bbi-fade-leave-active {
    transition: opacity 0.16s var(--bbi-ease) 0.18s;
  }
  /* 窗口滑回底部要走完整 --bbi-dur,不被上面遮罩的短时长牵连(各自 transition 独立,这里仅强调) */
}
</style>
