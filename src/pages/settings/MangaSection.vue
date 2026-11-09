<script setup lang="ts">
import { alignMossCanvasDimension } from '@/backends/size';
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { settings } from '@/state/settings';
import Collapsible from '@/components/Collapsible.vue';
import MangaLayoutEditor from '@/pages/settings/MangaLayoutEditor.vue';
import { buildLayoutAtlases, rasterizeLayoutAtlas } from '@/manga/atlas';
import { confirmDialog } from '@/components/confirm';
import { exportMangaLayouts, importMangaLayouts } from '@/manga/library';
import {
  parseCustomLayout,
  normalizeCooldownRounds,
  builtinIds,
  type MangaSettings,
  resolveLayouts,
  planningLayouts,
  orderMangaLayouts,
  type MangaCustomLayout,
  type MangaOrientation,
  canvasOf,
  orientationOf,
  resizeMangaCanvases,
  resizeMangaPanels,
} from '@/manga/layouts';

const ORIENTATIONS: MangaOrientation[] = ['portrait', 'landscape'];

const draft = ref('');
const newJsonEditor = ref<HTMLElement>();
const editing = ref('');
const error = ref('');
const note = ref('');
const quickOpen = ref(false);
const quickSource = ref('');
const quickEditingId = ref('');
const batchWidth = ref(1664), batchHeight = ref(2496);
const batchError = ref('');
const importInput = ref<HTMLInputElement>();
const transferBusy = ref(false), transferError = ref(''), transferNote = ref('');

function exportLayouts(id?:string,legacy=false): void {
  transferError.value=''; transferNote.value='';
  let url:string|undefined;
  try {
    const text=exportMangaLayouts(settings.manga,id,legacy);
    const name=id===undefined ? '全部版式' : id.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');
    url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
    const link=document.createElement('a');
    link.href=url; link.download=`柏宝绘-版式-${name}.json`; link.rel='noopener';
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
    transferNote.value=id===undefined ? `已导出全部 ${rows.value.length} 套版式。` : `已导出版式 ${id}。`;
  } catch (issue) { transferError.value=issue instanceof Error ? issue.message : String(issue); }
  finally { if(url) { const usedUrl=url; setTimeout(()=>URL.revokeObjectURL(usedUrl),60_000); } }
}

async function importLayoutFile(event:Event): Promise<void> {
  const input=event.target as HTMLInputElement;
  const file=input.files?.[0]; input.value='';
  if (!file || transferBusy.value) return;
  transferBusy.value=true; transferError.value=''; transferNote.value='';
  try {
    if (file.size>20*1024*1024) throw new Error('版式文件超过 20 MiB，请拆分后导入。');
    const text=await file.text();
    const preview=importMangaLayouts(settings.manga,text);
    if (preview.replaced || preview.hidden) {
      const confirmed=await confirmDialog({title:'导入版式',text:`将导入 ${preview.count} 套版式，其中 ${preview.replaced} 套同名版式会被覆盖，${preview.hidden} 套当前默认版式会按文件标记隐藏。其他版式保留。`,confirmText:'确认导入'});
      if (!confirmed) return;
    }
    const result=importMangaLayouts(settings.manga,text);
    settings.manga.custom=result.custom; settings.manga.disabled=result.disabled; settings.manga.deleted=result.deleted; settings.manga.order=result.order;
    resizeBackup.value=undefined; atlasPreview.value=[];
    transferNote.value=`已导入 ${result.count} 套版式（覆盖 ${result.replaced} 套），启用状态随文件保留。`;
  } catch (issue) { transferError.value=issue instanceof Error ? issue.message : String(issue); }
  finally { transferBusy.value=false; }
}
const atlasPreview = ref<{ image: string; ids: string[]; orientation: string }[]>([]);
const atlasBusy = ref(false), atlasError = ref('');
async function previewAtlases(): Promise<void> {
  atlasBusy.value=true; atlasError.value=''; atlasPreview.value=[];
  try {
    const atlases=buildLayoutAtlases({portrait:planningLayouts(settings.manga,'portrait'),landscape:planningLayouts(settings.manga,'landscape')});
    for (const atlas of atlases) atlasPreview.value.push({image:await rasterizeLayoutAtlas(atlas.svg),ids:atlas.ids,orientation:atlas.orientation});
  } catch (issue) { atlasError.value=issue instanceof Error ? issue.message : String(issue); }
  finally { atlasBusy.value=false; }
}
const resizeBackup = ref<{ before: MangaCustomLayout[]; after: string }>();
const canUndoResize = computed(() => resizeBackup.value?.after === JSON.stringify(settings.manga.custom));
function alignBatchCanvasInput(): void {
  batchWidth.value=alignMossCanvasDimension(batchWidth.value);batchHeight.value=alignMossCanvasDimension(batchHeight.value);
}
function resizeAllCanvases(): void {
  alignBatchCanvasInput();
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
  settings.manga.order = settings.manga.order?.map(id=>id===originalId ? layout.id : id);
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
  return orderMangaLayouts(order.map(id => ({ ...byId.get(id)!, disabled: settings.manga.disabled.includes(id) })), settings.manga.order);
});

