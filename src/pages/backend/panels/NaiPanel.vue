<script setup lang="ts">
import {
  CHATU8_SETTINGS_KEY,
  detectChatu8Artists,
  detectChatu8Vibes,
  importArtistsFromChatu8,
  importVibesFromChatu8,
  planPrefixGroups,
  type Chatu8ArtistDetectInfo,
  type Chatu8ArtistImportResult,
  type Chatu8DetectInfo,
} from '@/backends/chatu8Vibe';
import {
  buildNaiv4vibe,
  encodeVibeImage,
  isBuiltinNaiArtist,
  isNai45,
  isNai5,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiFixedSettings,
  naiSamplers,
  naiSupportsVibes,
  NAI_NOISE_SCHEDULES,
  NAI_SAMPLERS,
  parseNaiv4vibe,
  testNaiConnection,
  vibeModelKey,
} from '@/backends/nai';
import {
  clampVibeStrength,
  deleteVibeData,
  loadVibeData,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import NaiArtistLibrary from '@/pages/backend/panels/NaiArtistLibrary.vue';
import NaiArtistPicker from '@/pages/backend/panels/NaiArtistPicker.vue';
import { artistPreviewSrc } from '@/pages/backend/panels/artistPreview';
import { acquireNaiSlot } from '@/floor/genQueue';
import { makeJpegThumbnail } from '@/st/imageFile';
import {
  groupKey,
  groupVibes,
  isGroupActive,
  matchVibe,
  GROUP_PREFIX,
  NEW_GROUP,
  UNGROUPED,
  type VibeGroup,
} from '@/backends/vibeGroups';
import Collapsible from '@/components/Collapsible.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { getContext } from '@/st/context';
import {
  activeNaiPlan,
  effectiveNai,
  isOfficialNaiEndpoint,
  naiArtistFor,
  naiEndpointFor,
  newNaiEndpoint,
  newNaiPlan,
  NAI_CONCURRENCY_MAX,
  NAI_MODELS,
  NAI_OFFICIAL_URL,
  ORIENTATION_LOCKS,
  settings,
  type NaiEndpoint,
  type NaiPlan,
  type NaiVibe,
} from '@/state/settings';
import { computed, onMounted, ref } from 'vue';

/** 本渠道是否为当前出图渠道;「用 NovelAI 出图」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'nai');

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

function modelLabel(model: string): string {
  return NAI_MODELS.find(m => m.value === model)?.label ?? model;
}

/**
 * 方案与接入点共用一个删除确认框(同 ComfyUIPanel):同一时刻只会有一个待删对象。
 * 存 id 而非对象引用——确认前库可能被别处改动,删时按 id 现查。
 */
type DeleteTarget = { type: 'plan' | 'endpoint'; id: string; name: string };
const pendingDelete = ref<DeleteTarget | null>(null);
const deleteOpen = computed({
  get: () => !!pendingDelete.value,
  set: open => {
    if (!open) pendingDelete.value = null;
  },
});
const DELETE_TITLES: Record<DeleteTarget['type'], string> = {
  plan: '删除出图方案',
  endpoint: '删除接入点',
};

function confirmDelete() {
  const target = pendingDelete.value;
  pendingDelete.value = null;
  if (!target) return;
  if (target.type === 'plan') removePlan(target.id);
  else removeEndpoint(target.id);
}

function planNames(plans: NaiPlan[]): string {
  return plans.map(p => `「${p.name || '未命名方案'}」`).join('');
}

/** 按**解析后**的引用统计:悬空引用回落到谁,就算谁在用(与出图实际取值同口径)。 */
function plansUsingEndpoint(id: string): NaiPlan[] {
  return settings.nai.plans.filter(p => naiEndpointFor(p).id === id);
}

/* ============ 出图方案 ============ */

/** 当前(出图用的)方案:存的 id 悬空时 activeNaiPlan 回落第一条,列表的选中点也跟着它走。 */
const active = computed(() => activeNaiPlan());

/** 只剩一套时不给删:plans 恒非空是全局不变式,禁用比「点了没反应」诚实。 */
const canRemove = computed(() => settings.nai.plans.length > 1);

function switchTo(target: { id: string }) {
  settings.nai.activePlanId = target.id;
}

/**
 * 方案编辑弹窗的对象。编辑与「选中出图」脱钩:改哪套就点哪套的 ✎,不必先把它设成当前。
 * 弹窗关着时回落当前方案,让下面那些按方案取值的 computed 恒有对象可读。
 * 改动即时生效、没有草稿:与 ComfyUI 方案同一手感。
 */
const editingPlanId = ref('');
const plan = computed(
  () => settings.nai.plans.find(p => p.id === editingPlanId.value) ?? active.value,
);
const planOpen = computed(
  () => !!editingPlanId.value && settings.nai.plans.some(p => p.id === editingPlanId.value),
);

function openPlan(target: { id: string }) {
  planVibeSearch.value = '';
  editingPlanId.value = target.id;
}

function closePlan() {
  editingPlanId.value = '';
}

/** 新建/复制都直接打开它的编辑窗,但不抢「当前」:一套还没配好的方案顶上去只会出不了图。 */
function addPlan() {
  // 新方案沿用当前方案的接入点:多数人只有一个站,省得每次新建都再选一遍
  const created: NaiPlan = {
    ...newNaiPlan(`方案 ${settings.nai.plans.length + 1}`),
    endpointId: naiEndpointFor(active.value).id,
  };
  settings.nai.plans.push(created);
  openPlan(created);
}

function duplicatePlan(source: NaiPlan) {
  // 拷全部字段,只换 id 与名字;vibeIds 是数组,必须深拷——浅拷会让两套方案共享同一份勾选
  const created: NaiPlan = {
    ...source,
    id: newNaiPlan().id,
    name: `${source.name || '未命名方案'} 副本`,
    vibeIds: [...source.vibeIds],
  };
  const list = settings.nai.plans;
  const index = list.findIndex(p => p.id === source.id);
  list.splice(index < 0 ? list.length : index + 1, 0, created);
  openPlan(created);
}

function askRemovePlan(target: NaiPlan) {
  pendingDelete.value = { type: 'plan', id: target.id, name: target.name || '未命名方案' };
}

function removePlan(id: string) {
  const list = settings.nai.plans;
  if (list.length <= 1) return;
  const index = list.findIndex(p => p.id === id);
  if (index < 0) return;
  const wasActive = active.value.id === id;
  list.splice(index, 1);
  // 删掉的是当前项:接位到原位置那一条(已是最后一条则退一格)
  if (wasActive) settings.nai.activePlanId = list[Math.min(index, list.length - 1)].id;
}

const testing = ref(false);

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  const name = naiEndpointFor(active.value).name || 'NovelAI';
  try {
    // 测当前方案所用的接入点,与出图同一份连接
    const result = await testNaiConnection(effectiveNai());
    toastr.success(result.message, `NAI 连接 · ${name}`);
  } catch (error) {
    toastr.error(errorMessage(error), `NAI 连接失败 · ${name}`);
  } finally {
    testing.value = false;
  }
}

/* —— 方案弹窗:来源 —— */

const endpointOptions = computed(() =>
  settings.nai.endpoints.map(e => ({ value: e.id, label: e.name || '未命名接入点' })),
);

/** 取解析后的那个:存的 id 悬空时下拉也显示实际生效的那条,不显示空白。 */
const planEndpointId = computed<string>({
  get: () => naiEndpointFor(plan.value).id,
  set: id => {
    plan.value.endpointId = id;
  },
});

/** BbiSelect 的 modelValue 是 string,而 model 是字面量联合;写入前对一遍 NAI_MODELS。 */
const planModel = computed<string>({
  get: () => plan.value.model,
  set: v => {
    const hit = NAI_MODELS.find(m => m.value === v);
    if (!hit) return;
    const target = plan.value;
    // 只在用户从其它模型切进 4.5 时建议默认纯 tag;已有 4.5 方案、切方案与加载设置都不经过这里。
    const entering45 = isNai45(hit.value) && !isNai45(target.model);
    target.model = hit.value;
    if (entering45 && target.naturalLanguage) {
      target.naturalLanguage = false;
      toastr.info('已切换到 NAI 4.5，并关闭「生成自然语言」以避免提示词过长被截断；需要时可在下方重新开启。', '已关闭自然语言');
    }
  },
});

const samplerOptions = computed(() => naiSamplers(plan.value.model));

/** 官方锁死参数的模型(V5 Full Medium):步数/采样器/Rescale/负面词不可调,面板照官方前端收起。 */
const planFixed = computed(() => naiFixedSettings(plan.value.model));
const planFixedSamplerLabel = computed(() => {
  const value = planFixed.value?.sampler ?? '';
  return NAI_SAMPLERS.find(s => s.value === value)?.label ?? value;
});

