<script setup lang="ts">
import { computed, ref } from 'vue';
import { matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import ArtistTile from '@/pages/backend/panels/ArtistTile.vue';
import { artistPreviewSrc, bumpArtistPreview } from '@/pages/backend/panels/artistPreview';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';
import { newNaiArtist, settings, type NaiArtistPreset, type NaiPlan } from '@/state/settings';

/**
 * 画师串库(NAI 面板「画师串库」折叠区里就地展开,不再隔一层「管理」窗口)。
 *
 * 只管**库**:新建、搜索、改名改内容、预览图、复制、删除。**选哪条是方案的事**,
 * 在方案编辑的挑选弹窗(NaiArtistPicker.vue)里做——这里点一行只会打开编辑,
 * 不会顺手改掉任何方案的画风(旧管理器「点卡片 = 启用」常被误触)。
 *
 * 库可能有几十上百条(智绘姬整批导入):卡片网格(与挑选弹窗同一个 ArtistTile,有图显示图,
 * 没图把画师串铺成封面)框定高度自己滚,条目多时才出搜索框;
 * 批量删除收在「多选」模式里,平时不出勾选框。
 *
 * 内置条(bi_*)随插件版本更新,只读:能看、能复制,不能改删。
 * 预览图上传后压成最长边 512 的 jpeg,落 user/images/柏宝绘_画师串/<条目id>.jpg,
 * 路径记在条目 previewPath 上;换图同名覆盖,删条目时连带删文件。
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LibItem {
  preset: NaiArtistPreset;
  builtin: boolean;
}

/** 条目超过这么多才出搜索框:三五条时一个搜索框只是多一行杂物。 */
const SEARCH_THRESHOLD = 6;

const search = ref('');

const items = computed<LibItem[]>(() => [
  ...BUILTIN_NAI_ARTISTS.map(p => ({ preset: p, builtin: true })),
  ...settings.nai.artistPresets.map(p => ({ preset: p, builtin: false })),
]);

const filtered = computed(() => items.value.filter(i => matchArtist(i.preset, search.value)));

/* ============ 多选(只服务于批量删除) ============ */

const multi = ref(false);
/** 勾选集只存用户条目 id;内置条在多选态下点不动,天然进不来。 */
const selected = ref<ReadonlySet<string>>(new Set());

const selectableFiltered = computed(() => filtered.value.filter(i => !i.builtin));
const allFilteredSelected = computed(
  () =>
    selectableFiltered.value.length > 0 &&
    selectableFiltered.value.every(i => selected.value.has(i.preset.id)),
);

function toggleMulti() {
  multi.value = !multi.value;
  selected.value = new Set();
}

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
}

function toggleSelectAllFiltered() {
  const next = new Set(selected.value);
  for (const i of selectableFiltered.value) {
    if (allFilteredSelected.value) next.delete(i.preset.id);
    else next.add(i.preset.id);
  }
  selected.value = next;
}

function onRowClick(item: LibItem) {
  if (!multi.value) {
    openEdit(item);
    return;
  }
  if (!item.builtin) toggleSelect(item.preset.id);
}

/* ============ 编辑弹窗(名字/画师串/正负面词走草稿,预览图即时落盘) ============ */

const editItem = ref<LibItem | null>(null);
const editName = ref('');
const editPrompt = ref('');
const editQuality = ref('');
const editNegative = ref('');
/** 刚点「新建」建出来的:取消 = 连条目一起撤掉,不在库里留一条空的「画师串 N」。 */
const editIsNew = ref(false);

function openEdit(item: LibItem, isNew = false) {
  editItem.value = item;
  editName.value = item.preset.name;
  editPrompt.value = item.preset.prompt;
  editQuality.value = item.preset.quality;
  editNegative.value = item.preset.negative;
  editIsNew.value = isNew;
}

