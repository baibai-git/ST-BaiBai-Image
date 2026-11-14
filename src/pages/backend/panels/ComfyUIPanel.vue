<script setup lang="ts">
import {
  COMFY_TEMPLATE_OPTIONS,
  COMFY_TEMPLATES,
  isComfyTemplateId,
  MOSS_DEFAULT_NEGATIVE,
  simpleDefaults,
  validateSimpleConfig,
  type ComfyPresetMode,
} from '@/backends/comfyTemplates';
import {
  FALLBACK_SAMPLERS,
  FALLBACK_SCHEDULERS,
  fetchComfyModelLists,
  type ComfyModelLists,
} from '@/backends/comfyObjectInfo';
import { getWorkflowPlaceholders, testComfyConnection } from '@/backends/comfyui';
import {
  configureWorkflowWithAi,
  type WorkflowAssistResult,
  type WorkflowBindingPurpose,
} from '@/backends/comfyWorkflowAssistant';
import BbiCombo from '@/components/BbiCombo.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  activeComfyPreset,
  BUILTIN_COMFY_PROMPT_SETS,
  builtinComfyPromptSet,
  COMFY_KINDS,
  comfyPromptSetFor,
  comfyServerFor,
  effectiveComfyConn,
  isBuiltinComfyPromptSet,
  newComfyPromptSet,
  newComfyServer,
  newComfyWorkflow,
  ORIENTATION_LOCKS,
  settings,
  type ComfyKind,
  type ComfyPromptSet,
  type ComfyServer,
  type ComfyWorkflowPreset,
} from '@/state/settings';
import { computed, reactive, ref, watch } from 'vue';

const testing = ref(false);
const configuring = ref(false);
const assistOpen = ref(false);
const assistDraft = ref('');
const assistResult = ref<WorkflowAssistResult | null>(null);
/** AI 预览针对哪一套:预览期间用户可能切走或删掉,应用时按 id 回写而不是写「当前」。 */
const assistTargetId = ref('');

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'comfyui');

/**
 * 三个库共用一个删除确认框:同一时刻只会有一个待删对象。
 * 存 id 而非对象引用——确认前库可能被别处改动,删时按 id 现查。
 */
type DeleteTarget = { type: 'plan' | 'prompt' | 'server'; id: string; name: string };
const pendingDelete = ref<DeleteTarget | null>(null);
const deleteOpen = computed({
  get: () => !!pendingDelete.value,
  set: open => {
    if (!open) pendingDelete.value = null;
  },
});
const DELETE_TITLES: Record<DeleteTarget['type'], string> = {
  plan: '删除出图方案',
  prompt: '删除提示词',
  server: '删除渠道',
};

function confirmDelete() {
  const target = pendingDelete.value;
  pendingDelete.value = null;
  if (!target) return;
  if (target.type === 'plan') removeWorkflow(target.id);
  else if (target.type === 'prompt') removePromptSet(target.id);
  else removeServer(target.id);
}

function kindLabel(kind: ComfyKind): string {
  return COMFY_KINDS.find(k => k.value === kind)?.label ?? kind;
}

/** 方案名列表(删除按钮 title / 弹窗里「改动会影响」共用)。 */
function planNames(plans: ComfyWorkflowPreset[]): string {
  return plans.map(w => `「${w.name || '未命名方案'}」`).join('');
}

/** 按**解析后**的引用统计:悬空引用回落到谁,就算谁在用(与出图实际取值同口径)。 */
function plansUsingServer(id: string): ComfyWorkflowPreset[] {
  return settings.comfyui.workflows.filter(w => comfyServerFor(w).id === id);
}
function plansUsingPromptSet(id: string): ComfyWorkflowPreset[] {
  return settings.comfyui.workflows.filter(w => comfyPromptSetFor(w).id === id);
}

/* ============ 出图方案 ============ */

/** 当前(出图用的)方案:存的 id 悬空时 activeComfyPreset 回落第一条,列表的选中点也跟着它走。 */
const active = computed(() => activeComfyPreset());

/** 只剩一套时不给删:workflows 恒非空是全局不变式,禁用比「点了没反应」诚实。 */
const canRemove = computed(() => settings.comfyui.workflows.length > 1);

function switchTo(preset: { id: string }) {
  settings.comfyui.activeWorkflowId = preset.id;
}

/**
 * 方案编辑弹窗的对象。编辑与「选中出图」脱钩:改哪套就点哪套的 ✎,不必先把它设成当前。
 * 弹窗关着时回落当前方案,让下面那些按方案取值的 computed 恒有对象可读(不必处处判空)。
 */
const editingPlanId = ref('');
const plan = computed(
  () => settings.comfyui.workflows.find(w => w.id === editingPlanId.value) ?? active.value,
);
const planOpen = computed(
  () => !!editingPlanId.value && settings.comfyui.workflows.some(w => w.id === editingPlanId.value),
);

function openPlan(preset: { id: string }) {
  editingPlanId.value = preset.id;
}

function closePlan() {
  editingPlanId.value = '';
}

/** 新建/复制都直接打开它的编辑窗,但不抢「当前」:一套还没配好的方案顶上去只会出不了图。 */
function addWorkflow() {
  // 新方案沿用当前方案的渠道:多数人只有一个,省得每次新建都再选一遍
  const preset = newComfyWorkflow(`方案 ${settings.comfyui.workflows.length + 1}`, comfyServerFor(active.value).id);
  settings.comfyui.workflows.push(preset);
  openPlan(preset);
}

function duplicateWorkflow(source: ComfyWorkflowPreset) {
  // 拷全部字段(JSON/开关/尺寸/类型/引用一起复制),只换 id 与名字;id 生成仍由 settings 统一口径。
  // simple 是嵌套对象(含 loras 数组),必须深拷——浅拷会让两套预设共享同一份参数。
  const preset = {
    ...source,
    id: newComfyWorkflow().id,
    name: `${source.name || '未命名方案'} 副本`,
    simple: {
      ...source.simple,
      loras: source.simple.loras.map(lora => ({ ...lora })),
    },
  };
  const list = settings.comfyui.workflows;
  const index = list.findIndex(w => w.id === source.id);
  list.splice(index < 0 ? list.length : index + 1, 0, preset);
  openPlan(preset);
}

function askRemoveWorkflow(preset: ComfyWorkflowPreset) {
  pendingDelete.value = { type: 'plan', id: preset.id, name: preset.name || '未命名方案' };
}

function removeWorkflow(id: string) {
  const list = settings.comfyui.workflows;
  if (list.length <= 1) return;
  const index = list.findIndex(w => w.id === id);
  if (index < 0) return;
  const wasActive = active.value.id === id;
  list.splice(index, 1);
  // 删掉的是当前项:接位到原位置那一条(已是最后一条则退一格)
  if (wasActive) settings.comfyui.activeWorkflowId = list[Math.min(index, list.length - 1)].id;
}

/* —— 方案的类型与两个引用 —— */

const isComic = computed(() => plan.value.kind === 'comic');

/**
 * 切类型连带换提示词:提示词按类型分库,旧引用在新类型下必然错配
 * (comfyPromptSetFor 也会回落,但存着一个不生效的 id 就是暗格)。换成同类型内置,行为可预期。
 */
function setKind(kind: ComfyKind) {
  const target = plan.value;
  if (target.kind === kind) return;
  target.kind = kind;
  target.promptSetId = builtinComfyPromptSet(kind).id;
}

function serverLabel(server: ComfyServer): string {
  const name = server.name.trim() || '未命名渠道';
  const url = server.url.trim();
  return url ? `${name} · ${url}` : `${name}(未填地址)`;
}

