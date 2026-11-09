<script setup lang="ts">
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { computed, ref } from 'vue';

/**
 * 角色管理 —— 两层固定外貌库:
 * - 全局库:跨所有聊天生效的只读模板,AI 永不修改,仅手动维护(适合玩家角色等固定形象)。
 * - 本聊天库:仅当前聊天,柏宝书自动建档、AI 随剧情变更;同名时优先于全局。
 * 外貌按字段记录(sex/hair/eyes/...),拼接结果即最终 tag;生成 tag 时 AI 照抄库中字段,
 * 残留的 @角色名 占位符由插件兜底替换 —— 外貌稳定不漂移。
 */

type Scope = 'chat' | 'global';

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

// editingName:正在编辑的已有条目名;null = 新建。弹窗开关以 draft 是否存在为准。
const editingName = ref<string | null>(null);
// editingScope:被编辑条目所在层;draftScope:草稿保存到哪层(仅新建时可选)。
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
// 草稿来源:手改内容即转 manual;「从柏宝书重新生成」后转 book。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
// 弹窗内历史面板开关
const historyOpen = ref(false);
// 回滚确认
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  fandom: '同人角色填: character name (copyright name), 不带转义括号; 原创留空',
  sex: '如 1girl / 1boy',
  hair: '如 long black hair',
  eyes: '如 red eyes',
  skin: '如 pale skin(可不填)',
  body: '如 petite, small breasts',
  extra: '如 heterochromia(可不填)',
  outfit: '固定着装,可不填',
};

/** 全局库名字集(响应式),用于分区与「覆盖」徽标。 */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * 本聊天分区 = 派生库里「属于本聊天」的条目:
 * 本聊天基线里的(含覆盖全局的同名条目)+ 非全局的(AI 楼层建档等)。
 * 纯全局条目只出现在全局分区。
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/** 是否整串模式:有 raw 且没有字段。 */
const draftIsRaw = computed(
  () => !!draft.value && !!draft.value.raw.trim() && CHAR_TAG_FIELDS.every(f => !draft.value!.fields[f].trim()),
);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw });
});

/** 正在编辑的本聊天条目的实时历史(回滚后随之刷新);全局条目不记历史。 */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/** 卡片上的字段 chips:有字段用字段,整串模式回退 raw 文本(模板里分支)。 */
function chipsOf(entry: CharTagEntry): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const value = entry.fields[f]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[f], value });
  }
  return chips;
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  historyOpen.value = false;
}

function addEntry(scope: Scope = 'chat') {
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), raw: '', nl: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
  historyOpen.value = false;
}

/* —— 分区折叠(参照柏宝书「计划/悬念」)——
 * 标题行兼作折叠开关;折叠态是本机视图偏好,走 localStorage、不进设置(跨设备同步没意义)。 */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// 无条目即无可折叠:不显示箭头与计数,也强制展开(避免删空后卡在收拢的空态)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/** 手动编辑过的字段 → 条目归手动(但仍可被 AI 变更接管) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('角色名不能为空', '柏宝绘');
    return;
  }
  if (!previewTag.value) {
    toastr.warning('至少填一个外貌字段(或整串 tag)', '柏宝绘');
    return;
  }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  if (ok) closeEntry();
}

/* —— 删除:二次确认 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value) return;
  if (editingScope.value === 'global') removeGlobalCharTag(editingName.value);
  else removeCharTag(editingName.value);
  closeEntry();
}

/* —— 提升为全局 / 复制到本聊天 —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`「${editingName.value}」已提升为全局角色,所有聊天生效`, '柏宝绘');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`已把「${name}」复制到本聊天,之后本聊天以副本为准`, '柏宝绘');
  }
  closeEntry();
}

/* —— 从柏宝书最新状态建档:取最新楼的角色参考,找到同名角色的外貌记录,批量转换接口转字段 —— */
async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填写角色名', '柏宝绘');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('当前没有打开的聊天', '柏宝绘');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(r => r.name === name);
    if (!role?.desc) {
      toastr.info('柏宝书最新状态里没有该角色的外貌记录,可手动填写', '柏宝绘');
      return;
    }
    const [result] = await generateCharTags([{ name, desc: role.desc }]);
    if (!result) {
      toastr.warning('模型没有返回该角色的 tag,请重试或手动填写', '柏宝绘');
      return;
    }
    const fields = { ...emptyCharFields(), ...result.fields };
    d.fields = fields;
    d.raw = '';
    draftSource.value = 'book';
    draftDesc.value = role.desc;
    toastr.success('已按柏宝书最新外貌生成,点「完成」保存', '柏宝绘');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '柏宝绘');
  } finally {
    regenerating.value = false;
  }
}