const allEnabled = computed(()=>rows.value.length>0 && rows.value.every(row=>!row.disabled));
function setAllEnabled(enabled:boolean) {
  const ids=new Set(rows.value.map(row=>row.id));
  settings.manga.disabled=enabled ? settings.manga.disabled.filter(id=>!ids.has(id)) : [...new Set([...settings.manga.disabled,...ids])];
}
function moveLayout(from:number,to:number) {
  const ids=rows.value.map(row=>row.id);
  if(from<0 || to<0 || from>=ids.length || to>=ids.length || from===to) return;
  ids.splice(to,0,ids.splice(from,1)[0]); settings.manga.order=ids;
}
const draggingLayout=ref('');
let layoutPointer:number|undefined, layoutList:Element|null=null;
function startLayoutDrag(event:PointerEvent,id:string) {
  if(event.button!==0) return;
  endLayoutDrag(); draggingLayout.value=id; layoutPointer=event.pointerId;
  layoutList=(event.currentTarget as HTMLElement).closest('.bbi-manga-layout-list');
  document.addEventListener('pointermove',dragLayout,true);
  document.addEventListener('pointerup',endLayoutDrag,true);
  document.addEventListener('pointercancel',endLayoutDrag,true);
  event.preventDefault();
}
function dragLayout(event:PointerEvent) {
  if(event.pointerId!==layoutPointer || !draggingLayout.value) return;
  const from=rows.value.findIndex(row=>row.id===draggingLayout.value);
  if(from<0) { endLayoutDrag(); return; }
  let to=from,distance=Infinity;
  layoutList?.querySelectorAll<HTMLElement>('.bbi-manga-layout-card').forEach((row,index)=>{
    const r=row.getBoundingClientRect(),d=Math.abs(event.clientY-r.top-r.height/2);
    if(d<distance) { distance=d;to=index; }
  });
  moveLayout(from,to);
}
function endLayoutDrag() {
  const active=layoutPointer!==undefined;
  draggingLayout.value='';layoutPointer=undefined;layoutList=null;
  if(!active) return;
  document.removeEventListener('pointermove',dragLayout,true);
  document.removeEventListener('pointerup',endLayoutDrag,true);
  document.removeEventListener('pointercancel',endLayoutDrag,true);
}
onBeforeUnmount(endLayoutDrag);

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
  void nextTick(() => newJsonEditor.value?.scrollIntoView({ block: 'nearest' }));
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
      <span>启用漫画 Layout</span>
    </label>
    <p class="bbi-manga-hint">模型分配内容，插件按所选版式编译坐标。</p>
    <label class="bbi-manga-row">
      <input v-model="settings.manga.singleImageMode" type="checkbox" class="bbi-checkbox" aria-label="单图模式（全页一格）" />
      <span>单图模式（全页一格）</span>
    </label>
    <p class="bbi-manga-hint">仅选全页单格版式，允许同轮复用，暂停版式冷却。</p>
    <label class="bbi-manga-row bbi-manga-catalog">
      <span>版式说明方式</span>
      <select v-model="settings.manga.catalogMode" class="bbi-input" aria-label="版式说明方式">
        <option value="text">文字空间说明</option>
        <option value="image">示意图＋槽位清单</option>
      </select>
    </label>
    <p class="bbi-manga-hint">示意图需要副 API 和 DSH 桥接均支持图片输入。</p>
    <details class="bbi-manga-details">
      <summary>版式设置与维护</summary>
      <label class="bbi-manga-row">
        <span>版式冷却轮数</span>
        <input v-model.number="settings.manga.cooldownRounds" :disabled="settings.manga.singleImageMode" type="number" min="0" max="30" step="1" class="bbi-input bbi-manga-size" aria-label="版式冷却轮数" @change="settings.manga.cooldownRounds = normalizeCooldownRounds(settings.manga.cooldownRounds)" />
      </label>
      <p class="bbi-manga-hint">按已采纳请求计数，0 关闭跨轮冷却；同轮多页仍不重复。</p>
      <button type="button" class="bbi-btn bbi-btn-sm" :disabled="atlasBusy" @click="previewAtlases">{{ atlasBusy ? '正在生成拼图…' : '预览版式拼图' }}</button>
      <p v-if="atlasError" class="bbi-manga-error" role="alert">{{ atlasError }}</p>
      <details v-if="atlasPreview.length" open>
        <summary>拼图预览（{{ atlasPreview.length }} 张）</summary>
        <p class="bbi-manga-hint">每图 4 套启用版式。实际请求按方向、画布及冷却筛选。</p>
        <figure v-for="(atlas,index) in atlasPreview" :key="index" style="margin:12px 0">
          <figcaption>{{ atlas.orientation }} · ID {{ atlas.ids.join('、') }} · <a :href="atlas.image" :download="`layout-atlas-${index+1}.png`">下载 PNG</a></figcaption>
          <img :src="atlas.image" :alt="`版式拼图 ${index+1}：${atlas.ids.join('、')}`" style="display:block;width:100%;height:auto" />
        </figure>
      </details>
    <Collapsible title="漫画规范" :open="false">
      <p class="bbi-manga-hint">
        留空沿用后端规范。插件另附版式清单，此处填写内容规则。
      </p>
      <textarea v-model="settings.manga.spec" class="bbi-input bbi-manga-code" spellcheck="false" placeholder="粘贴漫画 1080p 规范全文"></textarea>
    </Collapsible>
    <Collapsible title="漫画检查指导" :open="false">
      <p class="bbi-manga-hint">
        留空沿用常规检查指导或内置默认。
      </p>
      <textarea v-model="settings.manga.thinking" class="bbi-input bbi-manga-notes" spellcheck="false" placeholder="粘贴输出前检查指导全文"></textarea>
    </Collapsible>

    <Collapsible title="版式选择说明" :open="false">
      <p class="bbi-manga-hint">
        追加到提示词末尾，补充选版偏好。
      </p>
      <textarea v-model="settings.manga.selectionNotes" class="bbi-input bbi-manga-notes" spellcheck="false" placeholder="留空则只输出插件生成的清单"></textarea>
    </Collapsible>

    <details class="bbi-manga-details">
      <summary>批量修改画布大小</summary>
      <div class="bbi-manga-item-actions">
        <label>宽度 <input v-model.number="batchWidth" class="bbi-input bbi-manga-size" type="number" min="64" max="8192" step="16" @change="alignBatchCanvasInput" /></label>
        <label>高度 <input v-model.number="batchHeight" class="bbi-input bbi-manga-size" type="number" min="64" max="8192" step="16" @change="alignBatchCanvasInput" /></label>
        <button type="button" class="bbi-btn bbi-btn-sm" :disabled="quickOpen || !!editing || !rows.length" @click="resizeAllCanvases">一键应用到全部版式（{{ rows.length }}）</button>
        <button v-if="resizeBackup" type="button" class="bbi-btn bbi-btn-sm" :disabled="!canUndoResize" @click="undoResize">撤销本次调整</button>
      </div>
      <p class="bbi-manga-hint">按比例缩放全部版式，保留横竖方向、读序和层级。工作流尺寸须与新画布一致。</p>
      <p v-if="resizeBackup" class="bbi-manga-hint">修改或新增其他版式后，撤销本次调整按钮将失效。</p>
      <p v-if="batchError" class="bbi-manga-error" role="alert">{{ batchError }}</p>
    </details>
      <details class="bbi-manga-details"><summary>旧版兼容</summary>
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
    <p class="bbi-manga-hint">仅用于旧版 X 槽的出框兼容；实际 S 等主体框按编辑器坐标，不受此数值影响。</p>