/**
 * 新建先入库再开编辑:预览图要拿条目 id 当文件名,草稿态没处落盘。
 * 取消时由 cancelEdit 撤回(连同可能已上传的预览图)。
 */
function addArtist() {
  const preset = newNaiArtist(`画师串 ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  openEdit({ preset, builtin: false }, true);
}

function cancelEdit() {
  const item = editItem.value;
  editItem.value = null;
  if (item && editIsNew.value) void removeArtists([item.preset]);
}

function saveEdit() {
  const item = editItem.value;
  if (!item || item.builtin) return; // 内置只读(按钮已隐藏,双保险)
  item.preset.name = editName.value.trim();
  item.preset.prompt = editPrompt.value;
  item.preset.quality = editQuality.value;
  item.preset.negative = editNegative.value;
  editItem.value = null;
}

/**
 * 复制 = 按弹窗里**眼下看到的**名字与内容另存一条,原条目不动(未保存的改动不会写回原条目)。
 * 预览图不随副本走:预览文件随原条目删除,共指一个路径会让副本日后破图。
 * 副本插在原条目后面(内置的副本插在用户库最前):库长了,追加到末尾就得滚到底去找。
 */
function duplicateFromEdit() {
  const item = editItem.value;
  if (!item) return;
  const name = editName.value.trim() || '未命名画师串';
  const copy: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${name} 副本`,
    prompt: editPrompt.value,
    quality: editQuality.value,
    negative: editNegative.value,
  };
  const list = settings.nai.artistPresets;
  const index = list.findIndex(p => p.id === item.preset.id);
  list.splice(index + 1, 0, copy);
  openEdit({ preset: copy, builtin: false });
  toastr.success(`已复制为「${copy.name}」`, '画师串');
}

/* ============ 预览图 ============ */

/** 预览图最长边:挑选弹窗的卡片约 140px 宽,512 留足高分屏余量,又不把 user/images 撑大。 */
const PREVIEW_MAX_EDGE = 512;

const previewFileInput = ref<HTMLInputElement | null>(null);
/** 本次上传要为哪条换图;文件框是共享的一个,靠它在 change 时找回目标。 */
let previewTarget: NaiArtistPreset | null = null;
const uploadingId = ref<string | null>(null);

function pickPreview(preset: NaiArtistPreset) {
  if (uploadingId.value) return;
  previewTarget = preset;
  previewFileInput.value?.click();
}

async function onPreviewFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = previewTarget;
  previewTarget = null;
  if (!file || !target) return;
  uploadingId.value = target.id;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const jpeg = await makeJpegThumbnail(dataUrl, PREVIEW_MAX_EDGE, 0.85);
    const base64 = jpeg.split(',')[1] ?? '';
    // 文件名 = 条目 id:换图同名覆盖,不会攒孤儿文件
    target.previewPath = await uploadUserImage(ARTIST_PREVIEW_FOLDER, target.id, base64, 'jpg');
    bumpArtistPreview(target.id);
  } catch (error) {
    toastr.error(errorMessage(error), '预览图上传失败');
  } finally {
    uploadingId.value = null;
  }
}

/** 移除预览:先清字段(界面立即响应),文件删除 best-effort,失败只警告不回滚。 */
async function removePreview(preset: NaiArtistPreset) {
  const path = preset.previewPath;
  if (!path) return;
  preset.previewPath = undefined;
  try {
    await deleteUserImage(path);
  } catch (error) {
    toastr.warning(`预览图引用已移除,但文件清理失败：${errorMessage(error)}`, '画师串');
  }
}

/* ============ 删除(编辑弹窗里的单条与多选批量共用确认框) ============ */

const deleteOpen = ref(false);
const deleteList = ref<NaiArtistPreset[]>([]);
const deleting = ref(false);

/** 被删条目还被哪些方案用着:确认框里点名,删后它们回「不使用画师串」。 */
const deleteAffects = computed<NaiPlan[]>(() => {
  const ids = new Set(deleteList.value.map(p => p.id));
  return settings.nai.plans.filter(p => ids.has(p.artistId));
});

