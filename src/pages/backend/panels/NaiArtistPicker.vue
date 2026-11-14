<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { matchArtist } from '@/backends/naiArtistLib';
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import ArtistTile from '@/pages/backend/panels/ArtistTile.vue';
import { activeNaiPlan, naiArtistFor, newNaiArtist, settings, type NaiArtistPreset, type NaiPlan } from '@/state/settings';

/**
 * 给一套方案挑画师串(方案编辑里点「画风」那一行唤起)。
 *
 * 只做「选」:点一张就写进方案并关窗。改名、换预览图、删除都在设置面板的画师串库里
 * (NaiArtistLibrary.vue)——挑的时候卡片上摆一排编辑钮,只会让「点哪里是选」变得含糊。
 *
 * 卡片与库共用 ArtistTile(有图显示图,没图把画师串铺成封面)。库可能上百条,顶部常驻搜索。
 */

const props = defineProps<{ open: boolean; planId: string }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

function close() {
  emit('update:open', false);
}

const search = ref('');

// 每次打开回到干净状态:上一次的搜索词留着,下次打开会以为库里只剩这几条
watch(
  () => props.open,
  open => {
    if (open) search.value = '';
  },
);

/** 目标方案:指定的那套;已被删 → 当前方案(弹窗关着时也恒有对象可读)。 */
const targetPlan = computed<NaiPlan>(
  () => settings.nai.plans.find(p => p.id === props.planId) ?? activeNaiPlan(),
);
/** 按解析后的引用判定选中:悬空 id 视同「不使用」,与出图实际取值同口径。 */
const currentId = computed(() => naiArtistFor(targetPlan.value)?.id ?? '');

interface PickItem {
  preset: NaiArtistPreset;
  builtin: boolean;
}

const items = computed<PickItem[]>(() => [
  ...BUILTIN_NAI_ARTISTS.map(p => ({ preset: p, builtin: true })),
  ...settings.nai.artistPresets.map(p => ({ preset: p, builtin: false })),
]);
const filtered = computed(() => items.value.filter(i => matchArtist(i.preset, search.value)));

function pick(id: string) {
  targetPlan.value.artistId = id;
  close();
}

/** 库里没有合适的:建一条空白的直接用上,回方案编辑里就能在画师串框里填内容。 */
function createAndPick() {
  const preset = newNaiArtist(`画师串 ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  pick(preset.id);
}
</script>

<template>
  <ModalMask :open="open" top-layer @close="close">
    <div class="bbi-modal pk-modal" role="dialog" aria-modal="true" aria-label="挑选画师串">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">挑选画师串</span>
        <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="close">
          <Icon name="close" />
        </button>
      </header>

      <div class="pk-toolbar">
        <input
          v-model="search"
          class="bbi-input pk-search"
          type="search"
          placeholder="搜索名称或画师串内容…"
          spellcheck="false"
          aria-label="搜索画师串"
        />
        <button class="bbi-btn bbi-btn-sm" type="button" title="新建一条空白画师串并用在本方案" @click="createAndPick">
          <Icon name="plus" :size="12" /> 新建
        </button>
      </div>

      <div class="pk-scroll">
        <div class="pk-grid" role="listbox" aria-label="画师串">
          <!-- 「不使用」常驻第一格,搜索时也不藏:它是一个有意义的选择,不是筛选结果 -->
          <button
            class="pk-card"
            :class="{ 'is-on': !currentId }"
            type="button"
            role="option"
            :aria-selected="!currentId"
            @click="pick('')"
          >
            <span class="pk-art">
              <Icon name="close" :size="20" />
            </span>
            <span class="pk-name">不使用</span>
          </button>

          <ArtistTile
            v-for="item in filtered"
            :key="item.preset.id"
            :preset="item.preset"
            :builtin="item.builtin"
            :active="item.preset.id === currentId"
            role="option"
            :aria-selected="item.preset.id === currentId"
            @click="pick(item.preset.id)"
          />
        </div>
        <p v-if="!filtered.length && search.trim()" class="pk-empty">没有匹配「{{ search }}」的画师串。</p>
      </div>
    </div>
  </ModalMask>
</template>

<style scoped>
/* 比通用弹窗宽一档装网格;固定高度,网格区内滚,头与搜索条钉住。
   .bbi-modal 默认 overflow-y:auto,这里改为 hidden,滚动交给 .pk-scroll。 */
.pk-modal {
  max-width: 720px;
  height: 82vh;
  height: 82dvh;
  overflow: hidden;
}

.pk-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pk-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}

.pk-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.pk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 12px 10px;
  padding: 3px 3px 8px;
}
.pk-empty {
  margin: 0;
  padding: 24px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-soft);
}

/* —— 「不使用」格:自绘,几何与 ArtistTile 对齐(3:4 + 名字行) —— */
.pk-card {
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
.pk-card:focus-visible {
  outline: none;
}
.pk-card:focus-visible .pk-art {
  box-shadow: 0 0 0 2px var(--bbi-accent);
}
.pk-art {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 3 / 4;
  border: 1px dashed var(--bbi-line-strong);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease);
}
.pk-card:hover .pk-art {
  border-color: var(--bbi-accent);
}
.pk-card.is-on .pk-art {
  border-style: solid;
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 2px var(--bbi-accent);
  color: var(--bbi-accent);
}
.pk-name {
  padding: 0 2px;
  font-size: 12.5px;
  font-weight: 600;
}
.pk-card.is-on .pk-name {
  color: var(--bbi-accent);
}

/* 借用的「看起来全局」的类名:只在别的组件 scoped 块里声明,故连 base 规则一起补一份 */
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 12px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

@media (max-width: 640px) {
  .pk-modal {
    max-width: 100%;
  }
  .pk-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
}
</style>