<div class="bbi-manga-item-actions"><button type="button" class="bbi-btn bbi-btn-sm" :disabled="transferBusy || quickOpen || !!editing" @click="exportLayouts(undefined,true)">导出旧版兼容文件</button><button v-if="settings.manga.deleted.length" type="button" class="bbi-btn bbi-btn-sm" @click="restoreDeleted">恢复已删除的默认版式（{{ settings.manga.deleted.length }}）</button></div></details>
      <button type="button" class="bbi-btn bbi-btn-sm" @click="startNew">新建 JSON 版式</button>
    </details>
    <div class="bbi-manga-item-actions">
      <button type="button" class="bbi-btn bbi-btn-sm" @click="openQuick()">新建版式</button>
      <button type="button" class="bbi-btn bbi-btn-sm" :disabled="transferBusy || quickOpen || !!editing" @click="exportLayouts()">导出全部版式（{{ rows.length }}）</button>
      <button type="button" class="bbi-btn bbi-btn-sm" :disabled="transferBusy || quickOpen || !!editing" @click="importInput?.click()">{{ transferBusy ? '正在导入…' : '导入版式' }}</button>
      <input ref="importInput" type="file" accept=".json,application/json" aria-label="导入版式 JSON 文件" hidden @change="importLayoutFile" />
    </div>
    <p v-if="transferNote" class="bbi-manga-hint" role="status">{{ transferNote }}</p>
    <p v-if="transferError" class="bbi-manga-error" role="alert">{{ transferError }}</p>
    <label class="bbi-manga-mini"><input type="checkbox" class="bbi-checkbox" :checked="allEnabled" :indeterminate="activeCount>0 && !allEnabled" :disabled="!rows.length" @change="setAllEnabled(($event.target as HTMLInputElement).checked)" />全部启用（{{ activeCount }}/{{ rows.length }}）</label>
    <p class="bbi-manga-hint">拖动手柄或用上下方向键排序；格内读序、层级保持。</p>
    <div class="bbi-manga-layout-list">
    <div v-for="(row,index) in rows" :key="row.id" class="bbi-manga-item bbi-manga-layout-card" :class="{'is-dragging':draggingLayout===row.id}">
      <div class="bbi-manga-item-head">
        <button type="button" class="bbi-btn bbi-btn-sm bbi-manga-grip" aria-label="拖动版式排序，方向键上下移动" title="拖动排序；方向键上下移动" @pointerdown="startLayoutDrag($event,row.id)" @keydown.up.prevent="moveLayout(index,index-1)" @keydown.down.prevent="moveLayout(index,index+1)">⠿</button>
        <code>{{ row.id }}</code>
        <span class="bbi-manga-label">{{ row.label }}</span>
        <span class="bbi-manga-meta">竖 {{ row.portrait }} 格 · 横 {{ row.landscape }} 格{{ row.custom ? ' · 自定义' : '' }}</span>
        <span v-if="settings.manga.custom.find(item => item.id === row.id)?.canvas" class="bbi-manga-meta">{{ settings.manga.custom.find(item => item.id === row.id)?.canvas?.width }}×{{ settings.manga.custom.find(item => item.id === row.id)?.canvas?.height }}</span>
      </div>
      <input
        class="bbi-input bbi-manga-usage"
        :value="row.usage"
        :placeholder="'版式用途'"
        @change="onUsageChange(row.id, $event)"
      />
      <div class="bbi-manga-item-actions">
        <label class="bbi-manga-mini">
          <input type="checkbox" class="bbi-checkbox" :checked="!row.disabled" @change="toggleDisabled(row.id)" />
          启用
        </label>
        <button type="button" class="bbi-btn bbi-btn-sm" @click="openQuick(row.id)">编辑版式</button>
        <button
          type="button"
          class="bbi-btn bbi-btn-sm"
          @click="editing === row.id ? cancel() : startEdit(row.id)"
        >
          {{ editing === row.id ? '收起 JSON' : 'JSON 编辑' }}
        </button>
        <button type="button" class="bbi-btn bbi-btn-sm" :disabled="transferBusy || quickOpen || !!editing" @click="exportLayouts(row.id)">导出</button>
        <button v-if="row.custom && builtins.has(row.id)" type="button" class="bbi-btn bbi-btn-sm" @click="resetBuiltin(row.id)">恢复内置</button>
        <button type="button" class="bbi-btn bbi-btn-sm" @click="deleteLayout(row.id)">删除</button>
      </div>

      <div v-if="editing === row.id" :id="`bbi-manga-editor-${row.id}`" class="bbi-manga-editor">
        <textarea v-model="draft" class="bbi-input bbi-manga-code" spellcheck="false"></textarea>
        <div class="bbi-manga-item-actions">
          <button type="button" class="bbi-btn bbi-btn-sm" @click="save">保存</button>
          <button type="button" class="bbi-btn bbi-btn-sm" @click="cancel">取消</button>
        </div>
        <p v-if="error" class="bbi-manga-error">{{ error }}</p>
      </div>
    </div>

    </div>
    <p v-if="note" class="bbi-manga-hint" role="status">{{ note }}</p>
    <MangaLayoutEditor v-if="quickOpen" :sources="quickSources" :existing-ids="existingIds" :initial-key="quickSource" :editing-id="quickEditingId" @close="quickOpen=false" @save="saveQuick" />

    <div v-if="editing === '__new__'" ref="newJsonEditor" class="bbi-manga-editor">
      <p class="bbi-manga-hint">
        版式 JSON：<code>id</code> 与内置同名即覆盖，新名字即追加；<code>portrait</code> / <code>landscape</code>
        各自是「格数组」，每格 <code>position</code> 为位置代号、<code>slots</code> 为槽位到
        <code>[y_min, x_min, y_max, x_max]</code> 的映射。坐标用 1088×1920 或 1920×1088 的内部画布，
        已编译成以画布中心为原点的整数。自定义尺寸可添加 canvas: { width, height }，宽高为 64～8192 的偶数；同时保存横竖版时，另一方向自动对调宽高。
      </p>
      <textarea v-model="draft" class="bbi-input bbi-manga-code" spellcheck="false"></textarea>
      <div class="bbi-manga-item-actions">
        <button type="button" class="bbi-btn bbi-btn-sm" @click="save">保存</button>
        <button type="button" class="bbi-btn bbi-btn-sm" @click="cancel">取消</button>
      </div>
      <p v-if="error" class="bbi-manga-error">{{ error }}</p>
    </div>

  </div>