function askDelete(presets: NaiArtistPreset[]) {
  if (!presets.length) return;
  deleteList.value = presets;
  deleteOpen.value = true;
}

function askDeleteSelected() {
  const byId = new Map(settings.nai.artistPresets.map(p => [p.id, p]));
  askDelete([...selected.value].map(id => byId.get(id)).filter((p): p is NaiArtistPreset => !!p));
}

/** 删条目 + 清预览文件 + 把引用它们的方案清成「不使用」(不接位,见 planArtistRemoval)。 */
async function removeArtists(presets: NaiArtistPreset[]): Promise<{ removed: number; fileFailures: number }> {
  const ids = new Set(presets.map(p => p.id));
  const plan = planArtistRemoval(settings.nai.artistPresets, ids);
  // 预览文件清理 best-effort:文件没删掉不阻塞删条目(孤儿文件可手动清,条目删不掉才烦人)
  let fileFailures = 0;
  for (const p of plan.removed) {
    if (!p.previewPath) continue;
    try {
      await deleteUserImage(p.previewPath);
    } catch {
      fileFailures += 1;
    }
  }
  // 按 id 现过滤而非直接用 plan.remaining:上面等删文件期间库可能又被改过(新建/复制)
  settings.nai.artistPresets = settings.nai.artistPresets.filter(a => !ids.has(a.id));
  for (const p of settings.nai.plans) {
    if (ids.has(p.artistId)) p.artistId = '';
  }
  const nextSelected = new Set(selected.value);
  for (const id of ids) nextSelected.delete(id);
  selected.value = nextSelected;
  return { removed: plan.removed.length, fileFailures };
}

async function confirmDelete() {
  if (deleting.value) return;
  deleting.value = true;
  const { removed, fileFailures } = await removeArtists(deleteList.value);
  deleteOpen.value = false;
  deleting.value = false;
  // 删的是正在编辑的那条 → 编辑窗没了对象,一并关掉
  if (editItem.value && !settings.nai.artistPresets.includes(editItem.value.preset) && !editItem.value.builtin) {
    editItem.value = null;
  }
  if (multi.value && !settings.nai.artistPresets.length) multi.value = false;
  if (fileFailures) {
    toastr.warning(`已删除 ${removed} 条,但 ${fileFailures} 张预览图文件清理失败`, '画师串');
  } else {
    toastr.success(`已删除 ${removed} 条画师串`, '画师串');
  }
}

function planNames(plans: NaiPlan[]): string {
  return plans.map(p => `「${p.name || '未命名方案'}」`).join('');
}
</script>

