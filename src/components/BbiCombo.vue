<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * 可输入可下拉的组合框(combobox,交互与副 API 的模型框一致):
 * 输入框既是当前值也是过滤词,聚焦弹出候选菜单;候选为空时退化为普通输入框。
 *
 * 为什么菜单 Teleport 到 modalHost 而不是就地绝对定位(副 API 那个是就地):
 * 本组件用在 Collapsible(overflow:hidden)里,就地定位会被裁剪(柏宝书踩过同款坑),
 * 故与 BbiSelect 同方案 —— 视口级 fixed,由输入框 getBoundingClientRect 推算,
 * 下方空间不足时向上翻。
 *
 * 交互:聚焦/输入展开;↑↓ 移动高亮,Enter 选中,Esc 只关菜单(不触发窗口级 Esc);
 * 点外部(输入框失焦)/滚动/缩放关闭。菜单内 mousedown 一律 preventDefault,
 * 让点击选项/滚动条不抢输入框焦点,选项靠 click 选中。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 候选列表;空数组 = 普通输入框(不弹菜单、不画三角) */
    options: string[];
    placeholder?: string;
    ariaLabel?: string;
    /** 过滤结果展示上限,避免超长列表卡顿 */
    maxShown?: number;
    /** Keep an explicit picker available while its remote options are loading/unavailable. */
    alwaysDropdown?: boolean;
    emptyText?: string;
  }>(),
  { placeholder: '', ariaLabel: undefined, maxShown: 200, alwaysDropdown: false, emptyText: '无匹配项' },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'open'): void }>();

const open = ref(false);
/** 聚焦后用户输入的过滤词;聚焦/关闭时清空(清空=显示全部候选) */
const query = ref('');
const trigger = ref<HTMLInputElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const activeIndex = ref(0);

// 过滤:子串、大小写不敏感;query 为空显示全部
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const out = q ? props.options.filter(o => o.toLowerCase().includes(q)) : props.options;
  return out.slice(0, props.maxShown);
});

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

function openMenu() {
  const el = trigger.value;
  if (!el || open.value || (!props.options.length && !props.alwaysDropdown)) return;
  const rect = el.getBoundingClientRect();
  // 估算菜单高度决定朝向:下方不够且上方更宽裕就向上翻
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 30 + 10);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const upward = below < estimated && rect.top - VIEWPORT_MARGIN > below;
  const space = upward ? rect.top - MENU_GAP - VIEWPORT_MARGIN : below;
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.max(96, Math.min(MENU_MAX_HEIGHT, space))}px`,
    ...(upward
      ? { top: 'auto', bottom: `${window.innerHeight - rect.top + MENU_GAP}px` }
      : { top: `${rect.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
  activeIndex.value = Math.max(0, filtered.value.indexOf(props.modelValue));
  open.value = true;
  emit('open');
  document.addEventListener('keydown', onDocKeydown, true);
  // 菜单是视口级 fixed,不随内容滚动;滚动/缩放时直接关掉,比重算位置干净
  document.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

function closeMenu() {
  if (!open.value) return;
  open.value = false;
  query.value = '';
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
}

function closeOnViewportChange() {
  closeMenu();
}

function onFocus() {
  query.value = '';
  openMenu();
}

function toggleMenu() {
  if (open.value) closeMenu();
  else {
    query.value = '';
    trigger.value?.focus();
    openMenu();
  }
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit('update:modelValue', value);
  query.value = value;
  activeIndex.value = 0;
  openMenu();
}

function pick(option: string) {
  emit('update:modelValue', option);
  closeMenu();
  // 焦点留在输入框(菜单 mousedown 被 prevent,从未失焦),方便继续敲下一个字段
}

function scrollActiveIntoView() {
  menu.value
    ?.querySelectorAll('.bbi-combo-item')
    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = filtered.value.length;
  if (event.key === 'Escape') {
    // 捕获阶段拦截,只关菜单,别触发窗口级 Esc(关整个面板)
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!count) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    if (!count) return;
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter') {
    const option = filtered.value[activeIndex.value];
    if (option) {
      event.preventDefault();
      pick(option);
    }
  }
}

/** 收起态按 ↓ 直接展开(原生 combobox 习惯) */
function onTriggerKeydown(event: KeyboardEvent) {
  if (!open.value && event.key === 'ArrowDown') {
    event.preventDefault();
    openMenu();
  }
}

/** 菜单内 mousedown 全拦:点选项/拖滚动条都不抢输入框焦点,选项走 click 选中 */
function keepFocus() {}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <div class="bbi-combo-box">
    <input
      ref="trigger"
      class="bbi-input bbi-combo-input"
      :class="{ 'has-toggle': alwaysDropdown }"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      spellcheck="false"
      autocomplete="off"
      @input="onInput"
      @focus="onFocus"
      @blur="closeMenu"
      @keydown="onTriggerKeydown"
    />
    <button
      v-if="alwaysDropdown"
      class="bbi-combo-toggle"
      type="button"
      :aria-label="`选择${ariaLabel || '选项'}`"
      :aria-expanded="open"
      @mousedown.prevent
      @click="toggleMenu"
    >
      <Icon name="chevron" :class="{ 'is-open': open }" :size="12" />
    </button>
    <Icon
      v-else-if="options.length"
      name="chevron"
      class="bbi-combo-caret"
      :class="{ 'is-open': open }"
      :size="12"
    />
    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul
        v-if="open"
        ref="menu"
        class="bbi-combo-menu"
        role="listbox"
        :style="menuStyle"
        @mousedown.prevent="keepFocus"
      >
        <li v-if="!filtered.length" class="bbi-combo-empty">{{ query ? '无匹配项' : emptyText }}</li>
        <li
          v-for="(option, i) in filtered"
          :key="option"
          class="bbi-combo-item"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option === modelValue }"
          role="option"
          :aria-selected="option === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
        >
          {{ option }}
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.bbi-combo-box {
  position: relative;
  width: 100%;
  min-width: 0;
}
.bbi-combo-input {
  width: 100%;
  padding-right: 26px; /* 给右侧三角让位 */
}
.bbi-combo-input.has-toggle {
  padding-right: 38px;
}
.bbi-combo-caret {
  position: absolute;
  top: 50%;
  right: 9px;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--bbi-ink-soft);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
.bbi-combo-toggle {
  position: absolute;
  inset: 1px 1px 1px auto;
  width: 34px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--bbi-radius, 8px);
  background: transparent;
  color: var(--bbi-ink-soft);
  cursor: pointer;
}
.bbi-combo-toggle .is-open {
  transform: rotate(180deg);
}

/* 菜单 Teleport 到 modalHost(scoped 样式在同 shadow root 内照常生效) */
.bbi-combo-menu {
  position: fixed;
  z-index: 10001; /* 窗口(10000)之上,与 BbiSelect 菜单同级 */
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  box-shadow: var(--bbi-shadow);
}
.bbi-combo-item {
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  font-size: 12.5px;
  color: var(--bbi-ink);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-combo-item.is-active {
  background: var(--bbi-surface-2);
}
.bbi-combo-item.is-selected {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-combo-empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
</style>
