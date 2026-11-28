<script setup lang="ts">
import { openImagePanel } from '@/floor/panelSlots';
import { settings } from '@/state/settings';
import { closePanel, ui } from '@/state/ui';

function viewImages(): void {
  closePanel();
  openImagePanel();
}
</script>

<template>
  <label class="bbi-switch-row">
    <span class="bbi-field-label">悬浮看图模式</span>
    <input v-model="settings.ui.floatingImagePanel" type="checkbox" class="bbi-checkbox" />
  </label>
  <p class="bbi-field-hint">开启后用悬浮球查看新插图，正文不插入标签。关闭后恢复正文插图。</p>
  <button class="bbi-btn" type="button" @click="viewImages">查看面板插图</button>

  <label v-if="!settings.ui.floatingImagePanel" class="bbi-switch-row">
    <span class="bbi-field-label">显示屏幕悬浮球</span>
    <input v-model="ui.showOrb" type="checkbox" class="bbi-checkbox" />
  </label>
  <p v-if="!settings.ui.floatingImagePanel" class="bbi-field-hint">点击悬浮球打开柏宝绘，可拖动或吸附到屏幕边缘。</p>
</template>
