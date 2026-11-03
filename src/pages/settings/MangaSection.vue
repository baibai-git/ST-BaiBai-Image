<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { settings } from '@/state/settings';
import MangaLayoutEditor from '@/pages/settings/MangaLayoutEditor.vue';
import { buildLayoutAtlases, rasterizeLayoutAtlas } from '@/manga/atlas';
import {
  parseCustomLayout,
  normalizeCooldownRounds,
  builtinIds,
  type MangaSettings,
  resolveLayouts,
  type MangaCustomLayout,
  type MangaOrientation,
  canvasOf,
  orientationOf,
  resizeMangaCanvases,
  resizeMangaPanels,
} from '@/manga/layouts';

const ORIENTATIONS: MangaOrientation[] = ['portrait', 'landscape'];

const draft = ref('');
const editing = ref('');
const error = ref('');
const note = ref('');
const quickOpen = ref(false);
const quickSource = ref('');
const quickEditingId = ref('');
const batchWidth = ref(1664), batchHeight = ref(2496);
const batchError = ref('');
const atlasPreview = ref<{ image: string; ids: string[]; orientation: string }[]>([]);
const atlasBusy = ref(false), atlasError = ref('');
async function previewAtlases(): Promise<void> {
  atlasBusy.value=true; atlasError.value=''; atlasPreview.value=[];
  try {
    const atlases=buildLayoutAtlases({portrait:resolveLayouts(settings.manga,'portrait'),landscape:resolveLayouts(settings.manga,'landscape')});
    for (const atlas of atlases) atlasPreview.value.push({image:await rasterizeLayoutAtlas(atlas.svg),ids:atlas.ids,orientation:atlas.orientation});
  } catch (issue) { atlasError.value=issue instanceof Error ? issue.message : String(issue); }
  finally { atlasBusy.value=false; }
}
const resizeBackup = ref<{ before: MangaCustomLayout[]; after: string }>();
const canUndoResize = computed(() => resizeBackup.value?.after === JSON.stringify(settings.manga.custom));
function resizeAllCanvases(): void {
  batchError.value = '';
  try {
    const resized = resizeMangaCanvases(settings.manga, batchWidth.value, batchHeight.value);
    const before = JSON.parse(JSON.stringify(settings.manga.custom));
    settings.manga.custom = resized;
    resizeBackup.value = { before, after: JSON.stringify(resized) };
    note.value = `已调整 ${rows.value.length} 套版式画布，横竖方向保留。`;
  } catch (issue) {
    batchError.value = issue instanceof Error ? issue.message : String(issue);
  }
}
function undoResize(): void {
  if (!canUndoResize.value || !resizeBackup.value) return;
  settings.manga.custom = resizeBackup.value.before;
  resizeBackup.value = undefined;
  note.value = '已撤销本次批量画布调整。';
}
const quickSources = computed(() => ORIENTATIONS.flatMap(orientation => resolveLayouts({ ...settings.manga, disabled: [] }, orientation).map(layout => ({ ...layout, key: `${layout.id}:${orientation}` }))));
const existingIds = computed(() => [...new Set([...ORIENTATIONS.flatMap(builtinIds), ...settings.manga.custom.map(layout => layout.id)])]);
function openQuick(id?: string): void {
  quickEditingId.value = id ?? '';
  quickSource.value = id ? quickSources.value.find(source => source.id === id)?.key ?? '' : '';
  quickOpen.value = true;
}
/** Editing identity is the original ID; changing the field renames that entry. */
function storeLayout(layout: MangaCustomLayout, originalId = ''): boolean {
  if (layout.id !== originalId && existingIds.value.includes(layout.id)) {
    error.value = `版式 ID「${layout.id}」已存在，请使用其他 ID。`;
    return false;
  }
  if (originalId && !existingIds.value.includes(originalId)) {
    error.value = '原版式已不存在，请重新打开编辑器。';
    return false;
  }
  const index = settings.manga.custom.findIndex(entry => entry.id === (originalId || layout.id));
  const disabled = originalId && settings.manga.disabled.includes(originalId);
  if (index >= 0) settings.manga.custom.splice(index, 1, layout);
  else settings.manga.custom.push(layout);
  settings.manga.disabled = settings.manga.disabled.filter(id => id !== originalId && id !== layout.id);
  if (disabled) settings.manga.disabled.push(layout.id);
  settings.manga.deleted = settings.manga.deleted.filter(id => id !== layout.id);
  if (originalId && originalId !== layout.id && builtins.has(originalId) && !settings.manga.deleted.includes(originalId)) {
    settings.manga.deleted.push(originalId); // Do not reveal the built-in again under the old ID.
  }
  note.value = originalId && originalId !== layout.id ? `已将 ${originalId} 改名为 ${layout.id}` : `已保存 ${layout.label ?? layout.id}`;
  return true;
}
function saveQuick(layout: MangaCustomLayout): void {
  const originalId = quickEditingId.value;
  const index = settings.manga.custom.findIndex(entry => entry.id === originalId);
  if (originalId) {
    const orientation = orientationOf(layout.canvas?.width, layout.canvas?.height);
    const standard = canvasOf(orientation);
    const other = orientation === 'portrait' ? 'landscape' : 'portrait';
    const renaming = layout.id !== originalId;
    const previous = renaming || index >= 0 && settings.manga.custom[index][other]?.length
      ? resolveLayouts({ ...settings.manga, disabled: [] }, other).find(entry => entry.id === originalId) : undefined;
    const size = layout.canvas ?? standard;
    // Standard sizes need no global canvas override; retain the other orientation.
    const standardSize = layout.canvas?.width === standard.width && layout.canvas.height === standard.height;
    const original = index >= 0 ? settings.manga.custom[index]
      : renaming ? parseCustomLayout(layoutJson(originalId)) : {};
    layout = { ...original, ...layout };
    if (previous) layout[other] = resizeMangaPanels(previous.panels, previous.canvas, { width: size.height, height: size.width });
    if (standardSize) delete layout.canvas;
  }
  if (!storeLayout(layout, originalId)) return;
  quickOpen.value = false;
}

