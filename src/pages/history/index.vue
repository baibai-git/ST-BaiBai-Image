<script setup lang="ts">
import { computed, ref } from 'vue';

import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  clearHistory,
  cacheHitRate,
  records,
  roughTokens,
  type HistoryRecord,
  type LlmRecord,
} from '@/state/history';
import { copyText } from '@/st/clipboard';

/**
 * 请求历史页。
 *
 * 副 API 推理与生图各自的调用收口点(api/client.ts、floor/Card.vue)把过程写进
 * state/history.ts,这里只负责展示。**纯内存,刷新即清空**——定位是调试辅助,
 * 不是资产,所以既不落盘也不提供导出。
 *
 * 结构:一条请求 = 一个折叠区;展开后里面是「一段提示词 = 一行」的只读列表
 * (与设置页「自定义提示词」同款观感),点行进弹窗看全文。
 */

type Filter = 'all' | 'llm' | 'image';

/** 展开后列表里的一段:副 API 是各条 message + 返回,生图是各段提示词。 */
interface Segment {
  /** 行首标签:system / user / assistant / 返回 / 正向提示词 … */
  label: string;
  text: string;
}

const filter = ref<Filter>('all');
/** 弹窗里正在看的那一段(null = 关闭)。 */
const viewing = ref<{ title: string; segment: Segment } | null>(null);

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'llm', label: '副 API' },
  { value: 'image', label: '生图' },
];