/* —— 方案弹窗:画风 —— */

/** 取「实际生效的那一条」:id 悬空时 naiArtistFor 返回 null,入口跟着显示「不使用」。 */
const planArtist = computed(() => naiArtistFor(plan.value));

const planArtistBuiltin = computed(() =>
  planArtist.value ? isBuiltinNaiArtist(planArtist.value.id) : false,
);

/** 同一条画师串还被哪些别的方案用着:内容是共享的,改之前得知道会连带谁。 */
const artistSharedWith = computed(() => {
  const a = planArtist.value;
  if (!a) return [];
  return settings.nai.plans.filter(p => p.id !== plan.value.id && p.artistId === a.id);
});

/** 挑选弹窗只服务正在编辑的这套方案(plan.id)。 */
const artistPickerOpen = ref(false);

/*
 * 正/负面词跟着方案引用的画师串走:对应字段有值就只用它,留空才回落模型官方词。
 * 方案里的两个框与画师串库编辑的是同一份数据;不选画师串时只读展示官方词。
 */
const officialQuality = computed(() => naiDefaultQualityTags(plan.value.model));
const officialNegative = computed(() => naiDefaultUndesired(plan.value.model));

type WordsKey = 'quality' | 'negative';

function isCustomWords(key: WordsKey): boolean {
  return !!planArtist.value?.[key].trim();
}

/** 「在官方词上改」:把官方词抄进当前画师串当起点;内置条目只读,不提供这个入口。 */
function fillOfficialWords(key: WordsKey) {
  const artist = planArtist.value;
  if (!artist || planArtistBuiltin.value) return;
  artist[key] = key === 'quality' ? officialQuality.value : officialNegative.value;
}

function resetWords(key: WordsKey) {
  const artist = planArtist.value;
  if (artist && !planArtistBuiltin.value) artist[key] = '';
}

/* —— 方案弹窗:Vibe —— */

/** 弹窗里的 vibe 搜索(与下方 Vibe 库的搜索各管各的)。 */
const planVibeSearch = ref('');
const planVibesSupported = computed(() => naiSupportsVibes(plan.value.model));
const planVibeKey = computed(() => vibeModelKey(plan.value.model));
const planVibeList = computed(() =>
  settings.nai.vibes.filter(v => matchVibe(v, planVibeSearch.value)),
);
const planVibeCount = computed(() => {
  const ids = new Set(plan.value.vibeIds);
  return settings.nai.vibes.filter(v => ids.has(v.id)).length;
});

/** 勾/不勾一张 vibe。顺序无所谓:effectiveNai 按库内顺序取。 */
function setPlanVibe(target: NaiPlan, id: string, on: boolean) {
  const has = target.vibeIds.includes(id);
  if (on && !has) target.vibeIds.push(id);
  else if (!on && has) target.vibeIds = target.vibeIds.filter(x => x !== id);
}

/* ============ 接入点库 ============ */

/**
 * 接入点只管「站」的事(地址 / Key / 同时出图数):换站是「同一套设置换个出口」,
 * 模型/画风/采样一概在方案里。列表只放名字,点行进弹窗编辑(与副 API 渠道同款):
 * 弹窗改的是草稿,点「完成」才写回;× / 点遮罩丢弃。官方那条地址固定、不可删、不可改名。
 */
const epDraft = ref<NaiEndpoint | null>(null);
/** 正在编辑的接入点 id;空串 = 新建(完成时 push)。 */
const epEditingId = ref('');
const epKeyShown = ref(false);
const epDraftOfficial = computed(() => !!epDraft.value && isOfficialNaiEndpoint(epDraft.value.id));

function openEndpoint(ep: NaiEndpoint) {
  epKeyShown.value = false;
  epEditingId.value = ep.id;
  epDraft.value = { ...ep };
}

function addEndpoint() {
  epKeyShown.value = false;
  epEditingId.value = '';
  epDraft.value = newNaiEndpoint(`接入点 ${settings.nai.endpoints.length + 1}`);
}

function closeEndpoint() {
  epDraft.value = null;
  epEditingId.value = '';
}

function confirmEndpoint() {
  const draft = epDraft.value;
  if (draft) {
    const n = Math.round(Number(draft.concurrency));
    draft.concurrency = Number.isFinite(n) ? Math.min(NAI_CONCURRENCY_MAX, Math.max(1, n)) : 1;
    const list = settings.nai.endpoints;
    const index = epEditingId.value ? list.findIndex(e => e.id === epEditingId.value) : -1;
    // 编辑期间原条目被删等异常 → 兜底为新增
    if (index >= 0) list[index] = draft;
    else list.push(draft);
  }
  closeEndpoint();
}

/** 删不了的原因;空串 = 可删。新建草稿还没入库,「删除」等于丢弃。 */
const epRemoveBlock = computed(() => {
  const draft = epDraft.value;
  if (!draft || !epEditingId.value) return '';
  if (isOfficialNaiEndpoint(draft.id)) return '官方接入点不可删除';
  const users = plansUsingEndpoint(draft.id);
  return users.length ? `正被${planNames(users)}使用,先给它们换一个再删` : '';
});

function askRemoveEndpoint() {
  const draft = epDraft.value;
  if (!draft || epRemoveBlock.value) return;
  if (!epEditingId.value) return closeEndpoint();
  pendingDelete.value = { type: 'endpoint', id: draft.id, name: draft.name || '未命名接入点' };
}

function removeEndpoint(id: string) {
  // 官方条不可删(endpoints 恒非空靠它保底);被方案引用的也不给删
  if (isOfficialNaiEndpoint(id) || plansUsingEndpoint(id).length) return;
  const list = settings.nai.endpoints;
  const index = list.findIndex(e => e.id === id);
  if (index >= 0) list.splice(index, 1);
  if (epEditingId.value === id) closeEndpoint();
}

const testingEndpoint = ref(false);

/** 测的是草稿:改完地址/Key 先测通再点完成。 */
async function onTestEndpoint() {
  const draft = epDraft.value;
  if (!draft || testingEndpoint.value) return;
  testingEndpoint.value = true;
  const name = draft.name || '接入点';
  try {
    const result = await testNaiConnection(draft);
    toastr.success(result.message, `NAI 连接 · ${name}`);
  } catch (error) {
    toastr.error(errorMessage(error), `NAI 连接失败 · ${name}`);
  } finally {
    testingEndpoint.value = false;
  }
}

/* ============ 从智绘姬迁移提示词预设 ============ */

/**
 * 智绘姬(st-chatu8)的提示词预设整批搬进画师串库:
 * 前置固定正向 → 画师串,后置固定正向 / 固定负向 → 画师串的自带正/负面词。
 * 只建副本、不改源数据;同名覆盖更新、内容相同跳过,随时可再来。
 * 纯逻辑在 chatu8Vibe.ts,这里只做检测展示、弹窗预览与落盘。
 *
 * 刻意不做「还剩 N 个可导入」的常驻提示:去重键是名字+内容,用户改过或删过
 * 本地副本后键就对不上,提示会反复复活,很吵。
 */
const chatu8ArtistDetect = ref<Chatu8ArtistDetectInfo>({ found: false, total: 0 });
const artistImportResult = ref<Chatu8ArtistImportResult | null>(null);
const artistImportOpen = ref(false);
/** 导入后是否让当前方案改用智绘姬当前使用的那条(连同它的正/负面词)。 */
const switchActiveArtist = ref(true);

const chatu8ActiveRef = computed(() => artistImportResult.value?.plans.find(p => p.active) ?? null);

function openArtistImport() {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  artistImportResult.value = importArtistsFromChatu8(settings.nai.artistPresets, chatu8, active.value.model);
  switchActiveArtist.value = true;
  artistImportOpen.value = true;
}

/** 纯同步:结果在打开弹窗时就算好了,确认只是 push/覆盖 + 可选切换。 */
function runArtistImport() {
  const result = artistImportResult.value;
  artistImportOpen.value = false;
  if (!result || (result.imported === 0 && result.overwritten === 0)) return;
  for (const item of result.plans) {
    if (item.state === 'import') {
      settings.nai.artistPresets.push(item.preset!);
    } else if (item.state === 'overwrite') {
      const target = settings.nai.artistPresets.find(p => p.id === item.targetId);
      if (target && item.preset) {
        target.prompt = item.preset.prompt;
        target.quality = item.preset.quality;
        target.negative = item.preset.negative;
      }
    }
  }
  const switched = switchActiveArtist.value && !!result.activeArtistId;
  if (switched) {
    // 正/负面词存在画师串上,换引用即整套切换,不再复制进方案。
    active.value.artistId = result.activeArtistId;
  }
  const parts = [`新增 ${result.imported} 个`];
  if (result.overwritten) parts.push(`覆盖更新 ${result.overwritten} 个`);
  if (result.duplicates) parts.push(`相同跳过 ${result.duplicates}`);
  if (switched) parts.push(`方案「${active.value.name}」已改用智绘姬当前使用的预设`);
  toastr.success(parts.join(', '), '从智绘姬导入');
  artistImportResult.value = null;
}