interface Row {
  id: string;
  label: string;
  usage: string;
  portrait: number;
  landscape: number;
  custom: boolean;
  disabled: boolean;
}

/** 管理列表要看全部版式(含停用),所以传一份 disabled 为空的探针设置进 resolveLayouts。 */
const rows = computed<Row[]>(() => {
  const probe: MangaSettings = { ...settings.manga, disabled: [] };
  const byId = new Map<string, Row>();
  const order: string[] = [];
  for (const orientation of ORIENTATIONS) {
    for (const layout of resolveLayouts(probe, orientation)) {
      if (!byId.has(layout.id)) {
        byId.set(layout.id, {
          id: layout.id,
          label: layout.label,
          usage: layout.usage ?? '',
          portrait: 0,
          landscape: 0,
          custom: settings.manga.custom.some(entry => entry.id === layout.id),
          disabled: false,
        });
        order.push(layout.id);
      }
      const row = byId.get(layout.id)!;
      if (orientation === 'portrait') row.portrait = layout.panels.length;
      else row.landscape = layout.panels.length;
    }
  }
  return order.map(id => ({ ...byId.get(id)!, disabled: settings.manga.disabled.includes(id) }));
});

const activeCount = computed(() => rows.value.filter(row => !row.disabled).length);
const builtins = new Set(ORIENTATIONS.flatMap(builtinIds));

function onUsageChange(id: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (!target) return;
  setUsage(id, target.value);
}

/** 只改用途串：没有覆盖条目就新建一条，坐标仍走内置表。 */
function setUsage(id: string, value: string): void {
  const trimmed = value.trim();
  const index = settings.manga.custom.findIndex(entry => entry.id === id);
  if (index >= 0) {
    const entry = settings.manga.custom[index];
    if (trimmed) entry.usage = trimmed;
    else delete entry.usage;
    if (!entry.usage && !entry.label && !entry.readingOrder && !entry.portrait && !entry.landscape) {
      settings.manga.custom.splice(index, 1);
    }
    return;
  }
  if (!trimmed) return;
  settings.manga.custom.push({ id, usage: trimmed });
}

function toggleDisabled(id: string): void {
  const list = settings.manga.disabled;
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  else list.push(id);
}

function layoutJson(id: string): string {
  const existing = settings.manga.custom.find(entry => entry.id === id);
  const body: Record<string, unknown> = { id };
  for (const orientation of ORIENTATIONS) {
    const probe: MangaSettings = { ...settings.manga, enabled: true, disabled: [] };
    const layout = resolveLayouts(probe, orientation).find(item => item.id === id);
    if (!layout) continue;
    body[orientation] = layout.panels;
    body.usage = layout.usage;
    body.readingOrder = layout.readingOrder;
  }
  body.label = rows.value.find(row => row.id === id)?.label ?? id;
  if (existing) Object.assign(body, existing);
  return JSON.stringify(body, null, 2);
}