<template>
  <div class="al">
    <input
      v-if="items.length > SEARCH_THRESHOLD"
      v-model="search"
      class="bbi-input al-search"
      type="search"
      placeholder="搜索名称或画师串内容…"
      spellcheck="false"
      aria-label="搜索画师串"
    />

    <div class="al-scroll">
      <p v-if="!filtered.length" class="al-empty">没有匹配「{{ search }}」的画师串。</p>
      <div v-else class="al-grid">
        <ArtistTile
          v-for="item in filtered"
          :key="item.preset.id"
          :preset="item.preset"
          :builtin="item.builtin"
          :checked="multi && !item.builtin ? selected.has(item.preset.id) : undefined"
          :disabled="multi && item.builtin"
          @click="onRowClick(item)"
        />
      </div>
    </div>

    <div class="list-foot">
      <template v-if="!multi">
        <button class="bbi-btn bbi-btn-sm" type="button" @click="addArtist">
          <Icon name="plus" :size="12" />
          新建画师串
        </button>
        <span class="list-foot-spacer"></span>
        <button
          v-if="settings.nai.artistPresets.length"
          class="quiet-btn"
          type="button"
          title="勾选多条一起删除"
          @click="toggleMulti"
        >
          <Icon name="checklist" :size="13" />
          多选
        </button>
      </template>
      <template v-else>
        <span class="al-count">已选 {{ selected.size }} 条</span>
        <button class="quiet-btn" type="button" :disabled="!selectableFiltered.length" @click="toggleSelectAllFiltered">
          {{ allFilteredSelected ? '取消全选' : '全选' }}
        </button>
        <span class="list-foot-spacer"></span>
        <button
          class="bbi-btn bbi-btn-sm bbi-btn-danger"
          type="button"
          :disabled="!selected.size"
          @click="askDeleteSelected"
        >
          <Icon name="trash" :size="12" />
          删除所选
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="toggleMulti">完成</button>
      </template>
    </div>
  </div>

  <!-- 编辑/查看:名称 + 画师串 + 正/负面词 + 预览图 -->
  <ModalMask :open="!!editItem" @close="cancelEdit">
    <div
      v-if="editItem"
      class="bbi-modal al-edit"
      role="dialog"
      aria-modal="true"
      :aria-label="editItem.builtin ? '查看画师串' : '编辑画师串'"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">
          {{ editItem.builtin ? '查看画师串(内置)' : editIsNew ? '新建画师串' : '编辑画师串' }}
        </span>
        <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="cancelEdit">
          <Icon name="close" />
        </button>
      </header>

      <div v-if="!editItem.builtin || editItem.preset.previewPath" class="al-preview">
        <img
          v-if="editItem.preset.previewPath"
          class="al-thumb"
          :src="artistPreviewSrc(editItem.preset)"
          :alt="editItem.preset.name"
        />
        <button
          v-else
          class="al-thumb al-thumb--empty"
          type="button"
          :disabled="uploadingId === editItem.preset.id"
          title="上传预览图"
          @click="pickPreview(editItem.preset)"
        >
          <Icon name="upload" :size="18" />
        </button>
        <div v-if="!editItem.builtin" class="al-preview-ops">
          <span class="bbi-modal-label">预览图</span>
          <span class="al-preview-btns">
            <button
              class="bbi-btn bbi-btn-sm"
              type="button"
              :disabled="uploadingId === editItem.preset.id"
              @click="pickPreview(editItem.preset)"
            >
              {{ uploadingId === editItem.preset.id ? '上传中…' : editItem.preset.previewPath ? '更换' : '上传' }}
            </button>
            <button
              v-if="editItem.preset.previewPath"
              class="bbi-btn bbi-btn-sm bbi-btn-danger"
              type="button"
              @click="removePreview(editItem.preset)"
            >
              移除
            </button>
          </span>
        </div>
      </div>

      <label class="bbi-modal-field">
        <span class="bbi-modal-label">名称</span>
        <input
          v-model="editName"
          class="bbi-input"
          type="text"
          :readonly="editItem.builtin"
          placeholder="画师串名称"
          spellcheck="false"
        />
      </label>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">画师串</span>
        <BbiTextarea
          v-model="editPrompt"
          :rows="4"
          :max-rows="12"
          mono
          :readonly="editItem.builtin"
          placeholder="artist:xxx, artist:yyy"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">正面质量词</span>
        <BbiTextarea
          v-model="editQuality"
          :rows="3"
          :max-rows="10"
          mono
          :readonly="editItem.builtin"
          placeholder="留空 = 使用当前模型的官方质量词"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">负面提示词</span>
        <BbiTextarea
          v-model="editNegative"
          :rows="3"
          :max-rows="10"
          mono
          :readonly="editItem.builtin"
          placeholder="留空 = 使用当前模型的官方负面词"
        />
      </div>

      <p class="bbi-field-hint">正/负面词随画师串一起切换，各自留空时使用当前模型的官方词。</p>

      <footer class="bbi-modal-foot">
        <button
          v-if="!editItem.builtin && !editIsNew"
          class="bbi-btn bbi-btn-danger"
          type="button"
          @click="askDelete([editItem.preset])"
        >
          <Icon name="trash" /> 删除
        </button>
        <button
          v-if="!editIsNew"
          class="bbi-btn"
          type="button"
          title="按眼下的名称与内容另存一条,原条目不变"
          @click="duplicateFromEdit"
        >
          <Icon name="copy" /> {{ editItem.builtin ? '复制为我的画师串' : '复制' }}
        </button>
        <span class="bbi-modal-foot-spacer"></span>
        <template v-if="editItem.builtin">
          <button class="bbi-btn bbi-btn-primary" type="button" @click="cancelEdit">关闭</button>
        </template>
        <template v-else>
          <button class="bbi-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEdit">完成</button>
        </template>
      </footer>
    </div>
  </ModalMask>

  <!-- 删除确认:单条与批量共用;叠在编辑弹窗之上 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    top-layer
    title="删除画师串"
    :confirm-text="deleting ? '删除中…' : '删除'"
    confirm-icon="trash"
    tone="danger"
    :busy="deleting"
    @confirm="confirmDelete"
  >
    <template v-if="deleteList.length === 1">
      确定删除画师串「{{ deleteList[0]?.name || '未命名画师串' }}」?
    </template>
    <template v-else>确定删除选中的 {{ deleteList.length }} 条画师串?</template>
    <template v-if="deleteAffects.length">
      {{ planNames(deleteAffects) }}在用,删除后改为不使用画师串。
    </template>
    删除后无法恢复。
  </ConfirmDialog>

  <input ref="previewFileInput" type="file" accept="image/*" hidden @change="onPreviewFileChange" />