/* ============ Vibe 库 ============ */

/*
 * 库是全局的,勾选(叠加哪几张)记在方案上。这里的勾选作用于**当前方案**;
 * 编辑别的方案时在方案弹窗里勾。编码按当前方案的模型与接入点进行。
 */
const vibeEncoding = ref(false);
const vibeFileInput = ref<HTMLInputElement | null>(null);
const vibeImportInput = ref<HTMLInputElement | null>(null);

let vibeSeq = 0;

/** 当前方案模型的 vibe 编码 key;vibe 缺此 key 时生成会被跳过,列表里给「补编码」入口。 */
const currentVibeKey = computed(() => vibeModelKey(active.value.model));
const vibesSupported = computed(() => naiSupportsVibes(active.value.model));

const activeVibeIds = computed(() => new Set(active.value.vibeIds));

/** 生成 vibe 列表缩略图(最长边 96px 的 jpeg dataURL);失败回空串,由入库方按「无缩略图」处理。 */
async function makeThumbnail(dataUrl: string): Promise<string> {
  try {
    return await makeJpegThumbnail(dataUrl, 96);
  } catch {
    return '';
  }
}

/**
 * 取闸门槽位跑一次 vibe 编码。
 *
 * 编码是一次真实的 NAI 请求,所以与楼层卡片共用同一个接入点闸门(floor/genQueue.ts):
 * 否则「一边出图一边编码」在账号上就是两条并发,且完全绕过 429 冷却。
 * 代价是出图在跑时点编码会先等出图完 —— 这是对的,按钮那边有 vibeEncoding 转圈提示。
 */
async function encodeVibeGated(imageBase64: string): Promise<string> {
  const nai = effectiveNai();
  const release = await acquireNaiSlot(undefined, nai.endpointId);
  try {
    return await encodeVibeImage(nai, imageBase64, active.value.model);
  } finally {
    release();
  }
}

/** 新入库的 vibe 直接加进当前方案:上传/导入它就是为了马上用。 */
function addVibeToLibrary(vibe: NaiVibe) {
  settings.nai.vibes.push(vibe);
  setPlanVibe(active.value, vibe.id, true);
}

/** 上传参考图 → 调 /ai/encode-vibe 编码(按当前方案的模型)→ 入库。 */
async function onVibeFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
    const imageBase64 = dataUrl.split(',')[1] ?? '';
    const model = active.value.model;
    const encoding = await encodeVibeGated(imageBase64);
    const thumbnail = await makeThumbnail(dataUrl);
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = {
      image: imageBase64,
      thumbnail,
      encodings: { [vibeModelKey(model)]: { encoding, infoExtracted: 1 } },
    };
    const paths = await saveVibeFiles(data, null, id);
    addVibeToLibrary(
      vibeMetaFromData(
        id,
        file.name.replace(/\.[^.]+$/, '') || `Vibe ${settings.nai.vibes.length + 1}`,
        paths.dataPath,
        paths.thumbnailPath,
        data,
        0.6,
      ),
    );
    toastr.success(`已按 ${modelLabel(model)} 编码,加入 Vibe 库并在当前方案启用`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 编码失败');
  } finally {
    vibeEncoding.value = false;
  }
}

/** vibe 缺当前方案模型的编码时单独补(切换模型后常见)。 */
async function reencodeVibe(vibe: NaiVibe) {
  if (!vibe.hasImage || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const model = active.value.model;
    const data = await loadVibeData(vibe);
    if (!data.image) throw new Error('该 Vibe 没有参考原图');
    const encoding = await encodeVibeGated(data.image);
    data.encodings[vibeModelKey(model)] = { encoding, infoExtracted: 1 };
    const paths = await saveVibeFiles(data, vibe, vibe.id);
    vibe.dataPath = paths.dataPath;
    vibe.thumbnailPath = paths.thumbnailPath;
    vibe.modelKeys = Object.keys(data.encodings);
    vibe.fingerprint = vibeFingerprint(data.encodings);
    toastr.success(`「${vibe.name}」已补 ${modelLabel(model)} 编码`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 编码失败');
  } finally {
    vibeEncoding.value = false;
  }
}

/* ============ Vibe 分组 ============ */

/** 归拢/搜索/生效判定的纯逻辑在 backends/vibeGroups.ts,此处只做交互与落盘。 */
const vibeSearch = ref('');
/** 收起的组 key 集合(默认全展开;只存「收起」的,新建组自然是展开的)。 */
const collapsedGroups = ref<Set<string>>(new Set());

const vibeGroups = computed(() => groupVibes(settings.nai.vibes, vibeSearch.value));

/** 搜索命中总数:用于「没有匹配」空态,不必再算一遍列表。 */
const matchedCount = computed(() =>
  settings.nai.vibes.reduce((n, v) => n + (matchVibe(v, vibeSearch.value) ? 1 : 0), 0),
);

/** 库里已有的组名(去重,给「移到分组」下拉用;基于全库而非搜索结果)。 */
const groupNames = computed(() => {
  const names = new Set<string>();
  for (const vibe of settings.nai.vibes) {
    const name = vibe.group.trim();
    if (name) names.add(name);
  }
  return [...names];
});

/** 单条 vibe 的「所属分组」下拉项:未分组 + 已有组 + 新建(组名装箱,避免与哨兵撞名)。 */
const groupOptions = computed(() => [
  { value: UNGROUPED, label: '未分组' },
  ...groupNames.value.map(name => ({ value: `${GROUP_PREFIX}${name}`, label: name })),
  { value: NEW_GROUP, label: '＋ 新建分组…' },
]);

/** 选「新建分组」时就地问一个名字;取消或空名则维持原值(下拉是受控的,得回写)。 */
function onGroupPick(vibe: NaiVibe, value: string) {
  if (value === UNGROUPED) {
    vibe.group = '';
    return;
  }
  if (value.startsWith(GROUP_PREFIX)) {
    vibe.group = value.slice(GROUP_PREFIX.length);
    return;
  }
  const name = window.prompt('新分组名称')?.trim();
  if (name) vibe.group = name;
}

function isGroupCollapsed(key: string): boolean {
  return collapsedGroups.value.has(key);
}

function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value);
  if (!next.delete(key)) next.add(key);
  collapsedGroups.value = next;
}

function groupActive(group: VibeGroup): boolean {
  return isGroupActive(group, settings.nai.vibes, activeVibeIds.value);
}

/** 只开这组:当前方案只叠加本组。解决「换一套搭配」要逐条点的痛点。 */
function soloGroup(group: VibeGroup) {
  active.value.vibeIds = group.all.map(v => v.id);
}

/** 全开/全关只动本组,组外不碰——想叠加两组就各点一次「全开」。 */
function setGroupEnabled(group: VibeGroup, enabled: boolean) {
  const ids = new Set(active.value.vibeIds);
  for (const vibe of group.all) {
    if (enabled) ids.add(vibe.id);
    else ids.delete(vibe.id);
  }
  active.value.vibeIds = [...ids];
}

const enabledCount = computed(
  () => settings.nai.vibes.filter(v => activeVibeIds.value.has(v.id)).length,
);

function groupEnabledCount(group: VibeGroup): number {
  return group.all.filter(v => activeVibeIds.value.has(v.id)).length;
}

/** 重命名整组:对成员 group 字段批量赋值,不存在悬空引用。 */
function renameGroup(group: VibeGroup) {
  if (!group.name) return;
  const name = window.prompt('重命名分组', group.name)?.trim();
  if (!name || name === group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = name;
  }
  // 收起状态跟着改名走(集合里存的是装箱 key),否则改完名字会莫名展开
  const from = groupKey(group.name);
  if (collapsedGroups.value.has(from)) {
    const next = new Set(collapsedGroups.value);
    next.delete(from);
    next.add(groupKey(name));
    collapsedGroups.value = next;
  }
}

/** 解散分组:只清 group 字段,vibe 本体与各方案的勾选都不动(不是删除)。 */
function dissolveGroup(group: VibeGroup) {
  if (!group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = '';
  }
}

/**
 * 旧版从智绘姬迁移时把组名拼进了显示名(「组名 · 原名」),分组结构因此丢失。
 * 这里按前缀还原:只动未分组的条目,不覆盖用户已手工分好的组。
 * 按钮仅在真有可整理的条目时出现。
 */