const serverOptions = computed(() =>
  settings.comfyui.servers.map(s => ({ value: s.id, label: serverLabel(s) })),
);

/** 取解析后的那个:存的 id 悬空时下拉也显示实际生效的那个,不显示空白。 */
const planServerId = computed<string>({
  get: () => comfyServerFor(plan.value).id,
  set: id => {
    plan.value.serverId = id;
  },
});

/** 全部提示词(内置在前),按类型分组排列——库列表与方案下拉同一顺序。 */
const promptLibrary = computed<ComfyPromptSet[]>(() => {
  const all = [...BUILTIN_COMFY_PROMPT_SETS, ...settings.comfyui.promptSets];
  return COMFY_KINDS.flatMap(k => all.filter(p => p.kind === k.value));
});

/** 方案只能选同类型的提示词:错配出来的是废图,不给选比选了再报错诚实。 */
const promptOptions = computed(() =>
  promptLibrary.value
    .filter(p => p.kind === plan.value.kind)
    .map(p => ({ value: p.id, label: p.name || '未命名提示词' })),
);

const planPromptSetId = computed<string>({
  get: () => comfyPromptSetFor(plan.value).id,
  set: id => {
    plan.value.promptSetId = id;
  },
});

/* ============ 提示词库 ============ */

type PromptTab = 'spec' | 'thinking';

const PROMPT_TABS: { value: PromptTab; label: string }[] = [
  { value: 'spec', label: '书写规范' },
  { value: 'thinking', label: '思维链' },
];

// 与设置页「自定义提示词」同一组宏(条件段由 autoTag/prompt.ts 的 expandNlSections 展开)
const NL_SECTION_MACROS = [
  { token: '{{#nl}}', desc: '条件段开头：到 {{/nl}} 为止的内容只在开启「生成自然语言」时保留。' },
  { token: '{{^nl}}', desc: '条件段开头：到 {{/nl}} 为止的内容只在关闭「生成自然语言」时保留。' },
  { token: '{{/nl}}', desc: '条件段结尾，与 {{#nl}} 或 {{^nl}} 配对使用；不支持嵌套。' },
];
const NL_SPEC_MACRO = {
  token: '{{nl}}',
  desc: '自然语言规范；方案开启「生成自然语言」时展开，关闭时置空。不写此宏时，开启开关会自动追加到末尾。',
};

interface PromptEditing {
  id: string;
  kind: ComfyKind;
  /** 内置:只读,只能复制成自己的。 */
  readonly: boolean;
  /** 新建/复制:点「完成」才入库,取消即什么都没发生。 */
  isNew: boolean;
  /** 从方案行点进来时记下方案 id:在那里把内置复制成自己的,保存即让该方案改用它。 */
  planId: string;
}

const editingPrompt = ref<PromptEditing | null>(null);
const promptDraft = reactive({ name: '', spec: '', thinking: '' });
const promptTab = ref<PromptTab>('spec');
const promptArea = ref<InstanceType<typeof BbiTextarea> | null>(null);

/** 一个文本框按页签切换编辑对象。 */
const promptText = computed<string>({
  get: () => promptDraft[promptTab.value],
  set: v => {
    promptDraft[promptTab.value] = v;
  },
});

/** 库列表第二行:谁在用它(改共享提示词前一眼能看到波及面)。 */
function promptSetMeta(set: ComfyPromptSet): string {
  const users = plansUsingPromptSet(set.id);
  const usage = users.length ? `${planNames(users)}在用` : '';
  if (isBuiltinComfyPromptSet(set.id)) return usage ? `内置 · ${usage}` : '内置 · 只读,随插件更新';
  return usage || '暂无方案使用';
}