function startEdit(id: string): void {
  error.value = '';
  note.value = '';
  editing.value = id;
  draft.value = layoutJson(id);
  void nextTick(() => {
    document.getElementById(`bbi-manga-editor-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function startNew(): void {
  error.value = '';
  note.value = '';
  editing.value = '__new__';
  draft.value = JSON.stringify(
    {
      id: 'my_layout',
      label: '自定义版式',
      usage: '这套版式适合什么节拍',
      readingOrder: '上到下',
      portrait: [
        {
          position: 'single',
          slots: { F: [-924, -504, 924, 504], C: [-908, -488, 908, 488], T: [-906, -486, -555, 486] },
        },
      ],
    },
    null,
    2,
  );
}

function cancel(): void {
  editing.value = '';
  draft.value = '';
  error.value = '';
}

function save(): void {
  error.value = '';
  note.value = '';
  let parsed: MangaCustomLayout;
  try {
    parsed = parseCustomLayout(draft.value);
  } catch (issue) {
    error.value = issue instanceof Error ? issue.message : String(issue);
    return;
  }
  if (!storeLayout(parsed, editing.value === '__new__' ? '' : editing.value)) return;
  editing.value = '';
  draft.value = '';
}

function removeCustom(id: string): void {
  const index = settings.manga.custom.findIndex(entry => entry.id === id);
  if (index >= 0) settings.manga.custom.splice(index, 1);
  const disabled = settings.manga.disabled.indexOf(id);
  if (disabled >= 0) settings.manga.disabled.splice(disabled, 1);
  if (editing.value === id) cancel();
}

function deleteLayout(id: string): void {
  if (builtins.has(id)) {
    if (!settings.manga.deleted.includes(id)) settings.manga.deleted.push(id);
    if (editing.value === id) cancel();
    note.value = `已删除 ${id}，可使用“恢复已删除的默认版式”找回。`;
  } else removeCustom(id);
}

function restoreDeleted(): void {
  settings.manga.deleted = [];
  note.value = '已恢复删除的默认版式，原有用途说明与启用状态保留。';
}

function resetBuiltin(id: string): void {
  removeCustom(id);
  note.value = `已恢复内置 ${id}`;
}
</script>

<template>
  <div class="bbi-manga">
    <label class="bbi-manga-row">
      <input v-model="settings.manga.enabled" type="checkbox" class="bbi-checkbox" />
      <span>启用漫画 Layout（模型只写版式与槽位，坐标由插件查表注入）</span>
    </label>
    <p class="bbi-manga-hint">
      关闭时完全走原本的生图配置：不追加漫画协议，也不改写提示词里的坐标。启用后提示词只带版式清单，
      不再带坐标表——新版式加进这里，下一次请求就会出现在清单里，不需要改提示词。
    </p>
    <p class="bbi-manga-hint">当前可用版式 {{ activeCount }} / {{ rows.length }}。</p>
      <label class="bbi-manga-row">
        <span>版式说明方式</span>
        <select v-model="settings.manga.catalogMode" class="bbi-input" aria-label="版式说明方式">
          <option value="text">文字空间说明</option>
          <option value="image">示意图＋精简槽位清单（视觉模型）</option>
        </select>
      </label>
      <p class="bbi-manga-hint">图片模式每图 4 套，保留原比例、格号、槽位及叠放关系；新增、修改或停用版式后，下一次请求自动重新拼接。本轮只发送方向、画布和冷却筛选后的候选。需指派支持图片的副 API；使用 DSH 时桥接也须支持传图。文字模式沿用现有说明。</p>
      <button type="button" class="bbi-manga-btn" :disabled="atlasBusy" @click="previewAtlases">{{ atlasBusy ? '正在生成拼图…' : '预览版式拼图（每图4套）' }}</button>
      <p v-if="atlasError" role="alert">{{ atlasError }}</p>
      <details v-if="atlasPreview.length" open>
        <summary>版式拼图预览（{{ atlasPreview.length }} 张）</summary>
        <p class="bbi-manga-hint">预览包含当前全部启用版式；实际请求会进一步排除不适用方向、画布与冷却中的 ID。修改版式后可再次点击更新预览。</p>
        <figure v-for="(atlas,index) in atlasPreview" :key="index" style="margin:12px 0">
          <figcaption>{{ atlas.orientation }} · ID {{ atlas.ids.join('、') }} · <a :href="atlas.image" :download="`layout-atlas-${index+1}.png`">下载 PNG</a></figcaption>
          <img :src="atlas.image" :alt="`版式拼图 ${index+1}：${atlas.ids.join('、')}`" style="display:block;width:100%;height:auto;border-radius:8px" />
        </figure>
      </details>
    <label class="bbi-manga-row">
      <span>版式冷却轮数</span>
      <input v-model.number="settings.manga.cooldownRounds" type="number" min="0" max="30" step="1" class="bbi-input"
        aria-label="版式冷却轮数" style="width: 88px"
        @change="settings.manga.cooldownRounds = normalizeCooldownRounds(settings.manga.cooldownRounds)" />
    </label>
    <p class="bbi-manga-hint">默认 3，范围 0～30。按同一聊天成功采纳的自动 tag 请求次数计数，0 关闭跨轮冷却；同轮多页仍不重复。修改后下一次请求生效，无需重发固定规范。</p>
    <button v-if="settings.manga.deleted.length" type="button" class="bbi-manga-btn" @click="restoreDeleted">恢复已删除的默认版式（{{ settings.manga.deleted.length }}）</button>

    <div class="bbi-manga-editor">
      <p class="bbi-manga-hint">
        漫画规范：只在开关打开时生效，留空则沿用「自动生成 tag」里的后端规范框。版式清单由插件自动接在它后面，这里不要写坐标。
      </p>
      <textarea v-model="settings.manga.spec" class="bbi-input bbi-manga-code" spellcheck="false" placeholder="粘贴漫画 1080p 规范全文"></textarea>
      <p class="bbi-manga-hint">
        漫画检查指导：同样只在开关打开时生效，留空则沿用常规思考清单（或插件内置的 Layout 默认）。
      </p>
      <textarea v-model="settings.manga.thinking" class="bbi-input bbi-manga-notes" spellcheck="false" placeholder="粘贴输出前检查指导全文"></textarea>
    </div>

    <div class="bbi-manga-row">
      <label for="bbi-manga-bleed">出框基准（px）</label>
      <input
        id="bbi-manga-bleed"
        class="bbi-input bbi-manga-bleed"
        type="number"
        min="16"
        max="160"
        step="4"
        v-model.number="settings.manga.bleed"
      />
      <span class="bbi-manga-meta">2 格 ×1.25 · 3 格 ×1 · 4 格 ×0.8 · 5 格以上 ×0.6</span>
    </div>

    <div class="bbi-manga-editor">
      <p class="bbi-manga-hint">
        版式选择说明：整段拼入提示词末尾，用来补充说明你想要选择的版式。
      </p>
      <textarea v-model="settings.manga.selectionNotes" class="bbi-input bbi-manga-notes" spellcheck="false" placeholder="留空则只输出插件生成的清单"></textarea>
    </div>

    <div class="bbi-manga-editor bbi-manga-item">
      <strong>批量修改画布大小</strong>
      <div class="bbi-manga-item-actions">
        <label>宽度 <input v-model.number="batchWidth" class="bbi-input bbi-manga-size" type="number" min="64" max="8192" step="2" /></label>
        <label>高度 <input v-model.number="batchHeight" class="bbi-input bbi-manga-size" type="number" min="64" max="8192" step="2" /></label>
        <button type="button" class="bbi-manga-btn" :disabled="quickOpen || !!editing || !rows.length" @click="resizeAllCanvases">一键应用到全部版式（{{ rows.length }}）</button>
        <button v-if="resizeBackup" type="button" class="bbi-manga-btn" :disabled="!canUndoResize" @click="undoResize">撤销本次调整</button>
      </div>
      <p class="bbi-manga-hint">作用于当前列表中的启用及停用版式，保留各自横竖方向，横版自动对调宽高；所有分格、内框和变形角点按比例缩放，读序、层级及框用途保留。完成当前版式编辑后即可批量调整。生图工作流及渠道方向尺寸须与调整后的画布一致。</p>
      <p v-if="resizeBackup" class="bbi-manga-hint">修改或新增其他版式后，撤销本次调整按钮将失效。</p>
      <p v-if="batchError" class="bbi-manga-error" role="alert">{{ batchError }}</p>
    </div>

    <div v-for="row in rows" :key="row.id" class="bbi-manga-item">
      <div class="bbi-manga-item-head">
        <code>{{ row.id }}</code>
        <span class="bbi-manga-label">{{ row.label }}</span>
        <span class="bbi-manga-meta">竖 {{ row.portrait }} 格 · 横 {{ row.landscape }} 格{{ row.custom ? ' · 自定义' : '' }}</span>
        <span v-if="settings.manga.custom.find(item => item.id === row.id)?.canvas" class="bbi-manga-meta">{{ settings.manga.custom.find(item => item.id === row.id)?.canvas?.width }}×{{ settings.manga.custom.find(item => item.id === row.id)?.canvas?.height }}</span>
      </div>
      <input
        class="bbi-input bbi-manga-usage"
        :value="row.usage"
        :placeholder="'这套版式适合什么节拍（留空则模型只能靠格数猜）'"
        @change="onUsageChange(row.id, $event)"
      />
      <div class="bbi-manga-item-actions">
        <label class="bbi-manga-mini">
          <input type="checkbox" class="bbi-checkbox" :checked="!row.disabled" @change="toggleDisabled(row.id)" />
          启用
        </label>
        <button
          type="button"
          class="bbi-manga-btn"
          @click="editing === row.id ? cancel() : startEdit(row.id)"
        >
          {{ editing === row.id ? '收起' : row.custom ? '编辑 / 覆盖' : '改写为自定义' }}
        </button>
        <button type="button" class="bbi-manga-btn" @click="openQuick(row.id)">可视化编辑</button>
        <button v-if="row.custom && builtins.has(row.id)" type="button" class="bbi-manga-btn" @click="resetBuiltin(row.id)">恢复内置</button>
        <button type="button" class="bbi-manga-btn" @click="deleteLayout(row.id)">删除</button>
      </div>

      <div v-if="editing === row.id" :id="`bbi-manga-editor-${row.id}`" class="bbi-manga-editor">
        <textarea v-model="draft" class="bbi-input bbi-manga-code" spellcheck="false"></textarea>
        <div class="bbi-manga-item-actions">
          <button type="button" class="bbi-manga-btn" @click="save">保存</button>
          <button type="button" class="bbi-manga-btn" @click="cancel">取消</button>
        </div>
        <p v-if="error" class="bbi-manga-error">{{ error }}</p>
      </div>
    </div>

    <div class="bbi-manga-item-actions">
      <button type="button" class="bbi-manga-btn" @click="openQuick()">快捷自定义</button>
      <button type="button" class="bbi-manga-btn" @click="startNew">新增版式（JSON）</button>
    </div>
    <p v-if="note" class="bbi-manga-hint" role="status">{{ note }}</p>
    <MangaLayoutEditor v-if="quickOpen" :sources="quickSources" :existing-ids="existingIds" :initial-key="quickSource" :editing-id="quickEditingId" @close="quickOpen=false" @save="saveQuick" />

    <div v-if="editing === '__new__'" class="bbi-manga-editor">
      <p class="bbi-manga-hint">
        版式 JSON：<code>id</code> 与内置同名即覆盖，新名字即追加；<code>portrait</code> / <code>landscape</code>
        各自是「格数组」，每格 <code>position</code> 为位置代号、<code>slots</code> 为槽位到
        <code>[y_min, x_min, y_max, x_max]</code> 的映射。坐标用 1088×1920 或 1920×1088 的内部画布，
        已编译成以画布中心为原点的整数。自定义尺寸可添加 canvas: { width, height }，宽高为 64～8192 的偶数；同时保存横竖版时，另一方向自动对调宽高。
      </p>
      <textarea v-model="draft" class="bbi-input bbi-manga-code" spellcheck="false"></textarea>
      <div class="bbi-manga-item-actions">
        <button type="button" class="bbi-manga-btn" @click="save">保存</button>
        <button type="button" class="bbi-manga-btn" @click="cancel">取消</button>
      </div>
      <p v-if="error" class="bbi-manga-error">{{ error }}</p>
    </div>

    <p v-if="note" class="bbi-manga-hint">{{ note }}</p>
  </div>
</template>

<style scoped>
.bbi-manga {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbi-manga-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.bbi-manga-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.72;
}
.bbi-manga-error {
  margin: 0;
  font-size: 12px;
  color: #b3261e;
}
.bbi-manga-item {
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbi-manga-item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.bbi-manga-item-head code,
.bbi-manga-label {
  font-size: 13px;
}
.bbi-manga-meta {
  font-size: 12px;
  opacity: 0.7;
}
.bbi-manga-item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bbi-manga-mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.bbi-manga-btn {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  background: transparent;
  cursor: pointer;
}
.bbi-manga-size { width: 100px; }
.bbi-manga-item-actions label { display: inline-flex; align-items: center; gap: 5px; }
.bbi-manga-btn:disabled { opacity: 0.45; cursor: default; }
.bbi-manga-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-manga-usage {
  font-size: 12px;
}
.bbi-manga-notes {
  min-height: 96px;
  font-size: 12px;
  line-height: 1.6;
}
.bbi-manga-code {
  min-height: 220px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}
</style>