const prefixGroupPlans = computed(() => planPrefixGroups(settings.nai.vibes));

function applyPrefixGroups() {
  const items = prefixGroupPlans.value;
  if (!items.length) return;
  const byId = new Map(settings.nai.vibes.map(v => [v.id, v]));
  for (const item of items) {
    const vibe = byId.get(item.id);
    if (!vibe) continue;
    vibe.group = item.group;
    vibe.name = item.name;
  }
  const groups = new Set(items.map(p => p.group)).size;
  toastr.success(`已把 ${items.length} 个 Vibe 整理进 ${groups} 个分组`, 'Vibe');
}

/* ============ 从智绘姬迁移 vibe ============ */

/**
 * 智绘姬 vibe 检测:面板挂载时做一次(读的是 settings 里的引用列表,同步廉价)。
 * 不做「只问一次」那套:区块常驻,迁移幂等(内容指纹去重),用户随时可以再来。
 */
const chatu8Detect = ref<Chatu8DetectInfo>({ found: false, total: 0, presets: 0, groups: 0 });
onMounted(() => {
  chatu8Detect.value = detectChatu8Vibes(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
  chatu8ArtistDetect.value = detectChatu8Artists(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
});

const migrateConfirmOpen = ref(false);
const migrating = ref(false);
const migrateMsg = ref('');

async function runMigrate() {
  migrateConfirmOpen.value = false;
  if (migrating.value) return;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const result = await importVibesFromChatu8(settings.nai.vibes, {
      onProgress: (current, total) => {
        migrateMsg.value = `正在迁移 ${current}/${total}…`;
      },
    });
    // 迁移进来的不加进任何方案:一次几十张,全叠上去画面就糊了
    settings.nai.vibes.push(...result.vibes);
    const parts = [`新增 ${result.imported} 个`];
    if (result.duplicates) parts.push(`重复跳过 ${result.duplicates}`);
    if (result.failed) parts.push(`失败 ${result.failed}`);
    migrateMsg.value = `迁移完成：${parts.join(' / ')}。`;
    if (result.imported) migrateMsg.value += '新迁移的 Vibe 没有加进任何方案，请按需勾选。';
    if (result.failed) migrateMsg.value += '失败项可能不在本机浏览器，或保存文件时出错。';
    toastr.success(migrateMsg.value, '从智绘姬迁移');
  } catch (error) {
    migrateMsg.value = `迁移失败：${errorMessage(error)}`;
  } finally {
    migrating.value = false;
  }
}

async function onVibeImportChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = parseNaiv4vibe(await file.text());
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = { image: parsed.image, thumbnail: parsed.thumbnail, encodings: parsed.encodings };
    const paths = await saveVibeFiles(data, null, id);
    addVibeToLibrary(
      vibeMetaFromData(id, parsed.name, paths.dataPath, paths.thumbnailPath, data, parsed.strength),
    );
    toastr.success(`已导入「${parsed.name}」并在当前方案启用`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 导入失败');
  }
}