function uniquePromptSetName(base: string): string {
  const names = new Set(settings.comfyui.promptSets.map(p => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/** 空串 = 回落内置:草稿载入时展开成内置原文,方便直接在其上改。 */
function loadPromptDraft(source: ComfyPromptSet, name: string) {
  const builtin = builtinComfyPromptSet(source.kind);
  promptDraft.name = name;
  promptDraft.spec = source.spec.trim() || builtin.spec;
  promptDraft.thinking = source.thinking.trim() || builtin.thinking;
  promptTab.value = 'spec';
}

function openPromptSet(set: ComfyPromptSet, planId = '') {
  editingPrompt.value = {
    id: set.id,
    kind: set.kind,
    readonly: isBuiltinComfyPromptSet(set.id),
    isNew: false,
    planId,
  };
  loadPromptDraft(set, set.name);
}

function openPlanPromptSet() {
  openPromptSet(comfyPromptSetFor(plan.value), plan.value.id);
}

/** 新建与复制都走「先开草稿、完成才入库」;来源为空即新建(预填同类型内置)。 */
function startNewPromptSet(kind: ComfyKind, source: ComfyPromptSet | null = null, planId = '') {
  const base = source && !isBuiltinComfyPromptSet(source.id) ? `${source.name} 副本` : `我的${kindLabel(kind)}提示词`;
  const set = newComfyPromptSet(kind, uniquePromptSetName(base));
  editingPrompt.value = { id: set.id, kind, readonly: false, isNew: true, planId };
  loadPromptDraft(source ?? set, set.name);
}

/** 内置弹窗里的「复制为自定义」:原地转成新建草稿,内容即内置原文,方案关联一并带过去。 */
function forkBuiltinInEditor() {
  const e = editingPrompt.value;
  if (!e) return;
  startNewPromptSet(e.kind, builtinComfyPromptSet(e.kind), e.planId);
}

function closePromptSet() {
  editingPrompt.value = null;
}

function savePromptSet() {
  const e = editingPrompt.value;
  if (!e || e.readonly) return;
  const builtin = builtinComfyPromptSet(e.kind);
  // 与内置一字不差就存空串:回落内置、随插件版本更新(同设置页自定义提示词口径)
  const spec = promptDraft.spec.trim() === builtin.spec.trim() ? '' : promptDraft.spec;
  const thinking = promptDraft.thinking.trim() === builtin.thinking.trim() ? '' : promptDraft.thinking;
  const name = promptDraft.name.trim() || '未命名提示词';

  if (e.isNew) {
    settings.comfyui.promptSets.push({ id: e.id, name, kind: e.kind, spec, thinking });
    const plan = settings.comfyui.workflows.find(w => w.id === e.planId);
    if (plan && plan.kind === e.kind) plan.promptSetId = e.id;
  } else {
    const target = settings.comfyui.promptSets.find(p => p.id === e.id);
    if (!target) {
      toastr.error('这套提示词已被删除', '柏宝绘');
      closePromptSet();
      return;
    }
    target.name = name;
    target.spec = spec;
    target.thinking = thinking;
  }
  closePromptSet();
}

/** 「恢复内置」只重置当前页签:两页各自独立,一键清两页太容易误伤。 */
function resetPromptTab() {
  const e = editingPrompt.value;
  if (e) promptDraft[promptTab.value] = builtinComfyPromptSet(e.kind)[promptTab.value];
}

function insertPromptMacro(token: string) {
  promptArea.value?.insertAtCursor(token);
}

/** 漫画固定不生成自然语言(见 autoTagProfile),条件段对它没有意义,故不给宏。 */
const promptMacros = computed(() => {
  const e = editingPrompt.value;
  if (!e || e.readonly || e.kind !== 'illustration') return [];
  return promptTab.value === 'spec' ? [NL_SPEC_MACRO, ...NL_SECTION_MACROS] : NL_SECTION_MACROS;
});

const promptTabHint = computed(() => {
  const e = editingPrompt.value;
  if (!e) return '';
  if (promptTab.value === 'spec') {
    return e.kind === 'comic'
      ? '拼进自动 tag 请求,说明如何把整楼剧情拆成漫画页、每页如何分格、每格写什么。'
      : '拼进自动 tag 请求,约束 tag / nl 的书写规范。可用条件段按方案的「生成自然语言」开关取舍。';
  }
  return '输出前思考清单,作为 system 压在任务消息之后(解析时自动剥掉思考块)。与书写规范配套使用。';
});

/** 弹窗顶部的影响面说明:改共享提示词前得知道会波及谁。 */
const promptImpact = computed(() => {
  const e = editingPrompt.value;
  if (!e) return '';
  if (e.readonly) return '内置提示词只读,随插件版本更新。想改就复制一份成为自己的。';
  if (e.isNew) {
    const plan = settings.comfyui.workflows.find(w => w.id === e.planId);
    return plan && plan.kind === e.kind
      ? `保存后方案${planNames([plan])}改用这套。`
      : '保存后可在出图方案里选用。';
  }
  const users = plansUsingPromptSet(e.id);
  return users.length ? `改动会影响:${planNames(users)}` : '暂无方案使用这套。';
});

function askRemovePromptSet(set: ComfyPromptSet) {
  pendingDelete.value = { type: 'prompt', id: set.id, name: set.name || '未命名提示词' };
}

function removePromptSet(id: string) {
  // 被引用的不给删(按钮已禁用,这里再守一道:确认框开着期间别处可能刚选上它)
  if (plansUsingPromptSet(id).length) return;
  const list = settings.comfyui.promptSets;
  const index = list.findIndex(p => p.id === id);
  if (index >= 0) list.splice(index, 1);
}

function promptRemoveTitle(set: ComfyPromptSet): string {
  if (isBuiltinComfyPromptSet(set.id)) return '内置提示词不能删除';
  const users = plansUsingPromptSet(set.id);
  return users.length ? `正被${planNames(users)}使用,先给它们换一套再删` : '删除这套提示词';
}

/* ============ 渠道 ============ */

function addServer() {
  settings.comfyui.servers.push(newComfyServer(`渠道 ${settings.comfyui.servers.length + 1}`));
}

function askRemoveServer(server: ComfyServer) {
  pendingDelete.value = { type: 'server', id: server.id, name: server.name || '未命名渠道' };
}

function removeServer(id: string) {
  // 被引用的不给删;这也守住了「服务器恒非空」——方案恒非空,总有一台被引用着
  if (plansUsingServer(id).length) return;
  const list = settings.comfyui.servers;
  const index = list.findIndex(s => s.id === id);
  if (index >= 0) list.splice(index, 1);
}

function serverRemoveTitle(server: ComfyServer): string {
  const users = plansUsingServer(server.id);
  return users.length ? `正被${planNames(users)}使用,先给它们换一个再删` : '删除这个渠道';
}

const testingServerId = ref('');

/** 逐台测试:只换地址,其余沿用当前方案(测试只关心连不连得上)。 */
async function onTestServer(server: ComfyServer) {
  if (testingServerId.value) return;
  testingServerId.value = server.id;
  try {
    const result = await testComfyConnection({ ...effectiveComfyConn(), url: server.url });
    toastr.success(
      result.mode === 'server' ? '连接正常（ST 后端转发）' : '连接正常（浏览器直连）',
      server.name || 'ComfyUI',
    );
  } catch (error) {
    toastr.error(errorMessage(error), `${server.name || 'ComfyUI'} 连接失败`);
  } finally {
    testingServerId.value = '';
  }
}

/* ============ 简易模式:选模型填参数 ============ */

// 分段开关文案要短:上方已有「工作流」小标题,这里只说区别。
// 顺序:默认项 custom 在左(与「存量预设/新预设都是自定义工作流」的口径一致)
const modeOptions: Array<{ value: ComfyPresetMode; label: string }> = [
  { value: 'custom', label: '自定义' },
  { value: 'simple', label: '简易' },
];

const templateOptions = COMFY_TEMPLATE_OPTIONS;

/** 正在编辑的方案的模板元数据(决定表单显示哪些字段)。 */
const meta = computed(() => COMFY_TEMPLATES[plan.value.simple.template] ?? COMFY_TEMPLATES.checkpoint);

const lists = ref<ComfyModelLists | null>(null);
const fetching = ref(false);
const fetchError = ref('');

async function onFetchModels(silent = false) {
  if (fetching.value) return;
  fetching.value = true;
  fetchError.value = '';
  try {
    lists.value = await fetchComfyModelLists(comfyServerFor(plan.value).url, { force: !!lists.value });
    if (!silent) {
      toastr.success(
        lists.value.mode === 'server'
          ? '已拉取模型列表(ST 转发;LoRA/CLIP 需手输文件名)'
          : '已拉取模型列表',
        '柏宝绘',
      );
    }
  } catch (error) {
    fetchError.value = errorMessage(error);
    if (!silent) toastr.error(fetchError.value, '拉取模型列表失败');
  } finally {
    fetching.value = false;
  }
}

// 打开一套简易模式的方案且手上没有列表时自动拉一次(静默,失败只在状态行留原因)。
// 换了渠道(或改了地址),手上的列表就是另一台机器的,作废;不跟着地址自动重拉——
// 地址是逐字敲的,每敲一下发一次请求只会拉回一串失败。
watch(
  () => comfyServerFor(plan.value).url,
  () => {
    lists.value = null;
    fetchError.value = '';
  },
);
watch(
  () => [planOpen.value, plan.value.id, plan.value.mode] as const,
  () => {
    if (
      planOpen.value &&
      plan.value.mode === 'simple' &&
      !lists.value &&
      !fetching.value &&
      comfyServerFor(plan.value).url.trim()
    ) {
      void onFetchModels(true);
    }
  },
);

// 刷新按钮左边那格说明:列表从哪来、缺什么、为什么没拉到。
// 手动点按钮的正反馈由 toastr 负责。
const fetchStatus = computed(() => {
  if (fetchError.value) return `拉取失败:${fetchError.value}`;
  if (!lists.value) return '尚未拉取模型列表';
  if (lists.value.mode === 'browser') return `列表来自「${comfyServerFor(plan.value).name.trim() || '未命名渠道'}」`;
  return 'ST 转发拿不到 LoRA/CLIP 列表,这两项需手输(ComfyUI 加 --enable-cors-header 可直连)';
});

const modelOptions = computed(() => {
  if (!lists.value) return [];
  return meta.value.modelKind === 'checkpoint'
    ? lists.value.checkpoints
    : [...lists.value.unets, ...lists.value.ggufs];
});
const vaeOptions = computed(() => lists.value?.vaes ?? []);
const clipOptions = computed(() => lists.value?.clips ?? []);
const loraOptions = computed(() => lists.value?.loras ?? []);
const samplerOptions = computed(() =>
  lists.value?.samplers.length ? lists.value.samplers : FALLBACK_SAMPLERS,
);
const schedulerOptions = computed(() =>
  lists.value?.schedulers.length ? lists.value.schedulers : FALLBACK_SCHEDULERS,
);

// 选了列表里的 GGUF 文件自动勾选 GGUF;选回普通 unet 自动取消(手输的名字不动开关)
watch(
  () => plan.value.simple.model,
  name => {
    if (!lists.value || meta.value.modelKind !== 'unet') return;
    if (lists.value.ggufs.includes(name)) plan.value.simple.gguf = true;
    else if (lists.value.unets.includes(name)) plan.value.simple.gguf = false;
  },
);

/**
 * 切架构模板:采样参数换成新模板推荐值,模型/VAE/CLIP 清空(列表不同源),
 * LoRA 与固定正负词保留(与架构无关)。尺寸若还是旧模板默认值则跟着换,
 * 用户自己改过的尺寸不动。
 *
 * MOSS 只吃漫画 layout,进出 MOSS 连带切方案类型(SDXL 吃 layout JSON、MOSS 吃 tag 串都是废图);
 * 固定负面是空的就填 MOSS 推荐值,离开时还是推荐值原样就清掉——别把它带进别的模型。
 */
function onTemplateChange(id: string) {
  if (!isComfyTemplateId(id)) return;
  const target = plan.value;
  const current = target.simple;
  if (current.template === id) return;
  const prevMeta = COMFY_TEMPLATES[current.template];
  const nextMeta = COMFY_TEMPLATES[id];
  if (target.portraitSize === prevMeta.portraitSize) target.portraitSize = nextMeta.portraitSize;
  if (target.landscapeSize === prevMeta.landscapeSize) target.landscapeSize = nextMeta.landscapeSize;
  let negative = current.negative;
  if (id === 'moss' && !negative.trim()) negative = MOSS_DEFAULT_NEGATIVE;
  if (current.template === 'moss' && negative.trim() === MOSS_DEFAULT_NEGATIVE) negative = '';
  target.simple = {
    ...simpleDefaults(id),
    loras: current.loras,
    positive: current.positive,
    negative,
  };
  if (id === 'moss') setKind('comic');
  else if (current.template === 'moss') setKind('illustration');
}

function addLora() {
  plan.value.simple.loras.push({ name: '', strength: 1 });
}

function removeLora(index: number) {
  plan.value.simple.loras.splice(index, 1);
}

/** 简易模式状态药丸:与出图组装同一口径(validateSimpleConfig)。 */
const simpleState = computed(() => {
  const invalid = validateSimpleConfig(plan.value.simple);
  return invalid
    ? { tone: 'error', text: '未就绪', detail: invalid }
    : { tone: 'ok', text: '有效', detail: '' };
});

const nlHint = computed(() =>
  plan.value.mode === 'simple'
    ? '额外写一段自然语言描述;简易模式下优先于 tag 作为正向提示词(Flux/Anima 建议开启)'
    : '额外写一段自然语言描述,随 %nl% 注入工作流',
);

/** 药丸只显示一个词,具体原因放 title 悬浮提示,不占版面。列表摘要行也按它判「就绪」。 */
function workflowStatus(json: string): { tone: string; text: string; detail: string } {
  if (!json.trim()) return { tone: 'muted', text: '未填写', detail: '' };
  try {
    const placeholders = getWorkflowPlaceholders(json);
    if (!placeholders.includes('prompt')) {
      return { tone: 'error', text: '缺 %prompt%', detail: 'JSON 有效，但缺少必需的 %prompt% 占位符' };
    }
    const unknown = placeholders.filter(
      name => !['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height'].includes(name),
    );
    if (unknown.length) {
      return {
        tone: 'error',
        text: '占位符不支持',
        detail: `暂不支持：${unknown.map(name => `%${name}%`).join('、')}`,
      };
    }
    return {
      tone: 'ok',
      text: '有效',
      detail: `已识别 ${placeholders.map(name => `%${name}%`).join('、')}`,
    };
  } catch (error) {
    return { tone: 'error', text: 'JSON 无效', detail: errorMessage(error) };
  }
}

/** 「工作流」小标题右侧的药丸:跟着当前配置方式走。 */
const modeState = computed(() =>
  plan.value.mode === 'simple' ? simpleState.value : workflowStatus(plan.value.workflow),
);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testComfyConnection(effectiveComfyConn());
    toastr.success(result.mode === 'server' ? 'ComfyUI 连接正常（ST 后端转发）' : 'ComfyUI 连接正常（浏览器直连）');
  } catch (error) {
    toastr.error(errorMessage(error), 'ComfyUI 连接失败');
  } finally {
    testing.value = false;
  }
}

const purposeLabels: Record<WorkflowBindingPurpose, string> = {
  positive_tag: '正向 tag',
  positive_nl: '独立自然语言',
  positive_combined: '正向 tag + 自然语言共用',
  negative: '负面提示词',
  seed: '随机种子',
  width: '主画布宽度',
  height: '主画布高度',
};

async function onAutoConfigure() {
  if (configuring.value || !plan.value.workflow.trim()) return;
  configuring.value = true;
  const targetId = plan.value.id;
  try {
    const result = await configureWorkflowWithAi(plan.value.workflow);
    if (!result.changes.length) {
      toastr.info('工作流中的动态参数已经配置，无需修改', '柏宝绘');
      return;
    }
    assistResult.value = result;
    assistDraft.value = result.workflow;
    assistTargetId.value = targetId;
    assistOpen.value = true;
  } catch (error) {
    toastr.error(errorMessage(error), 'AI 配置工作流失败');
  } finally {
    configuring.value = false;
  }
}

function closeAssist() {
  assistOpen.value = false;
  assistResult.value = null;
  assistDraft.value = '';
  assistTargetId.value = '';
}

function applyAssist() {
  try {
    const target = settings.comfyui.workflows.find(w => w.id === assistTargetId.value);
    if (!target) throw new Error('目标工作流已被删除，请重新配置');
    const placeholders = getWorkflowPlaceholders(assistDraft.value);
    if (!placeholders.includes('prompt')) throw new Error('预览工作流缺少 %prompt% 占位符');
    target.workflow = assistDraft.value;
    const name = target.name;
    closeAssist();
    toastr.success(`已应用 AI 配置的工作流（${name}）`, '柏宝绘');
    if (placeholders.includes('nl') && !target.naturalLanguage) {
      toastr.info('工作流已配置 %nl%；需要时请在方案的「画面」里开启「生成自然语言」', '柏宝绘');
    }
  } catch (error) {
    toastr.error(errorMessage(error), '工作流无法应用');
  }
}
</script>

<template>
  <div class="panel">
    <div class="bbi-sections">
      <Collapsible title="出图方案">
        <!-- 只是一张列表:点行切换出图用的方案,点 ✎ 才弹出它的全部设置 -->
        <div class="grp" role="radiogroup" aria-label="出图方案">
          <div
            v-for="w in settings.comfyui.workflows"
            :key="w.id"
            class="grp-item plan-item"
            :class="{ 'is-on': w.id === active.id }"
          >
            <button
              class="item-main"
              type="button"
              role="radio"
              :aria-checked="w.id === active.id"
              :title="w.id === active.id ? '当前出图用的方案' : '改用这套方案出图'"
              @click="switchTo(w)"
            >
              <span class="plan-radio" aria-hidden="true"></span>
              <span class="item-name">{{ w.name || '未命名方案' }}</span>
            </button>
            <span class="item-ops">
              <button class="icon-btn" type="button" title="编辑这套方案" aria-label="编辑这套方案" @click="openPlan(w)">
                <Icon name="edit" :size="14" />
              </button>
              <button
                class="icon-btn"
                type="button"
                title="复制这套方案"
                aria-label="复制这套方案"
                @click="duplicateWorkflow(w)"
              >
                <Icon name="copy" :size="14" />
              </button>
              <button
                class="icon-btn is-danger"
                type="button"
                :disabled="!canRemove"
                :title="canRemove ? '删除这套方案' : '至少要保留一套方案'"
                aria-label="删除这套方案"
                @click="askRemoveWorkflow(w)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </span>
          </div>
        </div>
        <div class="list-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="addWorkflow">
            <Icon name="plus" :size="12" />
            新建方案
          </button>
          <span class="list-foot-spacer"></span>
          <button
            class="quiet-btn"
            type="button"
            :disabled="testing"
            title="测试当前方案所用的渠道"
            @click="onTestConnection"
          >
            <Icon name="plug" :size="13" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
          <span v-if="inUse" class="in-use"><Icon name="check" :size="13" /> 正在用 ComfyUI 出图</span>
          <button
            v-else
            class="bbi-btn bbi-btn-sm bbi-btn-primary"
            type="button"
            @click="settings.defaultBackend = 'comfyui'"
          >
            用 ComfyUI 出图
          </button>
        </div>
      </Collapsible>

      <Collapsible title="提示词库" :open="false">
        <div class="grp">
          <div v-for="set in promptLibrary" :key="set.id" class="grp-item">
            <button class="item-main" type="button" @click="openPromptSet(set)">
              <span class="item-body">
                <span class="item-title">
                  <span class="kind-tag" :class="`is-${set.kind}`">{{ kindLabel(set.kind) }}</span>
                  <span class="item-name">{{ set.name || '未命名提示词' }}</span>
                </span>
                <span class="item-meta">{{ promptSetMeta(set) }}</span>
              </span>
            </button>
            <span class="item-ops">
              <button
                class="icon-btn"
                type="button"
                :title="isBuiltinComfyPromptSet(set.id) ? '查看这套提示词' : '编辑这套提示词'"
                :aria-label="isBuiltinComfyPromptSet(set.id) ? '查看这套提示词' : '编辑这套提示词'"
                @click="openPromptSet(set)"
              >
                <Icon :name="isBuiltinComfyPromptSet(set.id) ? 'eye' : 'edit'" :size="14" />
              </button>
              <button
                class="icon-btn"
                type="button"
                title="复制为一套新的自定义提示词"
                aria-label="复制这套提示词"
                @click="startNewPromptSet(set.kind, set)"
              >
                <Icon name="copy" :size="14" />
              </button>
              <button
                class="icon-btn is-danger"
                type="button"
                :disabled="isBuiltinComfyPromptSet(set.id) || plansUsingPromptSet(set.id).length > 0"
                :title="promptRemoveTitle(set)"
                aria-label="删除这套提示词"
                @click="askRemovePromptSet(set)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </span>
          </div>
        </div>
        <div class="list-foot">
          <button
            v-for="k in COMFY_KINDS"
            :key="k.value"
            class="bbi-btn bbi-btn-sm"
            type="button"
            @click="startNewPromptSet(k.value)"
          >
            <Icon name="plus" :size="12" />
            新建{{ k.label }}提示词
          </button>
        </div>
        <p class="grp-foot">
          每套提示词含「书写规范」与「思维链」两份,配套使用。内置的只读、随插件更新;想改就复制一份。正被方案使用的不能删除。
        </p>
      </Collapsible>

      <Collapsible title="渠道" :open="false">
        <div class="grp">
          <div v-for="server in settings.comfyui.servers" :key="server.id" class="grp-item srv-item">
            <input
              v-model="server.name"
              class="bbi-input srv-name"
              type="text"
              placeholder="名称"
              spellcheck="false"
              aria-label="渠道名称"
            />
            <input
              v-model="server.url"
              class="bbi-input"
              type="text"
              placeholder="http://127.0.0.1:8188"
              spellcheck="false"
              aria-label="渠道地址"
            />
            <span class="item-ops">
              <button
                class="icon-btn"
                type="button"
                :disabled="!!testingServerId"
                :title="testingServerId === server.id ? '连接中…' : '测试这个渠道'"
                aria-label="测试这个渠道"
                @click="onTestServer(server)"
              >
                <Icon :name="testingServerId === server.id ? 'refresh' : 'plug'" :size="14" />
              </button>
              <button
                class="icon-btn is-danger"
                type="button"
                :disabled="plansUsingServer(server.id).length > 0"
                :title="serverRemoveTitle(server)"
                aria-label="删除这个渠道"
                @click="askRemoveServer(server)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </span>
          </div>
        </div>
        <div class="list-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="addServer">
            <Icon name="plus" :size="12" />
            添加渠道
          </button>
        </div>
        <p class="grp-foot">正被方案使用的渠道不能删除;先在方案里换到别的渠道。</p>
      </Collapsible>
    </div>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="pendingDelete ? DELETE_TITLES[pendingDelete.type] : ''"
      confirm-text="删除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmDelete"
    >
      确定删除「{{ pendingDelete?.name }}」？删除后无法恢复。
    </ConfirmDialog>

    <!-- ===== 方案编辑弹窗:全部设置按「来源 / 画面 / 工作流」分组,改动即时生效 ===== -->
    <ModalMask :open="planOpen" @close="closePlan">
      <div v-if="planOpen" class="bbi-modal plan-modal" role="dialog" aria-modal="true" aria-label="编辑出图方案">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">编辑方案</span>
          <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="closePlan">
            <Icon name="close" />
          </button>
        </header>

        <input
          v-model="plan.name"
          class="bbi-input plan-name-input"
          type="text"
          placeholder="方案名称"
          spellcheck="false"
          aria-label="方案名称"
        />

        <section class="grp-sec">
          <div class="grp-cap">来源</div>
          <div class="grp">
            <div class="grp-row">
              <span class="grp-label">类型</span>
              <div class="bbi-segmented seg-sm" role="radiogroup" aria-label="方案类型">
                <button
                  v-for="opt in COMFY_KINDS"
                  :key="opt.value"
                  class="bbi-seg"
                  :class="{ 'is-on': plan.kind === opt.value }"
                  type="button"
                  role="radio"
                  :aria-checked="plan.kind === opt.value"
                  @click="setKind(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>
            <div class="grp-row">
              <span class="grp-label">渠道</span>
              <BbiSelect
                class="grp-ctl-w"
                v-model="planServerId"
                :options="serverOptions"
                aria-label="方案使用的渠道"
              />
            </div>
            <div class="grp-row">
              <span class="grp-label">提示词</span>
              <span class="grp-ctl">
                <BbiSelect
                  class="grp-ctl-w is-short"
                  v-model="planPromptSetId"
                  :options="promptOptions"
                  aria-label="方案使用的提示词"
                />
                <button
                  class="icon-btn"
                  type="button"
                  title="查看 / 编辑这套提示词"
                  aria-label="查看或编辑方案使用的提示词"
                  @click="openPlanPromptSet"
                >
                  <Icon name="text" :size="14" />
                </button>
              </span>
            </div>
          </div>
          <p v-if="isComic" class="grp-foot">
            漫画挑出整楼的关键情节画成几页,页数和分格由 AI 按内容定。
          </p>
        </section>

        <section class="grp-sec">
          <div class="grp-cap">画面</div>
          <div class="grp">
            <div class="grp-row">
              <span class="grp-label">画幅方向</span>
              <div
                class="bbi-segmented seg-sm"
                role="radiogroup"
                aria-label="画幅方向"
                title="正文里已记下的方向不会被改写,改回「自动」即恢复"
              >
                <button
                  v-for="opt in ORIENTATION_LOCKS"
                  :key="opt.value"
                  class="bbi-seg"
                  :class="{ 'is-on': plan.orientationLock === opt.value }"
                  type="button"
                  role="radio"
                  :aria-checked="plan.orientationLock === opt.value"
                  @click="plan.orientationLock = opt.value"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>
            <label class="grp-row">
              <span class="grp-label">竖屏尺寸</span>
              <input
                class="bbi-input grp-short"
                type="text"
                v-model="plan.portraitSize"
                list="comfy-portrait-presets"
                placeholder="832×1216"
                spellcheck="false"
              />
            </label>
            <label class="grp-row">
              <span class="grp-label">横屏尺寸</span>
              <input
                class="bbi-input grp-short"
                type="text"
                v-model="plan.landscapeSize"
                list="comfy-landscape-presets"
                placeholder="1216×832"
                spellcheck="false"
              />
            </label>
            <!-- 漫画不生成自然语言(autoTagProfile 同步强制关),开关藏起来而非禁用:禁用会让人以为还能打开 -->
            <label v-if="!isComic" class="grp-row is-clickable">
              <span class="grp-label">
                生成自然语言
                <small class="grp-sub">{{ nlHint }}</small>
              </span>
              <input v-model="plan.naturalLanguage" type="checkbox" class="bbi-checkbox" />
            </label>
          </div>
          <p class="grp-foot">「自动」由 AI 按画面定横竖;锁定后这套方案每张都按该方向出,AI 也按此构图。</p>
          <datalist id="comfy-portrait-presets">
            <option value="832×1216">竖版</option>
            <option value="1024×1536">大竖版</option>
            <option value="1024×1024">方图</option>
          </datalist>
          <datalist id="comfy-landscape-presets">
            <option value="1216×832">横版</option>
            <option value="1536×1024">大横版</option>
            <option value="1024×1024">方图</option>
          </datalist>
        </section>

        <section class="grp-sec">
          <div class="grp-cap">
            工作流
            <span class="grp-cap-tools">
              <span
                class="bbi-prompt-state state-pill"
                :class="`is-${modeState.tone}`"
                :title="modeState.detail || undefined"
              >
                {{ modeState.text }}
              </span>
              <div class="bbi-segmented seg-sm" role="radiogroup" aria-label="配置方式">
                <button
                  v-for="opt in modeOptions"
                  :key="opt.value"
                  class="bbi-seg"
                  :class="{ 'is-on': plan.mode === opt.value }"
                  type="button"
                  role="radio"
                  :aria-checked="plan.mode === opt.value"
                  @click="plan.mode = opt.value"
                >
                  {{ opt.label }}
                </button>
              </div>
            </span>
          </div>

          <!-- 简易:选模型填参数,JSON 由插件按模板组装 -->
          <div v-if="plan.mode === 'simple'" class="grp">
            <div class="grp-row">
              <span class="grp-label">架构</span>
              <BbiSelect
                class="grp-ctl-w"
                :model-value="plan.simple.template"
                :options="templateOptions"
                aria-label="模型架构"
                @update:model-value="onTemplateChange"
              />
            </div>
            <div class="grp-row">
              <span class="grp-label">模型</span>
              <BbiCombo
                class="grp-ctl-w"
                v-model="plan.simple.model"
                :options="modelOptions"
                placeholder="safetensors / gguf 文件名"
                aria-label="模型文件"
              />
            </div>
            <label v-if="meta.modelKind === 'unet'" class="grp-row is-clickable">
              <span class="grp-label">
                GGUF 格式
                <small class="grp-sub">用 UnetLoaderGGUF 加载;从列表选择会自动识别</small>
              </span>
              <input v-model="plan.simple.gguf" type="checkbox" class="bbi-checkbox" />
            </label>
            <div class="grp-row">
              <span class="grp-label">VAE</span>
              <BbiCombo
                class="grp-ctl-w"
                v-model="plan.simple.vae"
                :options="vaeOptions"
                :placeholder="meta.vaePlaceholder"
                aria-label="VAE 文件"
              />
            </div>
            <div v-for="clip in meta.clips" :key="clip.key" class="grp-row">
              <span class="grp-label">{{ clip.label }}</span>
              <BbiCombo
                class="grp-ctl-w"
                v-model="plan.simple[clip.key]"
                :options="clipOptions"
                placeholder="clip 文件名"
                :aria-label="clip.label"
              />
            </div>
            <div class="grp-row">
              <span class="grp-note" :class="{ 'is-error': !!fetchError }">{{ fetchStatus }}</span>
              <button class="quiet-btn" type="button" :disabled="fetching" @click="onFetchModels()">
                <Icon name="refresh" :size="13" />
                {{ fetching ? '拉取中…' : lists ? '刷新模型列表' : '拉取模型列表' }}
              </button>
            </div>
          </div>

          <!-- 自定义:粘贴 API 格式 JSON -->
          <template v-else>
            <div class="grp">
              <div class="grp-row is-stack">
                <span class="grp-note">在 ComfyUI 里用「Save (API Format)」导出,整段粘贴进来</span>
                <BbiTextarea
                  v-model="plan.workflow"
                  class="grp-textarea"
                  :rows="8"
                  :max-rows="24"
                  mono
                  placeholder='{"3": {"class_type": "KSampler", ...}, ...}'
                />
              </div>
              <div class="grp-row">
                <span class="grp-label">
                  自动填占位符
                  <small class="grp-sub">AI 认出提示词、种子、尺寸等节点;节点与模型名会发给设置页「生成 tag 使用」的 API</small>
                </span>
                <button
                  class="bbi-btn bbi-btn-sm bbi-btn-primary"
                  type="button"
                  :disabled="configuring || !plan.workflow.trim()"
                  @click="onAutoConfigure"
                >
                  <Icon name="sparkles" :size="12" />
                  {{ configuring ? '分析中…' : 'AI 配置' }}
                </button>
              </div>
            </div>
            <p class="grp-foot">可用占位符:%prompt% %negative_prompt% %seed% %nl% %width% %height%</p>
          </template>
        </section>

        <template v-if="plan.mode === 'simple'">
          <section class="grp-sec">
            <div class="grp-cap">
              LoRA
              <span class="grp-cap-tools">
                <button class="quiet-btn" type="button" title="添加 LoRA(可多个串联)" @click="addLora">
                  <Icon name="plus" :size="13" />
                  添加
                </button>
              </span>
            </div>
            <div class="grp">
              <div v-for="(lora, index) in plan.simple.loras" :key="index" class="grp-row lora-row">
                <BbiCombo
                  class="lora-name"
                  v-model="lora.name"
                  :options="loraOptions"
                  placeholder="lora 文件名"
                  aria-label="LoRA 文件"
                />
                <span class="grp-ctl">
                  <input
                    class="bbi-input lora-str"
                    type="number"
                    v-model.number="lora.strength"
                    min="0"
                    max="2"
                    step="0.05"
                    title="强度"
                    aria-label="LoRA 强度"
                  />
                  <button
                    class="icon-btn is-danger"
                    type="button"
                    title="删除此 LoRA"
                    aria-label="删除此 LoRA"
                    @click="removeLora(index)"
                  >
                    <Icon name="trash" :size="14" />
                  </button>
                </span>
              </div>
              <div v-if="!plan.simple.loras.length" class="grp-row">
                <span class="grp-note">还没有 LoRA</span>
              </div>
            </div>
            <p class="grp-foot">可串联多个;LoRA 的触发词要自己写进固定正面或 tag 里。</p>
          </section>

          <section class="grp-sec">
            <div class="grp-cap">采样</div>
            <div class="grp">
              <label class="grp-row">
                <span class="grp-label">步数</span>
                <input class="bbi-input grp-short" type="number" v-model.number="plan.simple.steps" min="1" max="150" />
              </label>
              <label v-if="plan.simple.template !== 'flux'" class="grp-row">
                <span class="grp-label">CFG</span>
                <input
                  class="bbi-input grp-short"
                  type="number"
                  v-model.number="plan.simple.cfg"
                  min="1"
                  max="30"
                  step="0.5"
                />
              </label>
              <label v-if="plan.simple.template === 'flux'" class="grp-row">
                <span class="grp-label">
                  Guidance
                  <small class="grp-sub">FluxGuidance 强度;1 = 不加该节点</small>
                </span>
                <input
                  class="bbi-input grp-short"
                  type="number"
                  v-model.number="plan.simple.guidance"
                  min="1"
                  max="10"
                  step="0.1"
                />
              </label>
              <label v-if="plan.simple.template === 'anima'" class="grp-row">
                <span class="grp-label">
                  Shift
                  <small class="grp-sub">ModelSamplingAuraFlow 的 shift</small>
                </span>
                <input
                  class="bbi-input grp-short"
                  type="number"
                  v-model.number="plan.simple.shift"
                  min="0"
                  max="10"
                  step="0.1"
                />
              </label>
              <div class="grp-row">
                <span class="grp-label">采样器</span>
                <BbiCombo
                  class="grp-ctl-w"
                  v-model="plan.simple.sampler"
                  :options="samplerOptions"
                  placeholder="euler"
                  aria-label="采样器"
                />
              </div>
              <div class="grp-row">
                <span class="grp-label">调度器</span>
                <BbiCombo
                  class="grp-ctl-w"
                  v-model="plan.simple.scheduler"
                  :options="schedulerOptions"
                  placeholder="normal"
                  aria-label="调度器"
                />
              </div>
            </div>
          </section>

          <section class="grp-sec">
            <div class="grp-cap">固定提示词</div>
            <div class="grp">
              <div class="grp-row is-stack">
                <span class="grp-note">正面:质量词 / 风格词等,拼在 AI 写的内容之前</span>
                <BbiTextarea v-model="plan.simple.positive" class="grp-textarea" :rows="2" :max-rows="6" />
              </div>
              <div v-if="meta.supportsNegative" class="grp-row is-stack">
                <span class="grp-note">负面:通用负面词;AI 写的动态负面接在后面</span>
                <BbiTextarea v-model="plan.simple.negative" class="grp-textarea" :rows="2" :max-rows="6" />
              </div>
            </div>
          </section>
        </template>

        <footer class="bbi-modal-foot">
          <span v-if="plan.id === active.id" class="plan-current"><Icon name="check" :size="13" /> 当前方案</span>
          <button v-else class="bbi-btn" type="button" @click="switchTo(plan)">设为当前方案</button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closePlan">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 提示词编辑弹窗(与设置页自定义提示词同款,多一个名称与页签) ===== -->
    <!-- 可能从方案弹窗里叠开,故走叠加层 -->
    <ModalMask :open="!!editingPrompt" top-layer @close="closePromptSet">
      <div
        v-if="editingPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="编辑提示词"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingPrompt.readonly ? '查看' : editingPrompt.isNew ? '新建' : '编辑' }}{{ kindLabel(editingPrompt.kind) }}提示词
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closePromptSet">
            <Icon name="close" />
          </button>
        </header>

        <div class="ps-name-row">
          <span class="bbi-modal-label">名称</span>
          <input
            v-model="promptDraft.name"
            class="bbi-input"
            type="text"
            placeholder="提示词名称"
            spellcheck="false"
            :readonly="editingPrompt.readonly"
          />
        </div>

        <p class="bbi-modal-label ps-impact">{{ promptImpact }}</p>

        <div class="bbi-segmented ps-tabs" role="tablist" aria-label="提示词分页">
          <button
            v-for="tab in PROMPT_TABS"
            :key="tab.value"
            class="bbi-seg"
            :class="{ 'is-on': promptTab === tab.value }"
            type="button"
            role="tab"
            :aria-selected="promptTab === tab.value"
            @click="promptTab = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>

        <p class="bbi-modal-label">{{ promptTabHint }}</p>

        <div v-if="promptMacros.length" class="bbi-macro-bar">
          <span class="bbi-macro-tip">点击插入宏:</span>
          <button
            v-for="mac in promptMacros"
            :key="mac.token"
            class="bbi-macro"
            type="button"
            :title="mac.desc"
            @click="insertPromptMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <BbiTextarea
          ref="promptArea"
          v-model="promptText"
          class="bbi-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
          :readonly="editingPrompt.readonly"
        />

        <footer class="bbi-modal-foot">
          <template v-if="!editingPrompt.readonly">
            <button
              class="bbi-btn bbi-btn-danger"
              type="button"
              title="只重置当前页签,另一页不动"
              @click="resetPromptTab"
            >
              <Icon name="refresh" /> 恢复内置
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="closePromptSet">取消</button>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="savePromptSet">完成</button>
          </template>
          <template v-else>
            <button class="bbi-btn" type="button" @click="forkBuiltinInEditor">
              <Icon name="copy" /> 复制为自定义
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="closePromptSet">关闭</button>
          </template>
        </footer>
      </div>
    </ModalMask>

    <ModalMask :open="assistOpen" top-layer @close="closeAssist">
      <div
        v-if="assistResult"
        class="bbi-modal workflow-assist-modal"
        role="dialog"
        aria-modal="true"
        aria-label="预览 AI 配置的工作流"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">预览工作流修改</span>
          <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="closeAssist">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-field-hint">原文与宏由本地重建，AI 只返回节点用途；请检查后再应用。</p>
        <div class="workflow-change-list">
          <div
            v-for="change in assistResult.changes"
            :key="`${change.node}:${change.input}`"
            class="workflow-change"
          >
            <span class="workflow-change-role">{{ purposeLabels[change.purpose] }}</span>
            <code>{{ change.node }}.inputs.{{ change.input }}</code>
          </div>
        </div>

        <BbiTextarea v-model="assistDraft" :rows="10" :max-rows="24" mono />

        <p v-if="assistResult.nlMode !== 'none'" class="workflow-detection">
          自然语言：{{ assistResult.nlMode === 'combined' ? '与正向 tag 共用输入' : '使用独立输入' }}
        </p>
        <p v-if="assistResult.hasNegative" class="workflow-detection">
          已配置动态负面词；生成 tag 时会按画面输出补充负面 tag。
        </p>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeAssist">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="applyAssist">
            <Icon name="check" />
            应用工作流
          </button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* ==========================================================================
   分组列表:本面板唯一的排布语言。小标题(grp-cap)+ 白卡(grp)+ 卡内行(grp-row / grp-item),
   行间只一根细线;标签在左、控件在右,控件统一宽度、右缘对齐。
   方案 / 提示词库 / 渠道三张列表与方案弹窗里的各组设置同一套几何,读起来才是一个产品。
   ========================================================================== */
.grp {
  --ctl-w: 260px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
}
.grp-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.grp-cap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
  min-height: 28px;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--bbi-ink-soft);
}
.grp-cap-tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0;
}
.grp-foot {
  margin: 0 4px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bbi-ink-muted);
}
.grp-foot.is-warn {
  color: var(--bbi-warning);
}
.list-foot + .grp-foot {
  margin-top: 10px;
}

