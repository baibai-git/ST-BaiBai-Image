<script setup lang="ts">
import { computed, ref } from 'vue';
import { settings } from '@/state/settings';
import { randomUuid } from '@/randomUuid';
import { importLlmPresets, exportLlmPresets, presetVariables, type LlmPreset } from '@/autoTag/llmPresets';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ModalMask from '@/components/ModalMask.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const input = ref<HTMLInputElement | null>(null);
const list = computed(() => settings.autoTag.llmPresets ?? []);
const selection = computed({
  get: () => settings.autoTag.llmPresetId ?? '',
  set: (id: string) => { settings.autoTag.llmPresetId = id; },
});
const options = computed(() => [{ value: '', label: '内置提示词' }, ...list.value.map(p => ({ value: p.id, label: p.name }))]);
const current = computed(() => list.value.find(p => p.id === selection.value));
const feedback = ref('');
const busy = ref(false);
const draft = ref<LlmPreset | null>(null);
const variableDraft = ref('{}');
const editIndex = ref(0);
const entry = computed(() => draft.value?.entries[editIndex.value]);
const editError = ref('');
const deleting = ref(false);
const roles = ['system', 'user', 'assistant'].map(value => ({ value, label: value }));
const modes = [{ value: 'always', label: '始终启用' }, { value: 'trigger', label: '关键词触发' }];
const role = computed({ get: () => entry.value?.role ?? 'system', set: (v: string) => { if (entry.value) entry.value.role = v as 'system' | 'user' | 'assistant'; } });
const mode = computed({ get: () => entry.value?.triggerMode ?? 'always', set: (v: string) => { if (entry.value) entry.value.triggerMode = v as 'always' | 'trigger'; } });
const entryOptions = computed(() => draft.value?.entries.map((e, i) => ({ value: String(i), label: `${i + 1}. ${e.enabled ? '' : '[停用] '}${e.name}` })) ?? []);
const entrySelection = computed({ get: () => String(editIndex.value), set: (v: string) => { editIndex.value = Number(v); } });