</template>

<style scoped>
.bbi-manga-layout-list { display: grid; gap: 12px; }
.bbi-manga-grip { cursor: grab; touch-action: none; user-select: none; padding: 4px 8px; }
.bbi-manga-grip:active { cursor: grabbing; }
.bbi-manga-layout-card.is-dragging { outline: 1px dashed currentColor; }

.bbi-manga {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbi-manga-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.bbi-manga-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bbi-ink-muted);
}
.bbi-manga-error {
  margin: 0;
  font-size: 12px;
  color: var(--bbi-danger);
}
.bbi-manga-item {
  border-bottom: 1px solid var(--bbi-line);
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbi-manga-item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 14px;
}
.bbi-manga-item-head code,
.bbi-manga-label {
  font-size: 14px;
}
.bbi-manga-meta {
  font-size: 12px;
  color: var(--bbi-ink-muted);
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
.bbi-manga-size { width: 100px; }
.bbi-manga-item-actions label { display: inline-flex; align-items: center; gap: 5px; }
.bbi-manga-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-manga-usage {
  font-size: 14px;
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
.bbi-manga-details { border-top: 1px solid var(--bbi-line); padding: 10px 0; }
.bbi-manga-details > summary { cursor: pointer; font-size: 14px; font-weight: 600; padding: 4px 0; }
.bbi-manga-details[open] > :not(summary) { margin-top: 12px; }
.bbi-manga-details :deep(.bbi-collapsible) { border: 0; border-radius: 0; background: transparent; }
.bbi-manga-details :deep(.bbi-collapsible-head) { padding: 10px 0; font-size: 14px; }
.bbi-manga-details :deep(.bbi-collapsible-body) { padding: 10px 0; }
.bbi-manga-catalog { flex-wrap: wrap; }
.bbi-manga-catalog select { width: auto; max-width: 100%; }
.bbi-manga-bleed { width: 88px; }
.bbi-manga-row > label, .bbi-manga-row > span { flex-shrink: 0; }
.bbi-manga-row:has(.bbi-manga-bleed) { flex-wrap: wrap; }
.bbi-manga .bbi-btn { flex-shrink: 0; }
@media (max-width: 640px) {
  .bbi-manga .bbi-btn, .bbi-manga-details > summary { min-height: 40px; }
  .bbi-manga-details > summary { align-content: center; }
  .bbi-manga-mini { min-height: 40px; }
}
</style>
