<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 标题文本。用 #header 插槽时可留空。 */
    title?: string;
    /** 初始是否展开 */
    open?: boolean;
  }>(),
  { title: '', open: true },
);

const expanded = ref(props.open);

// 用 grid-template-rows 0fr<->1fr 做高度过渡,无需测量 scrollHeight,内容自适应。
</script>

<template>
  <section class="bbi-collapsible" :class="{ 'is-open': expanded }">
    <button class="bbi-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <!-- 默认只放标题文本;需要在标题行放徽章/元信息时用 #header 插槽覆盖
           (插槽内不要放按钮等可交互元素——整个头本身就是一个 button)。 -->
      <slot name="header">
        <span class="bbi-collapsible-title">{{ title }}</span>
      </slot>
      <Icon name="chevron" class="bbi-collapsible-chevron" />
    </button>
    <div class="bbi-collapsible-outer">
      <div class="bbi-collapsible-inner">
        <div class="bbi-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbi-collapsible {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
}

.bbi-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  cursor: pointer;
  font-family: var(--bbi-font-sans);
  font-size: 16px;
  font-weight: 600;
  text-align: left;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-collapsible-head:hover {
  background: var(--bbi-surface-2);
}
.bbi-collapsible-head:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}

.bbi-collapsible-chevron {
  font-size: 18px;
  color: var(--bbi-ink-muted);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
/* 用直接子代 > 限定:嵌套 Collapsible 时,外层 .is-open 不得波及内层的 outer/chevron,
   否则内层会被外层钉死在展开态、永远收不起来。 */
.bbi-collapsible.is-open > .bbi-collapsible-head .bbi-collapsible-chevron {
  transform: rotate(180deg);
}

/* 高度过渡:grid 0fr -> 1fr */
.bbi-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbi-dur) var(--bbi-ease);
}
.bbi-collapsible.is-open > .bbi-collapsible-outer {
  grid-template-rows: 1fr;
}
.bbi-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.bbi-collapsible-body {
  padding: 14px 16px;
  border-top: 1px solid var(--bbi-line);
}

/* 移动端:折叠区标题略小一号,与窄屏整体节奏更协调 */
@media (max-width: 640px) {
  .bbi-collapsible-head {
    font-size: 14px;
  }
}
</style>