/* —— 设置行:左标签 / 右控件 —— */
.grp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 46px;
  padding: 7px 12px 7px 14px;
}
.grp-row + .grp-row,
.grp-item + .grp-item {
  border-top: 1px solid var(--bbi-line);
}
.grp-row.is-clickable {
  cursor: pointer;
}
/* 块级控件(文本框)占满整行:说明在上、框在下 */
.grp-row.is-stack {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 10px 12px 12px 14px;
}
.grp-label {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbi-ink);
  white-space: nowrap;
}
.grp-sub {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--bbi-ink-muted);
  white-space: normal;
}
.grp-note {
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bbi-ink-muted);
}
.grp-note.is-error {
  color: var(--bbi-danger);
}
.grp-ctl {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
}
/* 下拉/组合框统一宽度(.grp 前缀抬高优先级,压过子组件根类自带的 180px / 100%);窄了就跟着缩 */
.grp .grp-ctl-w {
  width: var(--ctl-w);
  flex: 0 1 auto;
  min-width: 0;
}
/* 后面跟一个 30px 图标钮的:扣掉钮宽 + 间距,右缘仍与别的行对齐 */
.grp .grp-ctl-w.is-short {
  width: calc(var(--ctl-w) - 36px);
}
/* 卡内输入框与下拉同高(下拉 6px 上下内边距);:deep 才够得着组合框内部的 input。
   只改上下,不碰左右——组合框靠 padding-right 给三角让位 */