async function exportVibe(vibe: NaiVibe) {
  try {
    const json = await buildNaiv4vibe(vibe, await loadVibeData(vibe));
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${vibe.name || 'vibe'}.naiv4vibe`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 导出失败');
  }
}

/**
 * 强度取值:滑块与数字框共用 clampVibeStrength(与设置反序列化、vibe 导入同一口径)。
 * 滑块步进 0.01 只是「拖着好用」的粒度,数字框 step="any" 才是真正的自由填值。
 */
function setVibeStrength(vibe: NaiVibe, raw: unknown) {
  vibe.strength = clampVibeStrength(raw, vibe.strength);
}

/**
 * 数字框走 change(而非 input):中途输入 "0." / "-" 这类残缺串不该立刻被夹成 0。
 * 夹取后回写 input.value——填了 5 会被夹到 1,而当强度本来就是 1 时模型值没变、
 * Vue 不会重渲染,框里就会留着一个骗人的 "5"。
 */
function commitVibeStrength(vibe: NaiVibe, event: Event) {
  const input = event.target as HTMLInputElement;
  setVibeStrength(vibe, input.value);
  input.value = String(vibe.strength);
}

async function removeVibe(vibe: NaiVibe) {
  let deleteError: unknown = null;
  try {
    await deleteVibeData(vibe);
  } catch (error) {
    deleteError = error;
  }
  const index = settings.nai.vibes.indexOf(vibe);
  if (index >= 0) settings.nai.vibes.splice(index, 1);
  // 各方案的勾选一并清掉,不留指向已删 vibe 的悬空 id
  for (const p of settings.nai.plans) {
    if (p.vibeIds.includes(vibe.id)) p.vibeIds = p.vibeIds.filter(id => id !== vibe.id);
  }
  if (deleteError) toastr.warning(`索引已删除，但文件清理失败：${errorMessage(deleteError)}`, 'Vibe');
}
</script>

<template>
  <div class="panel">
    <div class="bbi-sections">
      <Collapsible title="出图方案">
        <!-- 一套方案 = 接入点 + 模型 + 画风 + 采样;点行整套切换,点 ✎ 才弹出它的全部设置 -->
        <div class="grp" role="radiogroup" aria-label="出图方案">
          <div
            v-for="p in settings.nai.plans"
            :key="p.id"
            class="grp-item plan-item"
            :class="{ 'is-on': p.id === active.id }"
          >
            <button
              class="item-main"
              type="button"
              role="radio"
              :aria-checked="p.id === active.id"
              :title="p.id === active.id ? '当前出图用的方案' : '改用这套方案出图'"
              @click="switchTo(p)"
            >
              <span class="plan-radio" aria-hidden="true"></span>
              <span class="item-name">{{ p.name || '未命名方案' }}</span>
            </button>
            <span class="item-ops">
              <button class="icon-btn" type="button" title="编辑这套方案" aria-label="编辑这套方案" @click="openPlan(p)">
                <Icon name="edit" :size="14" />
              </button>
              <button class="icon-btn" type="button" title="复制这套方案" aria-label="复制这套方案" @click="duplicatePlan(p)">
                <Icon name="copy" :size="14" />
              </button>
              <button
                class="icon-btn is-danger"
                type="button"
                :disabled="!canRemove"
                :title="canRemove ? '删除这套方案' : '至少要保留一套方案'"
                aria-label="删除这套方案"
                @click="askRemovePlan(p)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </span>
          </div>
        </div>
        <div class="list-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="addPlan">
            <Icon name="plus" :size="12" />
            新建方案
          </button>
          <span class="list-foot-spacer"></span>
          <button
            class="quiet-btn"
            type="button"
            :disabled="testing"
            title="测试当前方案所用的接入点"
            @click="onTestConnection"
          >
            <Icon name="plug" :size="13" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
          <span v-if="inUse" class="in-use"><Icon name="check" :size="13" /> 正在用 NovelAI 出图</span>
          <button
            v-else
            class="bbi-btn bbi-btn-sm bbi-btn-primary"
            type="button"
            title="tag 书写规范会切到 NAI"
            @click="settings.defaultBackend = 'nai'"
          >
            用 NovelAI 出图
          </button>
        </div>
      </Collapsible>

      <Collapsible title="接入点" :open="false">
        <!-- 只列名字,点行进弹窗编辑(与副 API 渠道同款) -->
        <div class="grp">
          <div v-for="ep in settings.nai.endpoints" :key="ep.id" class="grp-item ep-item">
            <button class="item-main" type="button" title="编辑这个接入点" @click="openEndpoint(ep)">
              <span class="item-name">{{ ep.name || '未命名接入点' }}</span>
              <Icon name="chevron" class="ep-chevron" :size="14" />
            </button>
          </div>
        </div>
        <div class="list-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="addEndpoint">
            <Icon name="plus" :size="12" />
            添加接入点
          </button>
        </div>
      </Collapsible>

      <Collapsible title="画师串库" :open="false">
        <NaiArtistLibrary />
      </Collapsible>

      <Collapsible title="Vibe 库(氛围转移)" :open="false">
        <p v-if="vibesSupported" class="bbi-field-hint vibe-hint">
          上传参考图,生成时叠加其风格/氛围;编码按当前方案「{{ active.name }}」的模型进行,会消耗一次接口调用。
          这里的勾选作用于当前方案,别的方案在它的编辑窗里勾。
        </p>
        <p v-else class="bbi-field-hint vibe-hint">
          当前方案用的是 NAI 5,官方暂不支持 Vibe:勾选会保留,但出图时跳过;编码要先切到 4.5 方案。
        </p>

        <div class="vibe-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="vibeEncoding || !vibesSupported"
            @click="vibeFileInput?.click()"
          >
            <Icon name="plus" />
            {{ vibeEncoding ? '编码中…' : '上传图片编码' }}
          </button>
          <button class="bbi-btn" type="button" @click="vibeImportInput?.click()">
            <Icon name="download" />
            导入 .naiv4vibe
          </button>
          <input ref="vibeFileInput" type="file" accept="image/*" hidden @change="onVibeFileChange" />
          <input ref="vibeImportInput" type="file" accept=".naiv4vibe" hidden @change="onVibeImportChange" />
        </div>

        <p v-if="!settings.nai.vibes.length" class="bbi-field-hint">还没有 vibe;上传一张参考图开始。</p>

        <template v-else>
          <div class="vibe-toolbar">
            <input
              class="bbi-input vibe-search"
              type="search"
              v-model="vibeSearch"
              placeholder="搜索名称或分组…"
              spellcheck="false"
              aria-label="搜索 Vibe"
            />
            <span class="vibe-count">
              共 {{ settings.nai.vibes.length }} 个 · 当前方案叠加 {{ enabledCount }}
            </span>
            <button
              v-if="prefixGroupPlans.length"
              class="bbi-btn bbi-btn-sm"
              type="button"
              title="旧版迁移把组名拼进了名字,点此还原成真正的分组"
              @click="applyPrefixGroups"
            >
              <Icon name="checklist" :size="12" />
              按名称整理分组({{ prefixGroupPlans.length }})
            </button>
          </div>

          <p v-if="!matchedCount" class="bbi-field-hint">没有匹配「{{ vibeSearch }}」的 Vibe。</p>

          <div v-for="group in vibeGroups" :key="group.key" class="vibe-group">
            <div class="vibe-group-head">
              <button
                class="vibe-group-toggle"
                type="button"
                :aria-expanded="!isGroupCollapsed(group.key)"
                @click="toggleGroup(group.key)"
              >
                <Icon
                  name="chevron"
                  :size="14"
                  class="vibe-group-chevron"
                  :class="{ 'is-collapsed': isGroupCollapsed(group.key) }"
                />
                <span class="vibe-group-name">{{ group.label }}</span>
                <span class="vibe-group-meta">
                  {{ groupEnabledCount(group) }}/{{ group.all.length }}
                  <template v-if="group.items.length !== group.all.length">
                    · 显示 {{ group.items.length }}
                  </template>
                </span>
                <span v-if="groupActive(group)" class="bbi-prompt-state vibe-group-active">
                  生效中
                </span>
              </button>
              <span class="vibe-group-ops">
                <button
                  class="bbi-btn bbi-btn-sm bbi-btn-primary"
                  type="button"
                  title="当前方案只叠加这一组:关掉组外全部勾选,开启本组"
                  @click="soloGroup(group)"
                >
                  只开这组
                </button>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  title="开启本组,不影响其它组(用来叠加多组)"
                  @click="setGroupEnabled(group, true)"
                >
                  全开
                </button>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  title="关闭本组"
                  @click="setGroupEnabled(group, false)"
                >
                  全关
                </button>
                <button
                  v-if="group.name"
                  class="bbi-icon-mini"
                  type="button"
                  title="重命名分组"
                  aria-label="重命名分组"
                  @click="renameGroup(group)"
                >
                  <Icon name="edit" :size="12" />
                </button>
                <button
                  v-if="group.name"
                  class="bbi-icon-mini"
                  type="button"
                  title="解散分组(只取消归类,不删除 Vibe)"
                  aria-label="解散分组"
                  @click="dissolveGroup(group)"
                >
                  <Icon name="close" :size="12" />
                </button>
              </span>
            </div>

            <div v-show="!isGroupCollapsed(group.key)" class="vibe-group-body">
              <div v-for="vibe in group.items" :key="vibe.id" class="vibe-item">
                <img
                  v-if="vibe.thumbnailPath"
                  class="vibe-thumb"
                  :src="vibe.thumbnailPath"
                  :alt="vibe.name"
                  loading="lazy"
                  decoding="async"
                />
                <div v-else class="vibe-thumb vibe-thumb--empty"><Icon name="generate" /></div>
                <div class="vibe-main">
                  <div class="vibe-head">
                    <input class="bbi-input vibe-name" type="text" v-model="vibe.name" spellcheck="false" />
                    <label class="vibe-enable" title="当前方案出图时叠加此 vibe">
                      <input
                        type="checkbox"
                        class="bbi-checkbox"
                        :checked="activeVibeIds.has(vibe.id)"
                        @change="setPlanVibe(active, vibe.id, ($event.target as HTMLInputElement).checked)"
                      />
                      叠加
                    </label>
                  </div>
                  <div class="vibe-strength">
                    <span class="vibe-strength-label">强度</span>
                    <input
                      class="bbi-range"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      :value="vibe.strength"
                      aria-label="强度"
                      @input="setVibeStrength(vibe, ($event.target as HTMLInputElement).value)"
                    />
                    <input
                      class="bbi-input vibe-strength-num"
                      type="number"
                      min="0"
                      max="1"
                      step="any"
                      :value="vibe.strength"
                      aria-label="强度数值"
                      @change="commitVibeStrength(vibe, $event)"
                    />
                  </div>
                  <div class="vibe-ops">
                    <BbiSelect
                      class="vibe-group-select"
                      :model-value="groupKey(vibe.group)"
                      :options="groupOptions"
                      aria-label="所属分组"
                      @update:model-value="onGroupPick(vibe, $event)"
                    />
                    <button
                      v-if="vibesSupported && !vibe.modelKeys.includes(currentVibeKey) && vibe.hasImage"
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      :disabled="vibeEncoding"
                      title="该 vibe 缺当前方案模型的编码,生成时会被跳过;点击补编码"
                      @click="reencodeVibe(vibe)"
                    >
                      <Icon name="refresh" :size="12" /> 补当前模型编码
                    </button>
                    <span
                      v-else-if="vibesSupported && !vibe.modelKeys.includes(currentVibeKey)"
                      class="vibe-missing"
                    >
                      缺当前模型编码且无原图,无法使用
                    </span>
                    <button
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      title="导出 .naiv4vibe"
                      @click="exportVibe(vibe)"
                    >
                      <Icon name="upload" :size="12" /> 导出
                    </button>
                    <button
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      title="从库里删除(所有方案的勾选一并移除)"
                      @click="removeVibe(vibe)"
                    >
                      <Icon name="trash" :size="12" /> 删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </Collapsible>

      <Collapsible title="从智绘姬迁移" :open="false">
        <p class="bbi-field-hint vibe-hint">
          复制智绘姬(st-chatu8)的 vibe 到本库:只建副本、不改源数据,重复的自动跳过。
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8Detect.found">未检测到智绘姬（插件未安装或未启用）。</template>
          <template v-else-if="!chatu8Detect.total">智绘姬里没有找到 vibe。</template>
          <template v-else>
            检测到智绘姬有 {{ chatu8Detect.total }} 个 vibe（预设 {{ chatu8Detect.presets }} 个 / 组内
            {{ chatu8Detect.groups }} 个）。
          </template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="migrating || !chatu8Detect.total"
            @click="migrateConfirmOpen = true"
          >
            <Icon name="download" />
            {{ migrating ? '迁移中…' : '迁移智绘姬的 vibe' }}
          </button>
        </div>
        <p v-if="migrateMsg" class="bbi-field-hint">{{ migrateMsg }}</p>

        <hr class="art-divider" />

        <!-- 提示词预设导入:与 vibe 同区同级;有没有新预设不在这里报,点开弹窗看预览 -->
        <p class="bbi-field-hint vibe-hint">
          提示词预设同理:前置固定正向 → 画师串，后置固定正向 / 固定负向 → 画师串的正/负面词（选中后自动生效）。
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8ArtistDetect.found">未检测到智绘姬（插件未安装或未启用）。</template>
          <template v-else-if="!chatu8ArtistDetect.total">智绘姬里没有找到提示词预设。</template>
          <template v-else>检测到智绘姬有 {{ chatu8ArtistDetect.total }} 个提示词预设。</template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="!chatu8ArtistDetect.total"
            @click="openArtistImport"
          >
            <Icon name="download" />
            导入智绘姬的提示词预设
          </button>
        </div>
      </Collapsible>
    </div>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="pendingDelete ? DELETE_TITLES[pendingDelete.type] : ''"
      confirm-text="删除"
      confirm-icon="trash"
      tone="danger"
      top-layer
      @confirm="confirmDelete"
    >
      确定删除「{{ pendingDelete?.name }}」？删除后无法恢复。
    </ConfirmDialog>

    <!-- ===== 接入点编辑弹窗:改的是草稿,点「完成」才写回 ===== -->
    <ModalMask :open="!!epDraft" @close="closeEndpoint">
      <div v-if="epDraft" class="bbi-modal ep-modal" role="dialog" aria-modal="true" aria-label="编辑接入点">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">{{ epEditingId ? '编辑接入点' : '添加接入点' }}</span>
          <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="closeEndpoint">
            <Icon name="close" />
          </button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">名称</span>
          <input
            v-model="epDraft.name"
            class="bbi-input"
            type="text"
            placeholder="名称"
            spellcheck="false"
            :readonly="epDraftOfficial"
          />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">地址</span>
          <input
            v-model="epDraft.url"
            class="bbi-input"
            type="text"
            :placeholder="NAI_OFFICIAL_URL"
            spellcheck="false"
            :readonly="epDraftOfficial"
          />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API Key</span>
          <span class="ep-key-row">
            <input
              v-model="epDraft.key"
              class="bbi-input"
              :type="epKeyShown ? 'text' : 'password'"
              placeholder="nai-..."
              spellcheck="false"
              autocomplete="off"
            />
            <button
              class="bbi-icon-mini ep-key-eye"
              type="button"
              :title="epKeyShown ? '隐藏 Key' : '显示 Key'"
              :aria-label="epKeyShown ? '隐藏 Key' : '显示 Key'"
              :aria-pressed="epKeyShown"
              @click.prevent="epKeyShown = !epKeyShown"
            >
              <Icon :name="epKeyShown ? 'eye-off' : 'eye'" :size="14" />
            </button>
          </span>
        </label>
        <label class="ep-conc-row" title="并发高容易被限流(429),官方站建议 1">
          <span class="bbi-modal-label">同时出图数</span>
          <input
            v-model.number="epDraft.concurrency"
            class="bbi-input ep-conc"
            type="number"
            min="1"
            :max="NAI_CONCURRENCY_MAX"
          />
        </label>

        <footer class="bbi-modal-foot">
          <!-- 删除靠左、与「完成」拉开,降低误触;删不了时置灰并在 title 里说原因 -->
          <button
            class="bbi-btn bbi-btn-danger"
            type="button"
            :disabled="!!epRemoveBlock"
            :title="epRemoveBlock || '删除这个接入点'"
            @click="askRemoveEndpoint"
          >
            <Icon name="trash" :size="13" /> 删除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" :disabled="testingEndpoint" @click="onTestEndpoint">
            <Icon :name="testingEndpoint ? 'refresh' : 'plug'" :size="13" /> {{ testingEndpoint ? '连接中…' : '测试' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEndpoint">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 方案编辑弹窗:按「来源 / 画风 / Vibe / 画面 / 采样」分组,改动即时生效 ===== -->
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
              <span class="grp-label">接入点</span>
              <BbiSelect
                class="grp-ctl-w"
                v-model="planEndpointId"
                :options="endpointOptions"
                aria-label="方案使用的接入点"
              />
            </div>
            <div class="grp-row">
              <span class="grp-label">模型</span>
              <BbiSelect class="grp-ctl-w" v-model="planModel" :options="NAI_MODELS" aria-label="NAI 模型" />
            </div>
          </div>
          <p class="grp-foot">接入点的地址与 Key 在面板的「接入点」里管理。</p>
        </section>

        <section class="grp-sec">
          <div class="grp-cap">画风</div>
          <div class="grp">
            <div class="grp-row">
              <span class="grp-label">画师串</span>
              <span class="grp-ctl">
                <button
                  class="art-trigger grp-ctl-w"
                  type="button"
                  aria-haspopup="dialog"
                  :title="planArtist ? planArtist.prompt : '挑选画师串'"
                  @click="artistPickerOpen = true"
                >
                  <img
                    v-if="planArtist?.previewPath"
                    class="art-trigger-thumb"
                    :src="artistPreviewSrc(planArtist)"
                    alt=""
                    decoding="async"
                  />
                  <span class="art-trigger-name" :class="{ 'is-none': !planArtist }">
                    {{ planArtist ? planArtist.name || '未命名画师串' : '不使用' }}
                  </span>
                  <span v-if="planArtistBuiltin" class="art-trigger-tag">内置</span>
                  <Icon name="chevron" class="ep-chevron" :size="14" />
                </button>
              </span>
            </div>
            <div v-if="planArtist" class="grp-row is-stack">
              <span class="grp-note">
                <template v-if="planArtistBuiltin">内置画师串随插件更新,不可直接改;到画师串库里复制一条再改。</template>
                <template v-else-if="artistSharedWith.length">
                  拼在提示词最前面。{{ planNames(artistSharedWith) }}也在用这条,改动会一起生效。
                </template>
                <template v-else>拼在提示词最前面。</template>
              </span>
              <BbiTextarea
                v-model="planArtist.prompt"
                class="grp-textarea"
                :rows="2"
                :max-rows="8"
                mono
                :readonly="planArtistBuiltin"
                placeholder="artist:xxx, artist:yyy"
              />
            </div>
            <div class="grp-row is-stack">
              <span class="words-head">
                <span class="grp-label">正面质量词</span>
                <span class="bbi-prompt-state" :class="{ 'is-custom': isCustomWords('quality') }">
                  {{ isCustomWords('quality') ? '画师串' : '官方' }}
                </span>
                <template v-if="planArtist && !planArtistBuiltin">
                  <span class="list-foot-spacer"></span>
                  <button
                    v-if="isCustomWords('quality')"
                    class="quiet-btn"
                    type="button"
                    title="清空当前画师串的质量词,改回跟随模型官方词"
                    @click="resetWords('quality')"
                  >
                    <Icon name="refresh" :size="13" /> 恢复官方
                  </button>
                  <button v-else class="quiet-btn" type="button" @click="fillOfficialWords('quality')">
                    <Icon name="edit" :size="13" /> 在官方词上改
                  </button>
                </template>
              </span>
              <BbiTextarea
                v-if="planArtist"
                v-model="planArtist.quality"
                class="grp-textarea"
                :rows="2"
                :max-rows="8"
                mono
                :readonly="planArtistBuiltin"
                :placeholder="officialQuality"
              />
              <BbiTextarea
                v-else
                :model-value="officialQuality"
                class="grp-textarea"
                :rows="2"
                :max-rows="8"
                mono
                readonly
              />
            </div>
            <div v-if="planFixed" class="grp-row is-stack">
              <span class="words-head">
                <span class="grp-label">负面提示词</span>
                <span class="bbi-prompt-state">官方固定</span>
              </span>
              <BbiTextarea
                :model-value="officialNegative"
                class="grp-textarea"
                :rows="3"
                :max-rows="10"
                mono
                readonly
              />
            </div>
            <div v-else class="grp-row is-stack">
              <span class="words-head">
                <span class="grp-label">负面提示词</span>
                <span class="bbi-prompt-state" :class="{ 'is-custom': isCustomWords('negative') }">
                  {{ isCustomWords('negative') ? '画师串' : '官方' }}
                </span>
                <template v-if="planArtist && !planArtistBuiltin">
                  <span class="list-foot-spacer"></span>
                  <button
                    v-if="isCustomWords('negative')"
                    class="quiet-btn"
                    type="button"
                    title="清空当前画师串的负面词,改回跟随模型官方词"
                    @click="resetWords('negative')"
                  >
                    <Icon name="refresh" :size="13" /> 恢复官方
                  </button>
                  <button v-else class="quiet-btn" type="button" @click="fillOfficialWords('negative')">
                    <Icon name="edit" :size="13" /> 在官方词上改
                  </button>
                </template>
              </span>
              <BbiTextarea
                v-if="planArtist"
                v-model="planArtist.negative"
                class="grp-textarea"
                :rows="3"
                :max-rows="10"
                mono
                :readonly="planArtistBuiltin"
                :placeholder="officialNegative"
              />
              <BbiTextarea
                v-else
                :model-value="officialNegative"
                class="grp-textarea"
                :rows="3"
                :max-rows="10"
                mono
                readonly
              />
            </div>
          </div>
          <p class="grp-foot">
            顺序:画师串 → 画面 tag → 质量词。正/负面词随当前画师串切换,两栏分别留空时使用当前模型的官方词(灰字就是实际生效的内容)。
          </p>
          <p v-if="planArtist && !planArtistBuiltin" class="grp-foot">
            这里改的是画师串本身;在「画师串库」里也能编辑,共用这条的其它方案会一起生效。
          </p>
          <p v-if="planFixed" class="grp-foot">
            Medium 档的负面词由官方固定,不能自定义,上面显示的就是实际发出去的内容;画师串里自填过的负面词仍保留着,换回其它模型照常生效。
          </p>
          <p v-if="planArtist && isNai5(plan.model)" class="grp-foot is-warn">
            NAI 5 对画师串的响应与 4.5 差异很大,旧画师串直接套用效果可能跑偏,建议重新调试。
          </p>
        </section>

        <section class="grp-sec">
          <div class="grp-cap">
            Vibe
            <span class="grp-cap-tools">
              <span class="cap-count">已选 {{ planVibeCount }} 张</span>
            </span>
          </div>
          <div class="grp">
            <label class="grp-row is-clickable">
              <span class="grp-label">
                强度归一化
                <small class="grp-sub">多张 vibe 强度总和超过 1 时按比例压回 1</small>
              </span>
              <input v-model="plan.normalizeRefStrength" type="checkbox" class="bbi-checkbox" />
            </label>
            <div v-if="!settings.nai.vibes.length" class="grp-row">
              <span class="grp-note">Vibe 库是空的;在面板的「Vibe 库」里上传或导入。</span>
            </div>
            <template v-else>
              <div class="grp-row">
                <input
                  v-model="planVibeSearch"
                  class="bbi-input pv-search"
                  type="search"
                  placeholder="搜索名称或分组…"
                  spellcheck="false"
                  aria-label="搜索 Vibe"
                />
              </div>
              <div class="pv-list">
                <label v-for="v in planVibeList" :key="v.id" class="grp-row pv-row is-clickable">
                  <img
                    v-if="v.thumbnailPath"
                    class="pv-thumb"
                    :src="v.thumbnailPath"
                    :alt="v.name"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-else class="pv-thumb pv-thumb--empty"><Icon name="generate" :size="14" /></span>
                  <span class="pv-name">
                    {{ v.name }}
                    <small v-if="v.group" class="grp-sub">{{ v.group }} · 强度 {{ v.strength }}</small>
                    <small v-else class="grp-sub">强度 {{ v.strength }}</small>
                  </span>
                  <span
                    v-if="planVibesSupported && !v.modelKeys.includes(planVibeKey)"
                    class="vibe-missing"
                    title="缺这个模型的编码,出图时会跳过;在 Vibe 库里补编码"
                  >
                    缺编码
                  </span>
                  <input
                    type="checkbox"
                    class="bbi-checkbox"
                    :checked="plan.vibeIds.includes(v.id)"
                    @change="setPlanVibe(plan, v.id, ($event.target as HTMLInputElement).checked)"
                  />
                </label>
                <div v-if="!planVibeList.length" class="grp-row">
                  <span class="grp-note">没有匹配「{{ planVibeSearch }}」的 Vibe。</span>
                </div>
              </div>
            </template>
          </div>
          <p v-if="!planVibesSupported" class="grp-foot is-warn">
            {{ modelLabel(plan.model) }} 官方暂不支持 Vibe:出图时整批跳过,勾选照样保留——切回 4.5,或官方日后开放,就会生效。
          </p>
          <p v-else class="grp-foot">强度挂在 vibe 上、所有方案共用,在面板的「Vibe 库」里调。</p>
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
                list="nai-portrait-presets"
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
                list="nai-landscape-presets"
                placeholder="1216×832"
                spellcheck="false"
              />
            </label>
            <label class="grp-row is-clickable">
              <span class="grp-label">
                生成自然语言
                <small class="grp-sub">
                  开:AI 为画面与每个角色额外写一段英文描述;关:只写 tag。4.5 的提示词上限约 512 token,自然语言最占篇幅,画得怪可以关掉试试
                </small>
              </span>
              <input v-model="plan.naturalLanguage" type="checkbox" class="bbi-checkbox" />
            </label>
          </div>
          <p class="grp-foot">「自动」由 AI 按画面定横竖;锁定后这套方案每张都按该方向出,AI 也按此构图。</p>
          <datalist id="nai-portrait-presets">
            <option value="832×1216">竖版</option>
            <option value="1024×1536">大竖版</option>
            <option value="1024×1024">方图</option>
          </datalist>
          <datalist id="nai-landscape-presets">
            <option value="1216×832">横版</option>
            <option value="1536×1024">大横版</option>
            <option value="1024×1024">方图</option>
          </datalist>
        </section>

        <section class="grp-sec">
          <div class="grp-cap">采样</div>
          <div class="grp">
            <div class="grp-row">
              <span class="grp-label">采样器</span>
              <span v-if="planFixed" class="grp-note">官方固定 {{ planFixedSamplerLabel }}</span>
              <BbiSelect v-else class="grp-ctl-w" v-model="plan.sampler" :options="samplerOptions" aria-label="采样器" />
            </div>
            <div class="grp-row">
              <span class="grp-label">噪声表</span>
              <BbiSelect
                class="grp-ctl-w"
                v-model="plan.noiseSchedule"
                :options="NAI_NOISE_SCHEDULES"
                aria-label="噪声表"
              />
            </div>
            <div v-if="planFixed" class="grp-row">
              <span class="grp-label">步数</span>
              <span class="grp-note">官方固定 {{ planFixed.steps }}</span>
            </div>
            <label v-else class="grp-row">
              <span class="grp-label">步数</span>
              <input class="bbi-input grp-short" type="number" v-model.number="plan.steps" min="1" max="50" />
            </label>
            <label class="grp-row">
              <span class="grp-label">
                Scale
                <small class="grp-sub">提示词相关性</small>
              </span>
              <input
                class="bbi-input grp-short"
                type="number"
                v-model.number="plan.scale"
                min="0"
                max="35"
                step="0.1"
              />
            </label>
            <label v-if="!planFixed" class="grp-row">
              <span class="grp-label">
                Rescale
                <small class="grp-sub">相关性调整</small>
              </span>
              <input
                class="bbi-input grp-short"
                type="number"
                v-model.number="plan.cfgRescale"
                min="0"
                max="1"
                step="0.05"
              />
            </label>
            <label class="grp-row">
              <span class="grp-label">
                种子
                <small class="grp-sub">0 = 每次随机</small>
              </span>
              <input class="bbi-input grp-short" type="number" v-model.number="plan.seed" min="0" />
            </label>
            <label class="grp-row is-clickable">
              <span class="grp-label">
                Variety Boost
                <small class="grp-sub">画面多样性,按尺寸自动计算</small>
              </span>
              <input v-model="plan.varietyBoost" type="checkbox" class="bbi-checkbox" />
            </label>
          </div>
          <p v-if="planFixed" class="grp-foot">
            Medium 档是官方的省点数版本:采样器、步数固定,不支持 Rescale。想自己调,换回 NAI 5 Full。
          </p>
        </section>

        <footer class="bbi-modal-foot">
          <span v-if="plan.id === active.id" class="plan-current"><Icon name="check" :size="13" /> 当前方案</span>
          <button v-else class="bbi-btn" type="button" @click="switchTo(plan)">设为当前方案</button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closePlan">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 只从方案弹窗里唤起,叠在它上面 -->
    <NaiArtistPicker v-model:open="artistPickerOpen" :plan-id="plan.id" />

    <ModalMask :open="migrateConfirmOpen" @close="migrateConfirmOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="从智绘姬迁移">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">从智绘姬迁移 vibe</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="migrateConfirmOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          将把智绘姬的 {{ chatu8Detect.total }} 个 vibe 复制到柏宝绘 Vibe
          库，只是创建副本，不会改动智绘姬的数据。内容相同的会自动跳过，重复迁移不会产生重复条目。
          迁移来的 vibe 不会自动叠加到任何方案，需要时在方案里勾选。
        </p>
        <p class="bbi-modal-label">
          注意：智绘姬未开「酒馆储存」时 vibe 存在浏览器本地存储里，只有本设备本浏览器读得到。
        </p>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="migrateConfirmOpen = false">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="runMigrate">开始迁移</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 从智绘姬导入提示词预设:预览 + 确认(打开时算一次结果,纯函数不落盘) ===== -->
    <ModalMask :open="artistImportOpen" @close="artistImportOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="从智绘姬导入提示词预设">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">从智绘姬导入提示词预设</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="artistImportOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          把智绘姬的全部 {{ artistImportResult?.plans.length ?? 0 }} 个提示词预设复制到柏宝绘的画师串库，只建副本、不改动智绘姬的数据。
          映射：前置固定正向 → 画师串，后置固定正向 / 固定负向 → 画师串的自带正 / 负面词（负向前面自动拼上当前模型的官方基线）。
          选中导入的画师串后，它的正/负面词会一起生效；留空的字段使用当前模型官方词。
          同名条目会覆盖更新（之前导入过的可直接重新导入修复），内容完全相同的自动跳过。
        </p>
        <ul class="art-import-list">
          <li v-for="(item, i) in artistImportResult?.plans ?? []" :key="i" class="art-import-item">
            <div class="art-import-head">
              <span class="art-import-name" :title="item.source">{{ item.source || '(未命名)' }}</span>
              <span class="art-import-badge" :class="`is-${item.state}`">
                {{ item.state === 'import' ? '将导入' : item.state === 'overwrite' ? '将覆盖' : '已存在' }}
              </span>
              <span v-if="item.active" class="art-import-badge is-active">当前使用中</span>
            </div>
            <div class="art-import-fields">
              <code class="art-import-line" :title="item.prompt"
                ><span class="art-import-key">画师串</span>{{ item.prompt || '(空)' }}</code
              >
              <code class="art-import-line" :title="item.quality"
                ><span class="art-import-key">正向</span>{{ item.quality || '(空)' }}</code
              >
              <code class="art-import-line" :title="item.negative"
                ><span class="art-import-key">负向</span>{{ item.negative || '(空)' }}</code
              >
            </div>
          </li>
        </ul>
        <label v-if="chatu8ActiveRef" class="art-import-switch">
          <input type="checkbox" v-model="switchActiveArtist" />
          <span>
            导入后让当前方案「{{ active.name || '未命名方案' }}」改用智绘姬当前使用的预设
            <code>{{ chatu8ActiveRef.source }}</code>
            （连同它的正 / 负面词）
          </span>
        </label>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="artistImportOpen = false">取消</button>
          <button
            class="bbi-btn bbi-btn-primary"
            type="button"
            :disabled="!artistImportResult || artistImportResult.imported + artistImportResult.overwritten === 0"
            @click="runArtistImport"
          >
            {{ artistImportResult && artistImportResult.imported + artistImportResult.overwritten === 0 ? '全部相同' : '开始导入' }}
          </button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* ==========================================================================
   分组列表:与 ComfyUIPanel 同一套排布语言(小标题 grp-cap + 白卡 grp + 卡内行 grp-row / grp-item)。
   scoped 不跨组件,故整套规则在这里补一份——两个面板读起来要是一个产品。
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
.cap-count {
  font-weight: 400;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
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
.grp-ctl {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
}
.grp .grp-ctl-w {
  width: var(--ctl-w);
  flex: 0 1 auto;
  min-width: 0;
}

/* —— 方案弹窗:画师串入口。外观对齐 BbiSelect 的触发器,有预览图时左侧多一枚 3:4 小图 —— */
.art-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 4px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.art-trigger:hover {
  background: var(--bbi-surface-2);
}
.art-trigger:hover .ep-chevron {
  color: var(--bbi-accent);
}
.art-trigger:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 1px;
}
.art-trigger-thumb {
  flex: none;
  width: 24px;
  height: 32px;
  margin-left: -6px;
  border-radius: 3px;
  object-fit: cover;
  background: var(--bbi-surface-2);
}
.art-trigger-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.art-trigger-name.is-none {
  color: var(--bbi-ink-muted);
}
.art-trigger-tag {
  flex: none;
  font-size: 11px;
  color: var(--bbi-ink-muted);
}
.grp :deep(.bbi-input) {
  padding-top: 6px;
  padding-bottom: 6px;
  line-height: 1.5;
}
.grp-short {
  width: 124px;
  flex: none;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.grp .grp-textarea {
  border-color: transparent;
  background: var(--bbi-surface-2);
}
.grp .grp-textarea:focus {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
/* 质量词 / 负面词的行头:标签 + 状态药丸 + 右侧一个动作 */
.words-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

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

/* —— 列表行:主体可点(选中),操作钮挂在行尾 —— */
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
.item-ops {
  display: flex;
  gap: 2px;
  flex: none;
}

/* 方案行:只有圆点 + 名字;圆点 = 当前出图用的那套 */
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

/* 接入点行:只有名字,整行可点进弹窗;行尾小箭头提示「点开编辑」 */
.ep-item {
  padding-right: 0;
}
.ep-item .item-main {
  min-height: 44px;
  padding-right: 14px;
}
.ep-chevron {
  flex: none;
  margin-left: auto;
  color: var(--bbi-ink-muted);
  transform: rotate(-90deg);
  transition: color var(--bbi-dur) var(--bbi-ease);
}
.ep-item .item-main:hover .ep-chevron {
  color: var(--bbi-accent);
}

/* —— 接入点弹窗 —— */
.ep-modal {
  max-width: 440px;
}
.ep-modal .bbi-input[readonly] {
  color: var(--bbi-ink-soft);
}
.ep-key-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.ep-key-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
/* 拉伸到与输入框等高;选择器要压过文件末尾借来的 .bbi-icon-mini 基础规则(26px) */
.ep-key-row .ep-key-eye {
  width: 34px;
  height: auto;
}
.ep-conc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ep-conc-row .bbi-modal-label {
  font-size: 13px;
  color: var(--bbi-ink);
}
.ep-conc {
  width: 88px;
}


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

/* 方案弹窗里的 vibe 勾选清单:库可能上百张,框定高度自己滚,不把下面的「画面 / 采样」推出视野 */
.pv-search {
  flex: 1 1 auto;
  min-width: 0;
}
.pv-list {
  max-height: 260px;
  overflow-y: auto;
  border-top: 1px solid var(--bbi-line);
}
.pv-row {
  justify-content: flex-start;
  gap: 10px;
  min-height: 0;
  padding: 6px 12px 6px 14px;
}
.pv-thumb {
  flex: none;
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: 5px;
}
.pv-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-muted);
}
.pv-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.pv-name .grp-sub {
  margin-top: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vibe-hint {
  margin-top: 0;
}
.art-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 12px 0;
}

/* —— 从智绘姬迁移提示词预设 —— */
.art-import-list {
  list-style: none;
  margin: 10px 0 4px;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.art-import-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.art-import-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.art-import-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.art-import-fields {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.art-import-line {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
}
.art-import-key {
  opacity: 0.55;
  margin-right: 6px;
}
.art-import-badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
  white-space: nowrap;
}
.art-import-badge.is-skip {
  background: var(--bbi-line);
  color: var(--bbi-ink-muted);
}
.art-import-badge.is-overwrite {
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
}
.art-import-badge.is-active {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
.art-import-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 13px;
  cursor: pointer;
}
.art-import-switch code {
  font-size: 12px;
  background: var(--bbi-surface-2);
  border-radius: 4px;
  padding: 0 4px;
}

.migrate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* —— Vibe 库 —— */
.vibe-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.vibe-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--bbi-border, rgba(127, 127, 127, 0.2));
}
.vibe-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex: 0 0 auto;
}
.vibe-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(127, 127, 127, 0.12);
  color: var(--bbi-ink-muted);
}
.vibe-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vibe-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.vibe-enable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-strength-label {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength input[type='range'] {
  flex: 1 1 auto;
  min-width: 0;
  /* .bbi-range 的 margin 是给「整行占一栏」的设置页留的,这里在同一行里要压掉 */
  margin: 0;
}
/* 数字框窄一档:四位小数够用,再宽就把滑块挤没了 */
.vibe-strength-num {
  flex: 0 0 auto;
  width: 68px;
  padding: 4px 6px;
  font-size: 12px;
  text-align: right;
  -moz-appearance: textfield;
  appearance: textfield;
}
/* step="any" 下浏览器仍画上下箭头,但规范让 stepUp/stepDown 直接抛错 → 按了没反应。
   摆一对点不动的箭头不如不摆;要微调用左边滑块(方向键 0.01 一档)。 */
.vibe-strength-num::-webkit-inner-spin-button,
.vibe-strength-num::-webkit-outer-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.vibe-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vibe-missing {
  flex: none;
  font-size: 12px;
  color: #c44747;
}

/* —— 分组 —— */
/* 长列表口径与设置页排除弹窗一致(搜索 + 子串匹配收敛渲染量),故不做分页 */
.vibe-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.vibe-search {
  flex: 1 1 160px;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
}
.vibe-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-group {
  margin-top: 10px;
}
.vibe-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.vibe-group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.vibe-group-chevron {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.vibe-group-chevron.is-collapsed {
  transform: rotate(-90deg);
}
.vibe-group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vibe-group-meta {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
}
.vibe-group-active {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.vibe-group-ops {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
.vibe-group-body {
  padding-left: 10px;
}
.vibe-group-body > .vibe-item:first-child {
  border-top: 0;
}
.vibe-group-select {
  width: 130px;
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
}
.bbi-btn-danger:disabled {
  color: var(--bbi-ink-muted);
  cursor: not-allowed;
  opacity: 0.6;
}

@media (max-width: 640px) {
  .grp {
    --ctl-w: 210px;
  }
  .vibe-group-ops {
    width: 100%;
    justify-content: flex-end;
  }
  .vibe-group-body {
    padding-left: 0;
  }
}
</style>