const shown = computed(() =>
  filter.value === 'all' ? records : records.filter(r => r.kind === filter.value),
);

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function duration(ms: number | null): string {
  if (ms === null) return '进行中';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusLabel(record: HistoryRecord): string {
  if (record.status === 'running') return '进行中';
  if (record.status === 'ok') return '成功';
  if (record.status === 'aborted') return '已取消';
  return '失败';
}

function title(record: HistoryRecord): string {
  return record.kind === 'llm' ? record.source : `第 ${record.floor} 楼 · 第 ${record.seq + 1} 张`;
}

function subtitle(record: HistoryRecord): string {
  if (record.kind === 'llm') {
    return [record.channelName, record.model].filter(Boolean).join(' · ');
  }
  return [record.backend === 'nai' ? 'NAI' : 'ComfyUI', record.model].filter(Boolean).join(' · ');
}

/**
 * token 数展示。估算值加 ≈ 前缀:估算走的是 ST 主界面当前模型的分词器,
 * 与副 API 渠道模型未必同源,不能与上游返回的真实 usage 混显。
 */
function tokenLabel(record: LlmRecord): string {
  if (record.promptTokens === null) return '';
  return `${record.tokensEstimated ? '≈' : ''}${record.promptTokens.toLocaleString()}`;
}

function tokenTitle(record: LlmRecord): string {
  return record.tokensEstimated
    ? '本地估算：用的是 ST 主界面当前模型的分词器，与本渠道模型未必一致，仅供参考'
    : '上游返回的真实用量（usage）';
}

function cacheLabel(record: LlmRecord, compact = false): string {
  const rate = cacheHitRate(record);
  if (compact) return rate === null ? '缓存 —' : `缓存 ${rate.toFixed(1)}%`;
  return rate === null ? '缓存命中率：未提供' : `缓存命中率 ${rate.toFixed(1)}%`;
}

/** 把一条记录摊成「按顺序的若干段」——展开区就是照这个顺序渲染的。 */
function segments(record: HistoryRecord): Segment[] {
  if (record.kind === 'llm') {
    const out: Segment[] = record.messages.map(m => ({ label: m.role, text: m.content }));
    if (record.response) out.push({ label: '返回', text: record.response });
    return out;
  }
  const out: Segment[] = [{ label: '正向提示词', text: record.prompt }];
  if (record.nl) out.push({ label: '自然语言', text: record.nl });
  for (const character of record.characters ?? []) {
    out.push({
      label: `\u89d2\u8272: ${character.name}`,
      text: [character.tag, character.nl].filter(Boolean).join('\n\n'),
    });
  }
  if (record.negative) out.push({ label: '负面', text: record.negative });
  return out;
}

/** 行内预览:压掉换行,长的靠 CSS 省略号截断。 */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 展开区顶部那排事实标签。 */
function facts(record: HistoryRecord): string[] {
  const out = [subtitle(record), duration(record.durationMs), new Date(record.startedAt).toLocaleString()];
  if (record.kind === 'llm') {
    if (record.stream) out.push('流式');
    // 标题行那个数字是提示词 token(标题行地方紧,不带单位);这里补全口径。
    if (record.promptTokens !== null) out.push(`提示词 ${tokenLabel(record)} token`);
    if (record.completionTokens !== null) {
      out.push(`输出 ${record.tokensEstimated ? '≈' : ''}${record.completionTokens.toLocaleString()} token`);
    }
    if (record.cacheReadTokens !== null) {
      out.push(`缓存命中 ${record.cacheReadTokens.toLocaleString()} token`);
    }
    out.push(cacheLabel(record));
  } else {
    out.push(`种子 ${record.seed}`, record.size);
  }
  return out.filter(Boolean);
}

/** 整条记录拷成文本,方便贴去别处排查。 */
function copyAll(record: HistoryRecord): void {
  const head = [
    `【${title(record)}】${subtitle(record)}`,
    `状态：${statusLabel(record)}  耗时：${duration(record.durationMs)}`,
    record.kind === 'llm' && record.promptTokens !== null
      ? `提示词 token：${tokenLabel(record)}`
      : '',
    record.error ? `错误：${record.error}` : '',
    ...(record.kind === 'llm' ? [cacheLabel(record),
      record.cacheReadTokens !== null ? `缓存命中 token：${record.cacheReadTokens}` : '',
      record.completionTokens !== null ? `输出 token：${record.completionTokens}` : '',
    ].filter(Boolean) : []),
  ].filter(Boolean);
  const body = segments(record).map(s => `--- ${s.label} ---\n${s.text}`);
  void copyText([...head, '', ...body].join('\n'), '记录已复制');
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">请求历史</h2>
      <span class="bbi-count" title="本次会话已记录的请求数">{{ records.length }}</span>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">缓存命中率 = 上游缓存读取 token ÷ 真实输入 token。未提供不等于 0%；当前流式与跟随主 API 路径不采集缓存数据，旧记录无法补算。</p>

    <div class="bbi-hist-bar">
      <div class="bbi-segmented-wrap">
        <div class="bbi-segmented" role="tablist" aria-label="记录类型">
          <button
            v-for="f in FILTERS"
            :key="f.value"
            class="bbi-seg"
            :class="{ 'is-on': filter === f.value }"
            type="button"
            role="tab"
            :aria-selected="filter === f.value"
            @click="filter = f.value"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
      <button
        class="bbi-btn bbi-btn-danger bbi-btn-sm"
        type="button"
        :disabled="!records.length"
        @click="clearHistory"
      >
        <Icon name="trash" /> 清空
      </button>
    </div>

    <!-- 一条请求 = 一个折叠区 -->
    <div v-if="shown.length" class="bbi-sections">
      <Collapsible v-for="record in shown" :key="record.id" :open="false">
        <template #header>
          <span class="bbi-hist-head">
            <span class="bbi-hist-name">{{ title(record) }}</span>
            <span class="bbi-hist-sub">{{ subtitle(record) }}</span>
            <span
              v-if="record.kind === 'llm' && tokenLabel(record)"
              class="bbi-hist-tok"
              :class="{ 'is-est': record.tokensEstimated }"
              :title="tokenTitle(record)"
            >
              {{ tokenLabel(record) }}
            </span>
            <span
              v-if="record.kind === 'llm'"
              class="bbi-hist-tok"
              title="缓存读取 token ÷ 真实输入 token；仅展示上游返回的数据。未提供不等于 0%。"
            >{{ cacheLabel(record, true) }}</span>
            <span class="bbi-hist-time">{{ time(record.startedAt) }}</span>
            <span class="bbi-prompt-state" :class="`is-${record.status}`">{{ statusLabel(record) }}</span>
          </span>
        </template>

        <div class="bbi-hist-facts">
          <span v-for="(f, i) in facts(record)" :key="i" class="bbi-hist-fact">{{ f }}</span>
        </div>

        <p v-if="record.error" class="bbi-hist-error">{{ record.error }}</p>

        <p
          v-if="record.kind === 'llm' && record.tokensEstimated && record.promptTokens !== null"
          class="bbi-field-hint"
        >
          带 ≈ 的 token 数是本地估算：流式与「跟随主 API」拿不到上游用量，
          这里用 ST 主界面当前模型的分词器估的，与本渠道模型未必一致。
        </p>

        <!-- 按顺序的提示词列表:与设置页「自定义提示词」同款行 -->
        <ul class="bbi-prompt-list">
          <li v-for="(seg, i) in segments(record)" :key="i">
            <button
              class="bbi-prompt-open"
              type="button"
              @click="viewing = { title: `${title(record)} · ${seg.label}`, segment: seg }"
            >
              <span class="bbi-prompt-role">{{ seg.label }}</span>
              <span class="bbi-prompt-preview">{{ inline(seg.text) }}</span>
              <span
                class="bbi-prompt-len"
                title="本段 token 粗估（本地按字符估算，仅供段间比较，与标题行的真实用量口径不同）"
              >≈{{ roughTokens(seg.text).toLocaleString() }}</span>
              <Icon name="eye" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>

        <div class="bbi-hist-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="copyAll(record)">
            <Icon name="copy" /> 复制整条
          </button>
        </div>
      </Collapsible>
    </div>
    <p v-else-if="records.length" class="bbi-field-hint">当前筛选下没有记录。</p>
    <p v-else class="bbi-field-hint">
      本次会话还没有请求记录。触发一次自动 tag 或生成一张图，这里就会出现条目（刷新页面会清空）。
    </p>

    <!-- ===== 单段全文弹窗 ===== -->
    <ModalMask :open="!!viewing" @close="viewing = null">
      <div v-if="viewing" class="bbi-modal bbi-modal-wide" role="dialog" aria-modal="true" aria-label="提示词全文">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">{{ viewing.title }}</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="viewing = null">
            <Icon name="close" />
          </button>
        </header>

        <pre class="bbi-hist-text">{{ viewing.segment.text }}</pre>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="copyText(viewing!.segment.text, '已复制')">
            <Icon name="copy" /> 复制
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="viewing = null">完成</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* —— 计数药丸:与角色页/设置页同款观感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.bbi-hist-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 0;
}

/* —— 折叠区标题行:名称 + 渠道 + token + 时间 + 状态 ——
   收缩优先级(挤不下时谁先让路):渠道/模型 → 标题 → 时间;
   token 与状态药丸**永不收缩**——它们是这一行最该被读到的两个值。 */
.bbi-hist-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
/* 标题可收缩(min-width:0 是省略号生效的前提)。
   原先是 flex:0 0 auto 不可收缩,长标题会把后面的 token/状态整个挤出容器——
   窄屏「看不到 token」正是这么来的,不是被 media query 藏了。 */
.bbi-hist-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 渠道/模型:最先让路的那个 */
.bbi-hist-sub {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbi-hist-tok {
  flex: 0 0 auto;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
}
/* 估算值弱化:与真实用量视觉上就分开,免得被当成权威数字 */
.bbi-hist-tok.is-est {
  color: var(--bbi-ink-muted);
  font-weight: 400;
}
.bbi-hist-time {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

/* 状态药丸:复用全局 .bbi-prompt-state 的几何,只改配色。
   成功走它自带的 .is-custom 同款强调色,失败红、取消橙(取消不是故障)。 */
.bbi-prompt-state.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-prompt-state.is-error {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
  border-color: transparent;
}
.bbi-prompt-state.is-aborted {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 展开区:事实标签条 —— */
.bbi-hist-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.bbi-hist-fact {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-soft);
  background: var(--bbi-surface-2);
}

.bbi-hist-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-danger-soft);
  color: var(--bbi-danger);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

/* —— 提示词分段列表:几何照搬设置页「自定义提示词」 —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-prompt-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
/* 角色标签 = 这段提示词的身份,与设置页 .bbi-prompt-name 同口径:走 --bbi-ink。
   定宽让各行预览的左边缘对齐成一条线。
   【宽度按最长标签定】ASSISTANT 是 9 个大写等宽字符 + letter-spacing,原来拍脑袋
   给的 72px 装不下,被省略成「ASSISTAN…」。用 ch 单位跟着字号走,换字号不会再截断。
   【勿改成 --bbi-accent】它在粉彩主题下是 #ffafcc(浅粉,本就是给背景用的,
   配套 --bbi-accent-ink 白字),当文字色压在浅色面上几乎看不见。 */
.bbi-prompt-role {
  flex: 0 0 auto;
  width: 10.5ch;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.bbi-prompt-preview {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* token 粗估:一眼看出哪段最占篇幅,是这个列表最该被读到的值。
   定宽 + 右对齐 + tabular-nums:各行个位对齐成一列,不同位数(≈400 / ≈3,700)
   才能直接比长短;不定宽的话数字随预览宽度浮动,比大小就得逐个读。
   宽度含 ≈ 前缀 + 5 位数(万级),用 ch 跟着字号走。 */
.bbi-prompt-len {
  flex: 0 0 auto;
  width: 7ch;
  text-align: right;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

.bbi-hist-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/* —— 弹窗:更宽 + 长文本限高滚动 —— */
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-hist-text {
  margin: 0;
  padding: 12px 14px;
  max-height: 52vh;
  overflow-y: auto;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  user-select: text;
}

/* —— 危险按钮 / 图标按钮 / 底部占位:scoped 过不了组件边界,各页各抄一份 —— */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.bbi-icon-mini {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

/* —— 窄屏:标题行挤不下,让次要信息退场 ——
   token 与状态**必须留下**:token 是这页的核心信息,比渠道名/时间重要得多。 */
@media (max-width: 640px) {
  .bbi-hist-name {
    font-size: 13px;
  }
  .bbi-hist-sub,
  .bbi-hist-time {
    display: none;
  }
  /* 窄屏:预览让位给 token 估算。估算值是判断「哪段占篇幅」的唯一依据,预览只是
     辅助辨认——两者只能留一个时留数字。预览撤走后靠 margin-left:auto 把它顶回右侧,
     否则会贴着角色标签挤在左边,离眼睛按钮老远、看着也不像一列。
     角色标签宽度不再压缩:压到 56px 会把 ASSISTANT 截断,而它正是要看的身份信息。 */
  .bbi-prompt-preview {
    display: none;
  }
  .bbi-prompt-len {
    margin-left: auto;
    font-size: 12px;
    color: var(--bbi-ink);
  }
  .bbi-hist-text {
    font-size: 11.5px;
  }
}
</style>