.grp :deep(.bbi-input) {
  padding-top: 6px;
  padding-bottom: 6px;
  line-height: 1.5;
}
/* 尺寸、步数这类短值:窄框、数位靠右,与行右缘对齐 */
.grp-short {
  width: 124px;
  flex: none;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* 卡内文本框:去描边、垫次级底色,不在白卡里再套一层框;聚焦时才描出来 */
.grp .grp-textarea {
  border-color: transparent;
  background: var(--bbi-surface-2);
}
.grp .grp-textarea:focus {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}

/* 行内的小号分段开关:默认 .bbi-seg 是页级尺寸,放进 46px 的行里太胖 */
.seg-sm {
  flex: none;
  gap: 2px;
  padding: 3px;
  border-radius: var(--bbi-radius-sm);
}
.seg-sm .bbi-seg {
  padding: 4px 12px;
  font-size: 12.5px;
  border-radius: 6px;
}

/* 状态药丸:复用全局 bbi-prompt-state 基样式,此处只按 tone 上色 */
.state-pill.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.state-pill.is-error {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
  border-color: transparent;
}

/* —— 列表行:主体可点(选中 / 打开),操作钮挂在行尾 —— */
.grp-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
}
.item-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 6px 10px 14px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
}
.item-main:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
  border-radius: var(--bbi-radius-sm);
}
.item-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.item-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  transition: color var(--bbi-dur) var(--bbi-ease);
}
.item-main:hover .item-name {
  color: var(--bbi-accent);
}
.item-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--bbi-ink-muted);
}
.item-ops {
  display: flex;
  gap: 2px;
  flex: none;
}

