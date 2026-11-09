<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closePanel, ui } from '@/state/ui';
import { updateState } from '@/update';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();
const shortLabels: Record<string, string> = { backend: '渠道', characters: '角色', gallery: '图库', history: '历史', settings: '设置' };

function showUpdateDot(id: string): boolean {
  return id === 'settings' && updateState.available;
}

// 移动端:再点一下当前页的导航按钮即关闭整窗(省得去够右上角的 ×);非当前页正常切页。
// 受 ui.navTapClose 开关控制(默认开,怕误触的用户可在设置里关)。
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closePanel();
    return;
  }
  ui.activePage = id;
}
</script>

<template>
  <nav class="bbi-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbi-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="bbi-nav-icon-wrap">
        <Icon :name="p.id" class="bbi-nav-icon" />
        <span v-if="showUpdateDot(p.id)" class="bbi-nav-dot" aria-label="有可用更新"></span>
      </span>
      <span class="bbi-nav-label">{{ narrow || placement === 'bottom' ? shortLabels[p.id] : p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bbi-nav {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

/* —— 顶部:胶囊分段,横排图标+字 —— */
.bbi-nav.is-top {
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbi-line);
}
.bbi-nav.is-top .bbi-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--bbi-radius-pill);
  background: transparent;
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    color var(--bbi-dur) var(--bbi-ease);
}
.bbi-nav.is-top .bbi-nav-item:hover {
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
}
.bbi-nav.is-top .bbi-nav-item.is-active {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
.bbi-nav.is-top .bbi-nav-icon {
  font-size: 17px;
}

/* 窄屏文字放在图标下，五项等分。 */
.bbi-nav.is-top.is-narrow {
  justify-content: space-around;
  gap: 0;
  padding: 6px 6px;
}
.bbi-nav.is-top.is-narrow .bbi-nav-item {
  flex: 1;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
  padding: 10px 0;
  border-radius: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
}
.bbi-nav.is-top.is-narrow .bbi-nav-item:hover {
  background: transparent;
  color: var(--bbi-ink-muted);
}
.bbi-nav.is-top.is-narrow .bbi-nav-item.is-active {
  background: transparent;
  color: var(--bbi-accent);
}
.bbi-nav.is-top.is-narrow .bbi-nav-icon {
  font-size: 23px;
}

/* 底部导航同样保留短标签。 */
.bbi-nav.is-bottom {
  justify-content: space-around;
  padding: 6px 6px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--bbi-line);
  background: var(--bbi-surface);
}
.bbi-nav.is-bottom .bbi-nav-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease);
}
.bbi-nav.is-bottom .bbi-nav-icon {
  font-size: 23px;
}
.bbi-nav.is-bottom .bbi-nav-item.is-active {
  color: var(--bbi-accent);
}
.bbi-nav.is-bottom .bbi-nav-label,
.bbi-nav.is-narrow .bbi-nav-label { font-size: 12px; line-height: 1.2; }

.bbi-nav-item:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
  border-radius: var(--bbi-radius-sm);
}

.bbi-nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bbi-nav-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-danger);
  box-shadow: 0 0 0 1.5px var(--bbi-surface);
  pointer-events: none;
}

</style>
