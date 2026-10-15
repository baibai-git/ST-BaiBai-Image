<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BbiSelect from '@/components/BbiSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { settings, activeNaiArtist } from '@/state/settings';
import {
  captureNaiFullSnapshot,
  applyNaiFullSnapshot,
  newNaiFullPresetId,
  exportNaiFullPreset,
  importNaiFullPreset,
  naiFullSnapshotSignature,
  type NaiFullPreset,
} from '@/state/naiFullPresets';

const nai = computed(() => settings.nai);
const current = computed(() =>
  nai.value.fullPresets.find((p) => p.id === nai.value.activeFullPresetId),
);
const draft = computed(() => captureNaiFullSnapshot(nai.value, activeNaiArtist()));
const name = ref(''),
  message = ref(''),
  error = ref(false),
  confirmOpen = ref(false),
  pendingId = ref(''),
  deleteOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
watch(
  () => current.value?.id,
  () => {
    name.value = current.value?.name || '';
  },
  { immediate: true },
);
const dirty = computed(
  () =>
    !!current.value &&
    (name.value.trim() !== current.value.name ||
      naiFullSnapshotSignature(draft.value) !== naiFullSnapshotSignature(current.value.snapshot)),
);
const options = computed(() => nai.value.fullPresets.map((p) => ({ value: p.id, label: p.name })));
const selected = computed({
  get: () => nai.value.activeFullPresetId,
  set: (id: string) => {
    if (id === nai.value.activeFullPresetId) return;
    if (dirty.value || !current.value) {
      pendingId.value = id;
      confirmOpen.value = true;
    } else activate(id);
  },
});
function note(text: string, isError = false) {
  message.value = text;
  error.value = isError;
}
function activate(id: string) {
  const preset = nai.value.fullPresets.find((p) => p.id === id);
  if (!preset) return;
  const missing = applyNaiFullSnapshot(nai.value, preset.snapshot);
  nai.value.activeFullPresetId = preset.id;
  name.value = preset.name;
  note(
    missing.length
      ? `已应用预设；${missing.length} 个已启用 Vibe 在本地库中缺失，请先导入对应参考图。`
      : '已应用完整预设',
    missing.length > 0,
  );
}
function discardAndSwitch() {
  confirmOpen.value = false;
  activate(pendingId.value);
}
function saveAs() {
  const label = name.value.trim() || '新预设';
  const preset: NaiFullPreset = {
    id: newNaiFullPresetId(),
    name: label.slice(0, 100),
    snapshot: draft.value,
  };
  nai.value.fullPresets.push(preset);
  nai.value.activeFullPresetId = preset.id;
  name.value = preset.name;
  note('已将当前提示词、参数和 Vibe 配置保存为新预设');
}
function update() {
  if (!current.value || !name.value.trim()) return;
  current.value.name = name.value.trim().slice(0, 100);
  current.value.snapshot = draft.value;
  note('已更新当前完整预设');
}
function duplicate() {
  if (!current.value) return;
  const cloned = importNaiFullPreset(exportNaiFullPreset(current.value), draft.value);
  cloned.name = (current.value.name + ' 副本').slice(0, 100);
  nai.value.fullPresets.push(cloned);
  note('已复制保存的预设，可从列表中选择副本');
}
function remove() {
  const id = current.value?.id;
  if (!id) return;
  nai.value.fullPresets = nai.value.fullPresets.filter((p) => p.id !== id);
  nai.value.activeFullPresetId = '';
  name.value = '';
  deleteOpen.value = false;
  note('已删除预设；当前工作配置和参考图继续保留，可另存为新预设');
}
function download() {
  if (!current.value) return;
  const blob = new Blob([exportNaiFullPreset(current.value)], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = (current.value.name.replace(/[\\/:*?"<>|]/g, '_') || 'preset') + '.bbi-nai.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  note('已导出保存的完整预设，未保存改动不在文件中');
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw Error('预设文件不能超过 2 MB');
    const preset = importNaiFullPreset(await file.text(), draft.value);
    nai.value.fullPresets.push(preset);
    note('已导入为新预设；从列表选择后应用，不覆盖当前工作配置');
  } catch (e) {
    note(e instanceof Error ? e.message : '导入失败', true);
  } finally {
    input.value = '';
  }
}
</script>

<template>
  <section class="full-preset">
    <header class="full-head">
      <h3>完整生图预设</h3>
      <span v-if="dirty" class="draft-mark">有未保存改动</span>
    </header>
    <p class="bbi-field-hint">
      画师串、正负面词、模型、尺寸、采样参数和 Vibe 配置一起保存、一起切换。
    </p>
    <span class="bbi-field-label">当前预设</span>
    <BbiSelect
      v-if="options.length"
      v-model="selected"
      :options="options"
      aria-label="完整生图预设"
    />
    <p v-if="!current" class="bbi-field-hint">当前为工作草稿，可填写名称并保存为新预设。</p>
    <label class="bbi-field-label" for="bbi-full-name">预设名称</label>
    <input
      id="bbi-full-name"
      v-model="name"
      class="bbi-input"
      maxlength="100"
      placeholder="例如：V5 水彩人物"
    />
    <div class="full-actions">
      <button class="bbi-btn bbi-btn-primary" type="button" @click="saveAs">保存为新预设</button>
      <button class="bbi-btn" type="button" :disabled="!current || !name.trim()" @click="update">
        更新当前预设
      </button>
      <button class="bbi-btn" type="button" :disabled="!current" @click="duplicate">复制</button>
      <button class="bbi-btn" type="button" :disabled="!current" @click="deleteOpen = true">
        删除
      </button>
      <button class="bbi-btn" type="button" :disabled="!current" @click="download">导出预设</button>
      <button class="bbi-btn" type="button" @click="fileInput?.click()">导入预设</button>
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        accept=".json,application/json"
        aria-label="导入完整生图预设文件"
        @change="upload"
      />
    </div>
    <p
      v-if="message"
      :role="error ? 'alert' : 'status'"
      class="bbi-field-hint"
      :class="{ 'preset-error': error }"
    >
      {{ message }}
    </p>
    <p class="bbi-field-hint">
      下方修改会即时用于生图；点“更新当前预设”才写入此预设。预设不保存 API 地址和密钥，导出只带 Vibe
      启用及强度配置，对应参考图请另外导入。
    </p>
    <div class="full-content"><slot /></div>
  </section>
  <ConfirmDialog
    v-model:open="confirmOpen"
    title="切换完整预设"
    confirm-text="放弃改动并切换"
    @confirm="discardAndSwitch"
  >
    当前配置有未保存改动。取消后可点击“更新当前预设”或“保存为新预设”；继续切换会放弃这些改动。
  </ConfirmDialog>
  <ConfirmDialog
    v-model:open="deleteOpen"
    title="删除完整预设"
    confirm-text="删除"
    tone="danger"
    @confirm="remove"
  >
    删除“{{ current?.name }}”的保存版本？当前工作配置、旧画师串库和 Vibe 图片不会删除。
  </ConfirmDialog>
</template>

<style scoped>
.full-preset {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--bbi-border);
  border-radius: 12px;
  padding: 14px;
  min-width: 0;
}
.full-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.full-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.draft-mark {
  font-size: 11px;
  color: var(--bbi-accent);
}
.full-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.full-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
  min-width: 0;
}
.file-input {
  display: none;
}
.preset-error {
  color: #d45d5d;
}
</style>