/* 方案行:只有圆点 + 名字,行高与设置行(46px)对齐;圆点 = 当前出图用的那套,选中行底色从左侧淡入 */
.plan-item .item-main {
  min-height: 46px;
}
.plan-item.is-on {
  background: linear-gradient(90deg, var(--bbi-accent-soft), transparent 70%);
}
.plan-radio {
  position: relative;
  flex: none;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--bbi-line-strong);
  border-radius: 50%;
  transition: border-color var(--bbi-dur) var(--bbi-ease);
}
.item-main:hover .plan-radio,
.plan-item.is-on .plan-radio {
  border-color: var(--bbi-accent);
}
/* 不用 inset 简写:部分移动端 WebView 不认(同 base.css .bbi-overlay) */
.plan-item.is-on .plan-radio::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  bottom: 3px;
  left: 3px;
  border-radius: 50%;
  background: var(--bbi-accent);
}

/* 类型小标:插画用强调色、漫画用警示色,扫一眼就能分组 */
.kind-tag {
  flex: none;
  padding: 0 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.7;
}
.kind-tag.is-illustration {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
}
.kind-tag.is-comic {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
}

/* 渠道行:名称定宽 + 地址吃满 + 两个操作(放在 .grp-item 之后,覆盖其 flex) */
.srv-item {
  display: grid;
  grid-template-columns: minmax(0, 8.5em) minmax(0, 1fr) auto;
  gap: 8px;
  padding: 8px 8px 8px 12px;
}
.srv-item > .bbi-input {
  min-width: 0;
}