/* —— 历史展示与回滚(仅本聊天条目) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return '建档';
  if (field === 'raw') return '整串';
  if (field === 'nl') return '自然语言';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`已回滚「${p.name}」的${fieldLabel(p.record.field)}变更`, '柏宝绘');
  } else {
    toastr.warning('回滚失败:条目可能已删除', '柏宝绘');
  }
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? '柏宝书' : entry.source === 'ai' ? 'AI 维护' : '手动';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">角色管理</h2>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      角色固定外貌库:生成 tag 时 AI 照抄库中字段,@角色名 占位符也会被替换为库中最新外貌,稳定不漂移。
    </p>

    <!-- ===== 全局角色库 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !globalFoldable }"
          :disabled="!globalFoldable"
          :aria-expanded="globalShown"
          :title="globalFoldable ? (globalShown ? '收起全局角色库' : '展开全局角色库') : ''"
          @click="toggleFold('global')"
        >
          <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
          <span class="bbi-field-label">全局角色库</span>
          <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="添加全局角色" @click="addEntry('global')">
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height -->
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            所有聊天生效,仅手动维护——AI 不会修改全局角色,适合玩家角色等固定形象。本聊天有同名角色时以本聊天为准。
          </p>
          <ul v-if="globalCharTagLib.entries.length" class="bbi-char-grid">
          <li v-for="entry in globalCharTagLib.entries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'global')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span class="bbi-char-pill is-global">全局</span>
                  <span v-if="charTagBaseNames.has(entry.name)" class="bbi-char-pill is-override" title="本聊天有同名角色,当前聊天以本聊天的为准">
                    本聊天已覆盖
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            还没有全局角色。在本聊天角色的编辑弹窗里点「提升为全局」,或点右上角「+」添加。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 本聊天角色 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? '收起本聊天角色' : '展开本聊天角色') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">本聊天角色</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="添加本聊天角色" @click="addEntry('chat')">
          <Icon name="plus" />
        </button>
      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            仅当前聊天生效:柏宝书角色自动建档,AI 随剧情报告永久变化;可查看历史并回滚。
          </p>
          <ul v-if="chatEntries.length" class="bbi-char-grid">
          <li v-for="entry in chatEntries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'chat')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span
                    class="bbi-char-pill"
                    :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }"
                  >
                    {{ sourceLabel(entry) }}
                  </span>
                  <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="与全局库同名,当前聊天以本条为准">
                    覆盖全局
                  </span>
                  <span
                    v-if="entry.history.length"
                    class="bbi-char-history-badge"
                    :title="`${entry.history.length} 条变更记录,点卡片查看`"
                  >
                    <Icon name="history" />{{ entry.history.length }}
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            本聊天还没有角色。生成 tag 时柏宝书角色会自动建档,也可点右上角「+」手动补。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 角色编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? '编辑角色' : '添加角色' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? '全局' : '本聊天' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <!-- 作用域:仅新建时可选;已有条目换层用底部「提升为全局 / 复制到本聊天」 -->
        <div v-if="!editingName" class="bbi-modal-field">
          <span class="bbi-modal-label">保存到</span>
          <div class="bbi-segmented">
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'chat' }"
              type="button"
              @click="draftScope = 'chat'"
            >
              本聊天
            </button>
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'global' }"
              type="button"
              @click="draftScope = 'global'"
            >
              全局
            </button>
          </div>
          <span class="bbi-field-hint">
            {{ draftScope === 'global' ? '全局:所有聊天生效,AI 不会修改,tag 有问题需手动改。' : '本聊天:仅当前聊天,AI 可随剧情自动变更。' }}
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">角色名</span>
          <input v-model="draft.name" class="bbi-input" placeholder="与正文/柏宝书中的名字一致" @input="markManual" />
        </label>
        <span class="bbi-field-hint">按这个名字去正文和柏宝书角色参考里匹配;AI 引用时也用它(@角色名)。改名不会自动跟随。</span>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">外貌字段</span>
          <div class="bbi-char-form">
            <label
              v-for="f in CHAR_TAG_FIELDS"
              :key="f"
              class="bbi-char-form-row"
              :class="{ 'is-wide': f === 'outfit' }"
            >
              <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
              <input
                v-model="draft.fields[f]"
                class="bbi-input"
                :placeholder="FIELD_PLACEHOLDERS[f]"
                @input="markManual"
              />
            </label>
          </div>
        </div>
        <span class="bbi-field-hint">只写固定基础特征;服装、表情、动作不入库,每次按剧情生成。</span>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">整串模式(可选)</span>
          <BbiTextarea
            v-model="draft.raw"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="留空则用上面的字段拼接;填了整串且字段全空时,以整串为准(旧数据格式)"
            @input="markManual"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">自然语言外貌(可选)</span>
          <BbiTextarea
            v-model="draft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="一句连贯英文外貌描述,自然语言模式下替换 nl 里的 @角色名 用;留空则用 tag 串替换"
            @input="markManual"
          />
        </label>

        <div class="bbi-char-preview">
          <span class="bbi-field-label">最终 tag 预览</span>
          <code class="bbi-char-preview-tag">{{ previewTag || '(空)' }}</code>
          <span v-if="draftIsRaw" class="bbi-char-preview-mode">整串模式</span>
        </div>

        <!-- 变更历史:仅本聊天条目;全局条目无历史(AI 不可改,手动编辑不留痕) -->
        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            变更历史({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">{{ record.floor >= 0 ? `第${record.floor}楼` : '手动' }}·{{ new Date(record.at).toLocaleString() }}</span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="把该字段回滚到变更前的值" @click="askRollback(record)">
                回滚
              </button>
            </li>
          </ul>
        </div>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            v-if="editingName && editingScope === 'chat'"
            class="bbi-btn"
            type="button"
            title="把当前外貌快照进全局库,所有聊天生效;本聊天副本与变更记录将清除"
            @click="askPromote"
          >
            <Icon name="star" /> 提升为全局
          </button>
          <button
            v-if="editingName && editingScope === 'global'"
            class="bbi-btn"
            type="button"
            title="复制为本聊天副本:之后本聊天以副本为准,AI 可对其变更"
            @click="copyToChat"
          >
            <Icon name="copy" /> 复制到本聊天
          </button>
          <button
            class="bbi-btn"
            type="button"
            title="读取柏宝书最新状态里该角色的外貌,重新转换成字段"
            :disabled="regenerating"
            @click="regenerateFromBook"
          >
            <Icon name="refresh" /> {{ regenerating ? '生成中…' : '从柏宝书生成' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">完成</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除角色"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          确定删除「{{ editingName }}」的固定外貌 tag 吗?之后生成时该角色的外貌将不再锚定。
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="提升为全局"
          confirm-text="提升"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          把「{{ editingName }}」的当前外貌快照进全局库?之后所有聊天(包括本聊天)都以全局值为准,
          AI 不能再修改它;本聊天的副本与变更记录将被清除。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 回滚确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="回滚变更"
      confirm-text="回滚"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        把「{{ pendingRollback.name }}」的「{{ fieldLabel(pendingRollback.record.field) }}」从
        <code>{{ pendingRollback.record.to }}</code> 回滚到
        <code>{{ pendingRollback.record.from || '(空)' }}</code> ?
        建档记录的回滚会删除整个条目。
      </template>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* —— 计数药丸:与设置页版本号同款观感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
}

/* —— 分区 —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— 折叠开关(参照柏宝书「计划/悬念」)——
 * 标题行整体可点:左箭头 + 标题 + 计数标。无框透明,折叠是辅助操作,标题仍是主体。 */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右。描边继承 currentColor(muted),hover 整行点亮强调色。 */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 区头右侧小「+」:透明底,hover 才点亮,不喷宾夺主 */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12px;
}

/* —— 角色卡片网格 —— */
.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 16px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* —— 徽标药丸:全局=实心强调;柏宝书/AI=强调浅底;手动=弱化;覆盖=警示色 —— */
.bbi-char-pill {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-global {
  color: var(--bbi-accent-ink);
  background: var(--bbi-accent);
  border-color: transparent;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-char-pill.is-override {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 字段 chips:两行封顶,超出裁切 —— */
.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
/* 整串模式:mono 小字两行截断 */
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* —— 弹窗加宽,容纳两列字段表单 —— */
.bbi-char-modal {
  max-width: 600px;
}

/* —— 字段表单:两列网格,固定着装独占一行 —— */
.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

/* —— 弹窗内历史面板 —— */
.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* —— 最终 tag 预览 —— */
.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
}
</style>
