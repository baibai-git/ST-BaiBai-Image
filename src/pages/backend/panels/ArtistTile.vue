<script setup lang="ts">
import { computed } from 'vue';
import { artistPromptGist } from '@/backends/naiArtistLib';
import Icon from '@/components/Icon.vue';
import { artistPreviewSrc } from '@/pages/backend/panels/artistPreview';
import type { NaiArtistPreset } from '@/state/settings';

/**
 * 一张画师串卡片:3:4 封面 + 名字。画师串库与方案的挑选弹窗共用,两处长得一样,
 * 用户在库里看到的就是挑选时看到的。
 *
 * 有图没图混着放:没上传预览图的把画师串本身(去掉 artist: 前缀)铺在色块上当封面,
 * 与有图卡片同尺寸同比例,网格依旧整齐,不看图也认得出。
 *
 * 整张是一个按钮,点击做什么由父组件决定(库 = 打开编辑,挑选 = 选中)。
 */

const props = defineProps<{
  preset: NaiArtistPreset;
  builtin?: boolean;
  /** 选中态:accent 描边环 + 右上角勾(挑选弹窗的「当前用的这条」)。 */
  active?: boolean;
  /** 多选态的勾选框;undefined = 不在多选模式,不画框。 */
  checked?: boolean;
  disabled?: boolean;
}>();

const gist = computed(() => artistPromptGist(props.preset.prompt));
</script>

<template>
  <button
    class="at"
    :class="{ 'is-on': active || checked }"
    type="button"
    :disabled="disabled"
    :title="preset.prompt"
  >
    <span class="at-art">
      <img
        v-if="preset.previewPath"
        class="at-img"
        :src="artistPreviewSrc(preset)"
        :alt="preset.name"
        loading="lazy"
        decoding="async"
      />
      <span v-else class="at-gist" :class="{ 'is-empty': !gist }">{{ gist || '(空)' }}</span>
      <span v-if="checked !== undefined" class="at-box" :class="{ 'is-on': checked }" aria-hidden="true">
        <Icon v-if="checked" name="check" :size="11" />
      </span>
      <span v-else-if="active" class="at-badge" aria-hidden="true">
        <Icon name="check" :size="12" />
      </span>
    </span>
    <span class="at-name">
      <span class="at-name-text">{{ preset.name || '未命名画师串' }}</span>
      <span v-if="builtin" class="at-builtin">内置</span>
    </span>
  </button>
</template>

<style scoped>
.at {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
}
.at:disabled {
  cursor: default;
  opacity: 0.45;
}
.at:focus-visible {
  outline: none;
}
.at:focus-visible .at-art {
  box-shadow: 0 0 0 2px var(--bbi-accent);
}

/* 竖 3:4:NAI 出图多是竖图;有图没图同几何,网格才齐 */
.at-art {
  position: relative;
  display: block;
  aspect-ratio: 3 / 4;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  overflow: hidden;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease);
}
.at:hover:not(:disabled) .at-art {
  border-color: var(--bbi-accent);
}
.at.is-on .at-art {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 2px var(--bbi-accent);
}
.at-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 无图卡片:画师串本身就是「封面」,等宽小字铺满,底部渐隐收尾而非硬截断 */
.at-gist {
  display: block;
  height: 100%;
  padding: 10px 10px 0;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--bbi-ink-soft);
  overflow-wrap: anywhere;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent);
  mask-image: linear-gradient(to bottom, #000 72%, transparent);
}
.at-gist.is-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-family: var(--bbi-font-sans);
  color: var(--bbi-ink-muted);
  -webkit-mask-image: none;
  mask-image: none;
}
.at-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
/* 多选勾:方形,压在封面左上角;底色保证落在浅色图上也看得见 */
.at-box {
  position: absolute;
  top: 6px;
  left: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--bbi-line-strong);
  border-radius: 4px;
  background: var(--bbi-surface);
  color: var(--bbi-accent-ink);
}
.at-box.is-on {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.at-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 0 2px;
}
.at-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
}
.at.is-on .at-name-text {
  color: var(--bbi-accent);
}
.at-builtin {
  flex: none;
  font-size: 11px;
  color: var(--bbi-ink-muted);
}
</style>