/* LoRA 行:文件名吃满,强度与删除收尾 */
.lora-row {
  padding-right: 8px;
}
.grp .lora-name {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.lora-str {
  width: 72px;
  flex: none;
  text-align: right;
}

/* 列表下方的操作条:新建在左,测试与「用它出图」在右 */
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
.in-use,
.plan-current {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--bbi-accent);
  white-space: nowrap;
}

/* —— 按钮:图标钮(行尾操作)与文字钮(次要动作),都不带框 —— */
.icon-btn {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-soft);
  cursor: pointer;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.icon-btn:hover:not(:disabled) {
  color: var(--bbi-ink);
  background: var(--bbi-surface-2);
}
.icon-btn.is-danger:not(:disabled) {
  color: var(--bbi-danger);
}
.icon-btn.is-danger:not(:disabled):hover {
  background: var(--bbi-danger-soft);
}
.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.icon-btn:focus-visible,
.quiet-btn:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
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

/* —— 方案弹窗 —— */
.plan-modal {
  max-width: 600px;
  gap: 16px;
}
.plan-name-input {
  padding: 9px 12px;
  font-size: 14px;
  font-weight: 600;
}
/* 底栏钉在底部:弹窗内容长,滚到哪都能一键「完成」。负 margin 抵消 .bbi-modal 内边距(同 .bbi-modal-head) */
.plan-modal .bbi-modal-foot {
  position: sticky;
  bottom: -18px;
  z-index: 1;
  align-items: center;
  margin: 0 -18px -18px;
  padding: 12px 18px 18px;
  border-top: 1px solid var(--bbi-line);
  background: var(--bbi-bg);
}