async function importFiles(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  busy.value = true;
  feedback.value = '';
  try {
    const imported: LlmPreset[] = [];
    for (const file of files) imported.push(...importLlmPresets(await file.text(), file.name.replace(/\.json$/i, '')));
    // 同名导入保留原预设，自动加后缀以便切换/回退。
    const names = new Set(list.value.map(p => p.name));
    for (const p of imported) {
      const base = p.name;
      let n = 2;
      while (names.has(p.name)) p.name = `${base} (${n++})`;
      names.add(p.name);
    }
    if (imported.length) {
      settings.autoTag.llmPresets = [...list.value, ...imported];
      selection.value = imported[0].id;
      feedback.value = `已导入 ${imported.length} 个预设、${imported.reduce((n, p) => n + p.entries.length, 0)} 个条目，当前使用「${imported[0].name}」`;
    }
  } catch (error) {
    feedback.value = `导入失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    busy.value = false;
    if (input.value) input.value.value = '';
  }
}

function openEditor(preset?: LlmPreset) {
  draft.value = preset ? JSON.parse(JSON.stringify(preset)) : {
    id: randomUuid(), name: '新预设', entries: [], variables: {},
  };
  variableDraft.value = JSON.stringify(draft.value!.variables, null, 2);
  editIndex.value = 0;
  editError.value = '';
}
function addEntry() {
  if (!draft.value) return;
  draft.value.entries.push({ id: randomUuid(), name: `条目 ${draft.value.entries.length + 1}`, role: 'system', content: '', enabled: true, triggerMode: 'always', triggerWords: '', andTriggerWords: '' });
  editIndex.value = draft.value.entries.length - 1;
}
function removeEntry() {
  draft.value?.entries.splice(editIndex.value, 1);
  editIndex.value = Math.max(0, editIndex.value - 1);
}
function moveEntry(offset: number) {
  const entries = draft.value?.entries;
  const next = editIndex.value + offset;
  if (!entries || next < 0 || next >= entries.length) return;
  const [item] = entries.splice(editIndex.value, 1);
  entries.splice(next, 0, item);
  editIndex.value = next;
}
function save() {
  if (!draft.value) return;
  try {
    if (!draft.value.name.trim()) throw new Error('请填写预设名称');
    if (list.value.some(p => p.id !== draft.value!.id && p.name === draft.value!.name.trim())) throw new Error('预设名称已存在');
    draft.value.variables = presetVariables(JSON.parse(variableDraft.value));
    draft.value.name = draft.value.name.trim();
    const next = list.value.filter(p => p.id !== draft.value!.id);
    const index = list.value.findIndex(p => p.id === draft.value!.id);
    next.splice(index < 0 ? next.length : index, 0, draft.value);
    settings.autoTag.llmPresets = next;
    selection.value = draft.value.id;
    draft.value = null;
  } catch (error) { editError.value = error instanceof Error ? error.message : String(error); }
}
function exportCurrent() {
  if (!current.value) return;
  const url = URL.createObjectURL(new Blob([exportLlmPresets([current.value])], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${current.value.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function remove() {
  settings.autoTag.llmPresets = list.value.filter(p => p.id !== selection.value);
  selection.value = '';
  deleting.value = false;
}
</script>

<template>
  <Collapsible title="自定义预设" :open="false">
    <p class="preset-hint">导入 st-chatu8 的 LLM 生图预设 JSON，保留条目顺序、角色、开关与关键词触发规则。选中后用于自动生成 tag 和 AI 重写提示词，出图渠道沿用当前设置。</p>
    <label class="preset-field"><span>当前预设</span><BbiSelect v-model="selection" :options="options" aria-label="当前 LLM 生图预设" /></label>
    <div class="preset-actions">
      <input ref="input" type="file" accept=".json,application/json" multiple hidden @change="importFiles" />
      <button class="bbi-btn bbi-btn-primary" type="button" :disabled="busy" @click="input?.click()">{{ busy ? '导入中…' : '导入 JSON' }}</button>
      <button class="bbi-btn" type="button" @click="openEditor()">新建</button>
      <button class="bbi-btn" type="button" :disabled="!current" @click="openEditor(current)">编辑</button>
      <button class="bbi-btn" type="button" :disabled="!current" @click="exportCurrent">导出</button>
      <button class="bbi-btn bbi-btn-danger" type="button" :disabled="!current" @click="deleting = true">删除</button>
    </div>
    <p v-if="current" class="preset-hint">{{ current.entries.length }} 个条目 · {{ current.entries.filter(e => e.enabled).length }} 个启用。切回“内置提示词”即可恢复原有规则。</p>
    <p v-if="feedback" class="preset-hint" role="status">{{ feedback }}</p>
  </Collapsible>

  <ModalMask :open="!!draft" @close="draft = null">
    <div v-if="draft" class="bbi-modal preset-modal" role="dialog" aria-modal="true" aria-label="编辑 LLM 生图预设">
      <header class="bbi-modal-head"><span class="bbi-modal-title">编辑自定义预设</span><button class="bbi-btn" type="button" @click="draft = null">关闭</button></header>
      <label class="preset-field"><span>预设名称</span><input v-model="draft.name" class="bbi-input" /></label>
      <label class="preset-field"><span>变量覆盖（JSON）</span><BbiTextarea v-model="variableDraft" :rows="3" :max-rows="6" mono /></label>
      <p class="preset-hint">例如：{ "年龄": "25" }。getvar 宏优先读取这里，其次读取聊天变量；“生图数量”未设置时使用图片数量上限。</p>
      <p class="preset-hint" v-pre>支持 {{正文}}、{{上下文}}、{{世界书触发}}、{{用户需求}}、{{角色启用列表}}、{{通用角色启用列表}}、{{getvar::变量名}} 和 {@getvar::变量名@}。角色列表来自柏宝绘外貌库；服装从角色设定和正文提取。角色/服装调用 ${...}$ 由 LLM 展开为实际描述。</p>
      <label v-if="draft.entries.length" class="preset-field"><span>条目</span><BbiSelect v-model="entrySelection" :options="entryOptions" aria-label="预设条目" /></label>
      <div class="preset-actions">
        <button class="bbi-btn" type="button" @click="addEntry">添加条目</button>
        <button class="bbi-btn" type="button" :disabled="!entry || editIndex === 0" @click="moveEntry(-1)">上移</button>
        <button class="bbi-btn" type="button" :disabled="!entry || editIndex === draft.entries.length - 1" @click="moveEntry(1)">下移</button>
        <button class="bbi-btn" type="button" :disabled="!entry" @click="removeEntry">移除条目</button>
      </div>
      <template v-if="entry">
        <label class="preset-field"><span>条目名称</span><input v-model="entry.name" class="bbi-input" /></label>
        <label class="preset-check"><input v-model="entry.enabled" type="checkbox" />启用该条目</label>
        <div class="preset-pair"><label class="preset-field"><span>角色</span><BbiSelect v-model="role" :options="roles" aria-label="条目角色" /></label><label class="preset-field"><span>触发方式</span><BbiSelect v-model="mode" :options="modes" aria-label="条目触发方式" /></label></div>
        <template v-if="entry.triggerMode === 'trigger'">
          <label class="preset-field"><span>触发词（英文逗号分隔，任一命中）</span><input v-model="entry.triggerWords" class="bbi-input" /></label>
          <label class="preset-field"><span>同时命中的词组（可选，任一命中）</span><input v-model="entry.andTriggerWords" class="bbi-input" /></label>
        </template>
        <label class="preset-field"><span>提示词内容</span><BbiTextarea v-model="entry.content" :rows="8" :max-rows="16" mono /></label>
      </template>
      <p v-if="editError" class="preset-error" role="alert">{{ editError }}</p>
      <footer class="bbi-modal-foot"><button class="bbi-btn" type="button" @click="draft = null">取消</button><button class="bbi-btn bbi-btn-primary" type="button" @click="save">保存并使用</button></footer>
    </div>
  </ModalMask>
  <ConfirmDialog v-model:open="deleting" title="删除自定义预设" confirm-text="删除" @confirm="remove">删除「{{ current?.name }}」后切回内置提示词。</ConfirmDialog>
</template>

<style scoped>
.preset-hint { color: var(--bbi-ink-muted); font-size: 12px; line-height: 1.6; margin: 10px 0; overflow-wrap: anywhere; }
.preset-field { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; min-width: 0; }
.preset-field > span { font-size: 13px; color: var(--bbi-ink-muted); }
.preset-field :deep(.bbi-select-box) { width: 100%; }
.preset-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.preset-modal { width: min(720px, calc(100vw - 32px)); }
.preset-check { display: flex; gap: 8px; align-items: center; }
.preset-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.preset-error { color: var(--bbi-danger, #e66); }
@media (max-width: 480px) { .preset-pair { grid-template-columns: 1fr; gap: 0; } }
</style>