</template>

<style scoped>
.al-search {
  margin-bottom: 8px;
  padding: 6px 10px;
}

/* 库可能上百条:网格框定在约两排半高,自己滚(露出半排提示还能往下滚),
   不把面板下面的 Vibe 库推出视野。卡片与挑选弹窗同一个 ArtistTile,这里看到的就是那里挑的 */
.al-scroll {
  max-height: 400px;
  overflow-y: auto;
}
.al-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 12px 10px;
  /* 给选中描边环(2px box-shadow)留出位置,滚动容器会裁掉溢出 */
  padding: 3px;
}
.al-empty {
  margin: 0;
  padding: 18px 14px;
  font-size: 12.5px;
  color: var(--bbi-ink-muted);
}
.al-count {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--bbi-accent);
  white-space: nowrap;
}

/* —— 编辑弹窗 —— */
.al-edit {
  max-width: 520px;
}
.al-edit .bbi-input[readonly] {
  color: var(--bbi-ink-soft);
}
.al-preview {
  display: flex;
  align-items: center;
  gap: 14px;
}
/* 竖 3:4:NAI 出图多是竖图,与挑选弹窗的卡片同比例,这里看到的就是那里显示的裁切 */
.al-thumb {
  flex: none;
  width: 84px;
  height: 112px;
  object-fit: cover;
  border-radius: var(--bbi-radius-sm);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}
.al-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: var(--bbi-line-strong);
  color: var(--bbi-ink-muted);
  cursor: pointer;
}
.al-thumb--empty:hover:not(:disabled) {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.al-preview-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.al-preview-btns {
  display: flex;
  gap: 6px;
}

/* ==========================================================================
   以下为借用的「看起来全局」的类名:它们只在 NaiPanel / 设置页的 scoped 块里声明,
   scoped 不跨组件,故连 base 规则一起补一份(漏了会渲染成浏览器原生样式)。
   ========================================================================== */
.list-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.list-foot-spacer {
  flex: 1 1 auto;
}
.quiet-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-sans);
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.quiet-btn:hover:not(:disabled) {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
}
.quiet-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.quiet-btn:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}
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
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮(同副 API 渠道弹窗):描边低调,hover 才显红,避免误触 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.bbi-btn-danger:disabled {
  color: var(--bbi-ink-muted);
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