/* —— 提示词弹窗 —— */
.ps-name-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.ps-impact {
  margin: 0;
}
.ps-tabs {
  align-self: flex-start;
}

/* —— AI 配置预览弹窗 —— */
.workflow-assist-modal {
  width: min(720px, calc(100vw - 32px));
}
.workflow-change-list {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.workflow-change {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.workflow-change-role {
  flex: 0 0 118px;
  color: var(--bbi-ink);
  font-weight: 600;
}
.workflow-change code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--bbi-accent);
  font-family: var(--bbi-font-mono);
}
.workflow-detection {
  margin: 9px 0 0;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  line-height: 1.5;
}

/* 以下为借用的「看起来全局」的类名:它们只在别的组件 scoped 块里声明,
   scoped 不跨组件,故连 base 规则一起补一份(漏了会渲染成浏览器原生样式)。 */
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
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
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
.bbi-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbi-macro-tip {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  margin-right: 2px;
}
.bbi-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease), border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-macro:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
}

@media (max-width: 640px) {
  /* 窄屏控件列收窄,给标签留出位置(仍按行右缘对齐) */
  .grp {
    --ctl-w: 210px;
  }
  /* 渠道行:名称独占一行,地址与操作同行 */
  .srv-item {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .srv-item > .srv-name {
    grid-column: 1 / -1;
  }
  .workflow-change {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }
  .workflow-change-role {
    flex-basis: auto;
  }
}
</style>
