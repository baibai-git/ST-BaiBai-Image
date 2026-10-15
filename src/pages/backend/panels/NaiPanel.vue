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
  BUILTIN_NAI_ARTISTS,
  encodeVibeImage,
  isBuiltinNaiArtist,
  isNai5,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiSamplers,
  naiSupportsVibes,
  NAI_NOISE_SCHEDULES,
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
import NaiArtistManager from '@/pages/backend/panels/NaiArtistManager.vue';
import NaiFullPresetPanel from '@/pages/backend/panels/NaiFullPresetPanel.vue';
import { refreshNaiFullVibeReferences } from '@/state/naiFullPresets';
import { acquireNaiSlot } from '@/floor/genQueue';
import { makeJpegThumbnail } from '@/st/imageFile';
import { deleteUserImage } from '@/st/images';
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
  activeNaiArtist,
  activeNaiEndpoint,
  effectiveNai,
  isOfficialNaiEndpoint,
  newNaiArtist,
  newNaiEndpoint,
  NAI_MODELS,
  NAI_OFFICIAL_URL,
  ORIENTATION_LOCKS,
  settings,
  type NaiArtistPreset,
  type NaiEndpoint,
  type NaiVibe,
} from '@/state/settings';
import { computed, nextTick, onMounted, ref } from 'vue';

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'nai');

const testing = ref(false);
const showKey = ref(false);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    // 测当前选中那条接入点(而非渠道级存量 url/key),与出图同一份连接
    const result = await testNaiConnection(effectiveNai());
    toastr.success(result.message, `NAI 连接 · ${endpoint.value.name}`);
  } catch (error) {
    toastr.error(errorMessage(error), `NAI 连接失败 · ${endpoint.value.name}`);
  } finally {
    testing.value = false;
  }
}

/* ============ 接入点库(地址 + 密钥;形制照搬下方画师串行) ============ */

/**
 * 多条接入点解决的是「公益站换着用」:同一套出图参数,换个出口。
 * 故这里只管 url/key,模型/采样器/尺寸一概留在渠道级,切站不用重配。
 */
const endpoint = computed<NaiEndpoint>(() => activeNaiEndpoint());

/** 官方那条只读:名字/地址不给改、不给删,复制出来的副本才随便改。 */
const isOfficialEndpoint = computed(() => isOfficialNaiEndpoint(endpoint.value.id));

const endpointOptions = computed(() =>
  settings.nai.endpoints.map(e => ({ value: e.id, label: e.name || '未命名接入点' })),
);

/** 下拉取「实际生效的那条」而非存的 id:悬空时 activeNaiEndpoint 回落首条,下拉要跟着显示。 */
const activeEndpointId = computed<string>({
  get: () => endpoint.value.id,
  set: id => {
    settings.nai.activeEndpointId = id;
  },
});

/** 改名低频:平时只显示下拉,点「改名」才把选择器原地换成输入框(同画师串行)。 */
const renamingEndpoint = ref(false);
const endpointNameDraft = ref('');
const endpointNameInput = ref<HTMLInputElement | null>(null);
const endpointDeleteOpen = ref(false);

function startRenameEndpoint() {
  if (isOfficialEndpoint.value) return; // 官方条只读(按钮已禁用,双保险)
  endpointNameDraft.value = endpoint.value.name;
  renamingEndpoint.value = true;
  nextTick(() => endpointNameInput.value?.focus());
}

/** Enter / 失焦都算确认;Esc 直接置 false 不经过这里,即为取消。 */
function commitRenameEndpoint() {
  if (renamingEndpoint.value && !isOfficialEndpoint.value) {
    endpoint.value.name = endpointNameDraft.value.trim() || endpoint.value.name;
  }
  renamingEndpoint.value = false;
}

function addEndpoint() {
  const preset = newNaiEndpoint(`接入点 ${settings.nai.endpoints.length + 1}`);
  settings.nai.endpoints.push(preset);
  settings.nai.activeEndpointId = preset.id;
}

function duplicateEndpoint() {
  // 官方条也走这里:复制出来的是普通条目,地址可改 —— 这是「照着官方改个镜像」的捷径
  const src = endpoint.value;
  const preset: NaiEndpoint = { ...newNaiEndpoint(), name: `${src.name} 副本`, url: src.url, key: src.key };
  settings.nai.endpoints.push(preset);
  settings.nai.activeEndpointId = preset.id;
}

function confirmRemoveEndpoint() {
  endpointDeleteOpen.value = false;
  if (isOfficialEndpoint.value) return; // 官方条不可删:endpoints 恒非空靠它保底
  const list = settings.nai.endpoints;
  const index = list.findIndex(e => e.id === endpoint.value.id);
  if (index < 0) return;
  list.splice(index, 1);
  // 接位到原位置那一条(已是最后一条则退一格)。**不**像画师串那样回落空串:
  // 地址是必需品,空了就出不了图 —— 与工作流库同口径。
  settings.nai.activeEndpointId = list[Math.min(index, list.length - 1)].id;
}

/* ============ 画师串库(形制照搬 ComfyUI 工作流库) ============ */

/**
 * 当前选中的画师串;null = 不使用(库为空、用户主动选了「不使用」、或 id 悬空)。
 * settings 是 reactive,直接把它的字段绑 v-model 即可就地编辑。
 */
const artist = computed<NaiArtistPreset | null>(() => activeNaiArtist());

/** 当前是否 V5 模型:控制画师串编辑区的 V5 差异提醒。 */
const isV5Model = computed(() => isNai5(settings.nai.model));

/** 「不使用」的下拉值。preset id 恒为 art_* / bi_* 形状,空串不会与任何一条相撞,无需装箱。 */
const NO_ARTIST = '';

const artistOptions = computed(() => [
  { value: NO_ARTIST, label: '不使用' },
  // 内置配方排用户库前面:新用户默认选中的是内置条,放在「不使用」旁边最顺;
  // 名称后括注内置,与用户自建的同名条目区分开
  ...BUILTIN_NAI_ARTISTS.map(a => ({ value: a.id, label: `${a.name}(内置)` })),
  ...settings.nai.artistPresets.map(a => ({ value: a.id, label: a.name || '未命名画师串' })),
]);

/**
 * 下拉的值取「实际生效的那一条」而非存的 id:存的 id 悬空时 activeNaiArtist 返回 null,
 * 下拉也该跟着显示「不使用」,不能显示空白。
 */
const activeArtistId = computed<string>({
  get: () => artist.value?.id ?? NO_ARTIST,
  set: id => {
    settings.nai.activeArtistId = id;
  },
});

/** 改名/复制/删除都只对「真的选中了一条」有意义;选「不使用」时一律禁用。 */
const hasArtist = computed(() => artist.value !== null);

/** 当前选中的是内置配方:只读(改名/删除/内容编辑禁用),「复制」是自定义的唯一入口。 */
const isBuiltinArtist = computed(() =>
  artist.value ? isBuiltinNaiArtist(artist.value.id) : false,
);

/** 改名是低频操作:平时只显示下拉,点「改名」才把选择器原地换成输入框。 */
const renamingArtist = ref(false);
const artistNameDraft = ref('');
const artistNameInput = ref<HTMLInputElement | null>(null);
const artistDeleteOpen = ref(false);
/** 管理器弹窗:搜索/预览图/勾选批量删除都在那边,下拉这里只留高频切换。 */
const artistManagerOpen = ref(false);

function startRenameArtist() {
  if (!artist.value || isBuiltinArtist.value) return; // 内置只读(按钮已禁用,双保险)
  artistNameDraft.value = artist.value.name;
  renamingArtist.value = true;
  nextTick(() => artistNameInput.value?.focus());
}

/** Enter / 失焦都算确认;Esc 直接置 renamingArtist=false 不经过这里,即为取消。 */
function commitRenameArtist() {
  if (renamingArtist.value && artist.value) artist.value.name = artistNameDraft.value.trim();
  renamingArtist.value = false;
}

function addArtist() {
  const preset = newNaiArtist(`画师串 ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
}

function duplicateArtist() {
  const src = artist.value;
  if (!src) return;
  // 只换 id 与名字;id 生成仍由 settings 统一口径。
  // 内置配方也走这里:复制出来的副本是普通用户条目,随便改——这是内置条唯一的自定义路径。
  // 显式逐字段拷贝,不带 previewPath:预览文件随原条目删除,共指一个路径会让副本日后破图。
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} 副本`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
  };
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
}

async function confirmRemoveArtist() {
  artistDeleteOpen.value = false;
  const list = settings.nai.artistPresets;
  const index = list.findIndex(a => a.id === artist.value?.id);
  if (index < 0) return;
  // 预览图文件 best-effort 连带清理(与管理器删除同口径:文件删不掉不阻塞删条目)
  const previewPath = list[index].previewPath;
  if (previewPath) {
    try {
      await deleteUserImage(previewPath);
    } catch (error) {
      toastr.warning(`条目已删除,但预览图文件清理失败：${errorMessage(error)}`, '画师串');
    }
  }
  list.splice(index, 1);
  // 接位到原位置那一条(已是最后一条则退一格);删空了就回「不使用」——
  // `?? ''` 正是画师串库与工作流库的分水岭(那边恒非空、回落 [0]),不能省。
  settings.nai.activeArtistId = list[Math.min(index, list.length - 1)]?.id ?? '';
}

/* ============ 从智绘姬迁移提示词预设 ============ */

/**
 * 智绘姬(st-chatu8)的提示词预设整批搬过来,映射与智绘姬拼装位置一致:
 * 前置固定正向 → 画师串,后置固定正向 → 正面质量词,固定负向 → 负面提示词(前面拼上当前模型官方基线)。
 * 与 vibe 迁移同原则:只建副本、不改源数据;同名条目重新导入会覆盖更新
 * (旧版迁移把正向整体塞进画师串的条目,重导即被修好),内容完全相同的跳过,随时可再来。
 * 纯逻辑在 chatu8Vibe.ts(collect/detect/import 三件套),这里只做检测展示、弹窗预览与落盘。
 *
 * 刻意不做「还剩 N 个可导入」的常驻提示:去重键是名字+内容,用户改过或删过
 * 本地副本后键就对不上,提示会反复复活,很吵。入口收进下方「从智绘姬迁移」
 * 折叠区,手动点开弹窗时才算预览,有没有新预设一看便知。
 */
const chatu8ArtistDetect = ref<Chatu8ArtistDetectInfo>({ found: false, total: 0 });
/** 弹窗打开时算一次的预览结果(纯函数,不落盘);plans 逐条带徽标状态。 */
const artistImportResult = ref<Chatu8ArtistImportResult | null>(null);
const artistImportOpen = ref(false);
/** 导入后是否把智绘姬当前使用的预设设为柏宝绘当前画师串。 */
const switchActiveArtist = ref(true);

const chatu8ActiveRef = computed(() => artistImportResult.value?.plans.find(p => p.active) ?? null);

function openArtistImport() {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  artistImportResult.value = importArtistsFromChatu8(settings.nai.artistPresets, chatu8, settings.nai.model);
  switchActiveArtist.value = true;
  artistImportOpen.value = true;
}

/** 纯同步:结果在打开弹窗时就算好了,确认只是 push/覆盖 + 可选切换。 */
function runArtistImport() {
  const result = artistImportResult.value;
  artistImportOpen.value = false;
  if (!result || (result.imported === 0 && result.overwritten === 0)) return;
  for (const plan of result.plans) {
    if (plan.state === 'import') {
      settings.nai.artistPresets.push(plan.preset!);
    } else if (plan.state === 'overwrite') {
      const target = settings.nai.artistPresets.find(p => p.id === plan.targetId);
      if (target && plan.preset) {
        target.prompt = plan.preset.prompt;
        target.quality = plan.preset.quality;
        target.negative = plan.preset.negative;
      }
    }
  }
  if (switchActiveArtist.value && result.activeArtistId) {
    settings.nai.activeArtistId = result.activeArtistId;
  }
  const parts = [`新增 ${result.imported} 个`];
  if (result.overwritten) parts.push(`覆盖更新 ${result.overwritten} 个`);
  if (result.duplicates) parts.push(`相同跳过 ${result.duplicates}`);
  if (switchActiveArtist.value && result.activeArtistId) {
    parts.push('已切换为智绘姬当前使用的预设');
  }
  toastr.success(parts.join(', '), '从智绘姬导入');
  artistImportResult.value = null;
}

/* ============ 提示词:正/负面词分两级——画师串绑定值 → 渠道覆盖值 → 内置默认 ============ */

/**
 * 一条正/负面词的编辑目标;渠道级与画师串绑定级共用同一个弹窗。
 *
 * fallback = 留空时跟随的下一级取值(渠道级 → 模型官方词;绑定级 → 渠道值 → 官方词)。
 * 打开弹窗预填它——框里空着就是把「看不到实际生效了什么」的老问题原地搬家;
 * 保存时与回落一致就存空串(与设置页 saveTagPrompt 同口径:不把下一级的值冗余存进来,
 * 保留「跟随」语义,下一级变了能跟着变)。
 *
 * fallback 必须是函数而非常量:它随 settings.nai.model / 渠道覆盖值变,要在读取时才求值。
 */
interface NaiPromptTarget {
  key: 'quality' | 'negative';
  label: string;
  hint: string;
  /** 内置配方的绑定位只读:弹窗纯查看,不给保存(写进模块常量就糟了)。 */
  readonly?: boolean;
  fallback: () => string;
  read: () => string;
  write: (v: string) => void;
}

/** 渠道级两条:画师串未绑定对应字段时生效,再留空则按模型取官方词。 */
const CHANNEL_PROMPT_TARGETS: NaiPromptTarget[] = [
  {
    key: 'quality',
    label: '正面质量词',
    hint: '拼在画面 tag 之后(整体顺序:画师串 → 画面 tag → 质量词)。画师串里设置了质量词时,会用画师串那份,这里的不生效。',
    fallback: () => naiDefaultQualityTags(settings.nai.model),
    read: () => settings.nai.qualityTags,
    write: v => (settings.nai.qualityTags = v),
  },
  {
    key: 'negative',
    label: '负面提示词',
    hint: '留空 = 按模型取官方负面词;要额外排除什么,直接往这一份里接。画师串里设置了负面词时,会用画师串那份,这里的不生效。',
    fallback: () => naiDefaultUndesired(settings.nai.model),
    read: () => settings.nai.undesiredContent,
    write: v => (settings.nai.undesiredContent = v),
  },
];

/**
 * 当前画师串的两个绑定位;read/write 直接落在选中条目上(settings 是 reactive,就地编辑)。
 * 只在真的选中了一条时存在(选「不使用」时没有绑定对象,列表整个不渲染)。
 */
const artistBoundTargets = computed<NaiPromptTarget[]>(() => {
  const a = artist.value;
  if (!a) return [];
  const readonly = isBuiltinArtist.value;
  return [
    {
      key: 'quality',
      label: '正面质量词',
      readonly,
      hint: readonly
        ? '内置画师串的绑定位随插件版本更新,不可改;复制为我的画师串后可自定义。留空 = 用渠道级设置(渠道级也留空,则按模型取官方词)。'
        : '这份质量词随当前画师串一起切换。留空 = 用渠道级设置(渠道级也留空,则按模型取官方词)。',
      fallback: () => settings.nai.qualityTags.trim() || naiDefaultQualityTags(settings.nai.model),
      read: () => a.quality,
      write: v => (a.quality = v),
    },
    {
      key: 'negative',
      label: '负面提示词',
      readonly,
      hint: readonly
        ? '内置画师串的绑定位随插件版本更新,不可改;复制为我的画师串后可自定义。留空 = 用渠道级设置(渠道级也留空,则按模型取官方负面词)。'
        : '这份负面词随当前画师串一起切换。留空 = 用渠道级设置(渠道级也留空,则按模型取官方负面词)。',
      fallback: () =>
        settings.nai.undesiredContent.trim() || naiDefaultUndesired(settings.nai.model),
      read: () => a.negative,
      write: v => (a.negative = v),
    },
  ];
});

/** 该条是否已有自定义值(非空即视为覆盖下一级)。 */
function isTargetCustom(target: NaiPromptTarget): boolean {
  return target.read().trim().length > 0;
}

/** 当前画师串是否绑定了该字段——绑定时渠道值被覆盖,渠道列表的徽标要说出这件事。 */
function isShadowedByArtist(key: NaiPromptTarget['key']): boolean {
  const a = artist.value;
  if (!a) return false;
  return key === 'quality' ? !!a.quality.trim() : !!a.negative.trim();
}

// 正在编辑的那条;draft 是草稿,点「完成」才写回 settings(取消则丢弃)。
const editingNaiPrompt = ref<NaiPromptTarget | null>(null);
const naiPromptDraft = ref('');

function openNaiPrompt(target: NaiPromptTarget) {
  editingNaiPrompt.value = target;
  // 已自定义→载入用户内容;未自定义→预填下一级回落值,方便直接在其上改
  naiPromptDraft.value = target.read().trim() || target.fallback();
}
function closeNaiPrompt() {
  editingNaiPrompt.value = null;
  naiPromptDraft.value = '';
}
function saveNaiPrompt() {
  const target = editingNaiPrompt.value;
  if (!target || target.readonly) return; // 内置配方的绑定位只读(按钮已隐藏,双保险)
  const v = naiPromptDraft.value.trim();
  target.write(v === target.fallback().trim() ? '' : naiPromptDraft.value);
  closeNaiPrompt();
}
/** 「恢复默认」:把草稿重置回落值(保存后即变回「跟随下一级」) */
function resetNaiPromptDraft() {
  const target = editingNaiPrompt.value;
  if (target) naiPromptDraft.value = target.fallback();
}

/* ============ Vibe 库 ============ */

const vibeEncoding = ref(false);
const vibeFileInput = ref<HTMLInputElement | null>(null);
const vibeImportInput = ref<HTMLInputElement | null>(null);

let vibeSeq = 0;

/** 当前模型的 vibe 编码 key;vibe 缺此 key 时生成会被跳过,列表里给「补编码」入口。 */
const currentVibeKey = computed(() => vibeModelKey(settings.nai.model));
const vibesSupported = computed(() => naiSupportsVibes(settings.nai.model));
const samplerOptions = computed(() => naiSamplers(settings.nai.model));

/** BbiSelect 的 modelValue 是 string,而 nai.model 是字面量联合;这层 get/set 只为搭桥。
 *  写入前对一遍 NAI_MODELS:下拉本就只发合法值,但少了这句类型断言就是空口无凭。 */
const modelSel = computed<string>({
  get: () => settings.nai.model,
  set: v => {
    const hit = NAI_MODELS.find(m => m.value === v);
    if (hit) settings.nai.model = hit.value;
  },
});

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
 * 编码是一次真实的 NAI 请求,所以与楼层卡片共用同一个闸门(floor/genQueue.ts):
 * 否则「一边出图一边编码」在账号上就是两条并发,且完全绕过 429 冷却。
 * 代价是出图在跑时点编码会先等出图完 —— 这是对的,按钮那边有 vibeEncoding 转圈提示。
 */
async function encodeVibeGated(imageBase64: string): Promise<string> {
  const release = await acquireNaiSlot();
  try {
    return await encodeVibeImage(effectiveNai(), imageBase64, settings.nai.model);
  } finally {
    release();
  }
}

/** 上传参考图 → 调 /ai/encode-vibe 编码(按当前模型)→ 入库。 */
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
    const encoding = await encodeVibeGated(imageBase64);
    const thumbnail = await makeThumbnail(dataUrl);
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = {
      image: imageBase64,
      thumbnail,
      encodings: { [currentVibeKey.value]: { encoding, infoExtracted: 1 } },
    };
    const paths = await saveVibeFiles(data, null, id);
    settings.nai.vibes.push(
      vibeMetaFromData(
        id,
        file.name.replace(/\.[^.]+$/, '') || `Vibe ${settings.nai.vibes.length + 1}`,
        paths.dataPath,
        paths.thumbnailPath,
        data,
        0.6,
        true,
      ),
    );
    toastr.success(`已按 ${settings.nai.model} 编码并加入 Vibe 库`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 编码失败');
  } finally {
    vibeEncoding.value = false;
  }
}

/**  vibe 缺当前模型编码时单独补(切换模型后常见)。 */
async function reencodeVibe(vibe: NaiVibe) {
  if (!vibe.hasImage || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const data = await loadVibeData(vibe);
    if (!data.image) throw new Error('该 Vibe 没有参考原图');
    const encoding = await encodeVibeGated(data.image);
    data.encodings[currentVibeKey.value] = { encoding, infoExtracted: 1 };
    const paths = await saveVibeFiles(data, vibe, vibe.id);
    vibe.dataPath = paths.dataPath;
    vibe.thumbnailPath = paths.thumbnailPath;
    vibe.modelKeys = Object.keys(data.encodings);
    const oldFingerprint = vibe.fingerprint;
    vibe.fingerprint = vibeFingerprint(data.encodings);
    refreshNaiFullVibeReferences(settings.nai.fullPresets, vibe.id, oldFingerprint, vibe.fingerprint);
    toastr.success(`「${vibe.name}」已补 ${settings.nai.model} 编码`, 'Vibe');
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
  return isGroupActive(group, settings.nai.vibes);
}

/** 只开这组:清掉组外的勾选并开启本组。解决「换一套搭配」要逐条点的痛点。 */
function soloGroup(group: VibeGroup) {
  const ids = new Set(group.all.map(v => v.id));
  for (const vibe of settings.nai.vibes) vibe.enabled = ids.has(vibe.id);
}

/** 全开/全关只动本组,组外不碰——想叠加两组就各点一次「全开」。 */
function setGroupEnabled(group: VibeGroup, enabled: boolean) {
  for (const vibe of group.all) vibe.enabled = enabled;
}

const enabledCount = computed(() => settings.nai.vibes.filter(v => v.enabled).length);

function groupEnabledCount(group: VibeGroup): number {
  return group.all.filter(v => v.enabled).length;
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

/** 解散分组:只清 group 字段,vibe 本体与启用状态都不动(不是删除)。 */
function dissolveGroup(group: VibeGroup) {
  if (!group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = '';
  }
}

/**
 * 旧版从智绘姬迁移时把组名拼进了显示名(「组名 · 原名」),分组结构因此丢失。
 * 这里按前缀还原:只动未分组的条目,不覆盖用户已手工分好的组。
 * 按钮仅在真有可整理的条目时出现——没得整理时摆一颗点不出反应的按钮不如不摆。
 */
const prefixGroupPlans = computed(() => planPrefixGroups(settings.nai.vibes));

function applyPrefixGroups() {
  const plans = prefixGroupPlans.value;
  if (!plans.length) return;
  const byId = new Map(settings.nai.vibes.map(v => [v.id, v]));
  for (const plan of plans) {
    const vibe = byId.get(plan.id);
    if (!vibe) continue;
    vibe.group = plan.group;
    vibe.name = plan.name;
  }
  const groups = new Set(plans.map(p => p.group)).size;
  toastr.success(`已把 ${plans.length} 个 Vibe 整理进 ${groups} 个分组`, 'Vibe');
}

/* ============ 从智绘姬迁移 ============ */

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
    settings.nai.vibes.push(...result.vibes);
    const parts = [`新增 ${result.imported} 个`];
    if (result.duplicates) parts.push(`重复跳过 ${result.duplicates}`);
    if (result.failed) parts.push(`失败 ${result.failed}`);
    migrateMsg.value = `迁移完成：${parts.join(' / ')}。`;
    if (result.imported) migrateMsg.value += '新迁移的 Vibe 默认未启用，请按需开启。';
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
    settings.nai.vibes.push(
      vibeMetaFromData(id, parsed.name, paths.dataPath, paths.thumbnailPath, data, parsed.strength, true),
    );
    toastr.success(`已导入「${parsed.name}」`, 'Vibe');
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
 * 滑块步进 0.01 只是「拖着好用」的粒度,数字框 step="any" 才是真正的自由填值——
 * 想要 0.375 就填 0.375,不再被步进吸附到 5 的倍数上。
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
  if (deleteError) toastr.warning(`索引已删除，但文件清理失败：${errorMessage(deleteError)}`, 'Vibe');
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      NovelAI 生图接口。地址默认为官方,填第三方兼容站(镜像/转发)即走第三方,协议一致。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <!-- 接入点库:公益站换着用的人不止一个出口,但换站只换地址+密钥,
             模型/采样器/尺寸等出图参数一概留在下面,渠道级共用,切站不用重配 -->
        <div class="art-row">
          <span class="bbi-field-label">接入点</span>
          <input
            v-if="renamingEndpoint"
            ref="endpointNameInput"
            class="bbi-input"
            type="text"
            v-model="endpointNameDraft"
            placeholder="接入点名称"
            spellcheck="false"
            title="Enter 确认，Esc 取消"
            @keydown.enter.prevent="commitRenameEndpoint"
            @keydown.esc.stop.prevent="renamingEndpoint = false"
            @blur="commitRenameEndpoint"
          />
          <BbiSelect
            v-else
            class="art-select"
            v-model="activeEndpointId"
            :options="endpointOptions"
            aria-label="当前接入点"
          />
          <span v-if="!renamingEndpoint" class="art-ops">
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="isOfficialEndpoint"
              :title="isOfficialEndpoint ? '官方接入点不可改名' : '重命名当前接入点'"
              aria-label="重命名当前接入点"
              @click="startRenameEndpoint"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="新建一条空接入点"
              aria-label="新建一条空接入点"
              @click="addEndpoint"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :title="
                isOfficialEndpoint
                  ? '照官方复制一条,复制出来的地址可以改'
                  : '复制当前接入点(含地址与密钥)'
              "
              aria-label="复制当前接入点"
              @click="duplicateEndpoint"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op art-remove"
              type="button"
              :disabled="isOfficialEndpoint"
              :title="isOfficialEndpoint ? '官方接入点不可删除' : '删除当前接入点'"
              aria-label="删除当前接入点"
              @click="endpointDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">接口地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="endpoint.url"
            :readonly="isOfficialEndpoint"
            :placeholder="NAI_OFFICIAL_URL"
            spellcheck="false"
            :title="isOfficialEndpoint ? '官方接入点地址固定,不可修改' : ''"
          />
          <p class="bbi-field-hint">
            {{
              isOfficialEndpoint
                ? '官方接入点,地址固定;要用第三方站请点上方「+」新建一条。'
                : '第三方站填域名即可,自动补全 /ai 端点。'
            }}
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="endpoint.key"
              placeholder="nai-..."
              spellcheck="false"
            />
            <button
              class="bbi-btn"
              type="button"
              :title="showKey ? '隐藏' : '显示'"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
          <!-- key 随条目走而非渠道级共用:公益站各有各的 key,共用一份等于每次换站都要重填 -->
          <p class="bbi-field-hint">
            {{
              isOfficialEndpoint
                ? '在 NovelAI 设置页生成。每条接入点各存各的 key。'
                : '该站自己的 key;每条接入点各存各的,切回官方不会串。'
            }}
          </p>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 书写规范会切到 NAI"
            @click="settings.defaultBackend = 'nai'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
      </Collapsible>

      <NaiFullPresetPanel>
      <Collapsible title="提示词" :open="false">
        <!-- 画师串库:形制与 ComfyUI 工作流库一致,多一个「不使用」选项 -->
        <div class="art-row">
          <span class="bbi-field-label">画师串</span>
          <input
            v-if="renamingArtist"
            ref="artistNameInput"
            class="bbi-input"
            type="text"
            v-model="artistNameDraft"
            placeholder="画师串名称"
            spellcheck="false"
            title="Enter 确认，Esc 取消"
            @keydown.enter.prevent="commitRenameArtist"
            @keydown.esc.stop.prevent="renamingArtist = false"
            @blur="commitRenameArtist"
          />
          <BbiSelect
            v-else
            class="art-select"
            v-model="activeArtistId"
            :options="artistOptions"
            aria-label="当前画师串"
          />
          <span v-if="!renamingArtist" class="art-ops">
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="管理画师串库:搜索、预览图、批量删除"
              aria-label="管理画师串库"
              @click="artistManagerOpen = true"
            >
              <Icon name="grid" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="!hasArtist || isBuiltinArtist"
              :title="
                !hasArtist
                  ? '未选中画师串'
                  : isBuiltinArtist
                    ? '内置画师串不可改名,点复制建一条自己的'
                    : '重命名当前画师串'
              "
              aria-label="重命名当前画师串"
              @click="startRenameArtist"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="新建一条空画师串"
              aria-label="新建一条空画师串"
              @click="addArtist"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="!hasArtist"
              :title="
                !hasArtist
                  ? '未选中画师串'
                  : isBuiltinArtist
                    ? '复制为我的画师串,复制出来的可以随便改'
                    : '复制当前画师串'
              "
              aria-label="复制当前画师串"
              @click="duplicateArtist"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op art-remove"
              type="button"
              :disabled="!hasArtist || isBuiltinArtist"
              :title="
                !hasArtist
                  ? '未选中画师串'
                  : isBuiltinArtist
                    ? '内置画师串不可删除,它会随插件版本更新'
                    : '删除当前画师串'
              "
              aria-label="删除当前画师串"
              @click="artistDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <!-- 从智绘姬导入提示词预设的入口在下方「从智绘姬迁移」折叠区,这里不做常驻提示 -->

        <!-- 内容内联编辑:画师串通常就几个 tag,让「选中哪条」与「这条写了什么」一眼同框 -->
        <template v-if="artist">
          <BbiTextarea
            v-model="artist.prompt"
            :rows="3"
            :max-rows="8"
            mono
            :readonly="isBuiltinArtist"
            placeholder="artist:xxx, artist:yyy"
          />
          <p v-if="isBuiltinArtist" class="bbi-field-hint art-hint">
            内置画师串随插件版本更新,不可直接改;点上方复制按钮建一条自己的再改。
          </p>
          <!-- 仅 V5 模型下提醒:V5 与 4.5 的画师串响应差异大,4.5 及以下不需要这条噪音 -->
          <p v-if="isV5Model" class="bbi-field-hint art-hint art-hint-warn">
            NAI 5 对画师串的响应与 4.5 差异很大,旧画师串直接套用效果可能跑偏,建议重新调试。
          </p>

          <!-- 随画师串一起切换的正/负面词:设置了覆盖下面渠道级,没设置就用下面的 -->
          <ul class="bbi-prompt-list art-bound-list">
            <li v-for="t in artistBoundTargets" :key="t.key" class="bbi-prompt-item">
              <button class="bbi-prompt-open" type="button" @click="openNaiPrompt(t)">
                <span class="bbi-prompt-name">{{ t.label }}</span>
                <span class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                  {{ isTargetCustom(t) ? '已设置' : '未设置' }}
                </span>
                <Icon name="edit" class="bbi-prompt-edit" />
              </button>
            </li>
          </ul>
          <p class="bbi-field-hint art-hint">
            这里设置的提示词会覆盖下面的，随画师串一起切换;这里没设置，就会用下面的。
          </p>
        </template>
        <!-- 不选画师串时无提示:下拉里「不使用」已自明 -->

        <hr class="art-divider" />

        <!-- 渠道级质量词/负面词:只读列表行,点行进弹窗编辑(与设置页「自定义提示词」同款) -->
        <ul class="bbi-prompt-list">
          <li v-for="t in CHANNEL_PROMPT_TARGETS" :key="t.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openNaiPrompt(t)">
              <span class="bbi-prompt-name">{{ t.label }}</span>
              <span v-if="isShadowedByArtist(t.key)" class="bbi-prompt-state is-shadowed">
                已被画师串覆盖
              </span>
              <span v-else class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                {{ isTargetCustom(t) ? '已自定义' : '默认' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
        <p class="bbi-field-hint art-hint">
          画师串里没设置正/负面词时，就会用这里的;这里也留空，则按模型取官方词。
        </p>
      </Collapsible>

      <Collapsible title="默认参数" :open="false">
        <!-- 语义配对紧凑行:双字段行两列、数字参数行四列;说明统一收进行下的一行 hint -->
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">模型</span>
          </div>
          <BbiSelect
            class="be-select"
            v-model="modelSel"
            :options="NAI_MODELS"
            aria-label="NAI 模型"
          />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然语言</span>
          <input v-model="settings.nai.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          开:自动 tag 为画面与每个角色额外写一段英文描述;关:只写 tag。4.5 的提示词上限约 512 token
          (画面与所有角色共用),自然语言最占篇幅,超了会被截断、画面走样,可以关掉试试。
          只影响之后新写的提示词:正文里已有的自然语言照常发送,想对比可在「编辑提示词」里点「AI 重写提示词」。
          多角色提示照常按角色拆分,只是每个角色同样只写 tag。
        </p>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">竖屏尺寸(宽×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.portraitSize"
              list="nai-portrait-presets"
              placeholder="832×1216"
              spellcheck="false"
            />
            <datalist id="nai-portrait-presets">
              <option value="832×1216">竖版</option>
              <option value="1024×1536">大竖版</option>
              <option value="1024×1024">方图</option>
            </datalist>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">横屏尺寸(宽×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.landscapeSize"
              list="nai-landscape-presets"
              placeholder="1216×832"
              spellcheck="false"
            />
            <datalist id="nai-landscape-presets">
              <option value="1216×832">横版</option>
              <option value="1536×1024">大横版</option>
              <option value="1024×1024">方图</option>
            </datalist>
          </div>
        </div>
        <div class="bbi-select-row">
          <span class="bbi-field-label">画幅方向</span>
          <div class="bbi-segmented" role="tablist" aria-label="NAI 画幅方向">
            <button
              v-for="opt in ORIENTATION_LOCKS"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': settings.nai.orientationLock === opt.value }"
              type="button"
              role="tab"
              :aria-selected="settings.nai.orientationLock === opt.value"
              @click="settings.nai.orientationLock = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <p class="bbi-field-hint">
          竖屏用于单人、特写、立绘;横屏用于群像、远景、全景。「自动」由自动 tag 按画面判定;
          锁定后每张图都按该方向出,自动 tag 也按这个画幅构图。正文里已记下的方向不会被改写,改回「自动」即恢复。
        </p>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">采样器</span>
            </div>
            <BbiSelect
              class="be-select"
              v-model="settings.nai.sampler"
              :options="samplerOptions"
              aria-label="采样器"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">噪声表</span>
            </div>
            <BbiSelect
              class="be-select"
              v-model="settings.nai.noiseSchedule"
              :options="NAI_NOISE_SCHEDULES"
              aria-label="噪声表"
            />
          </div>
        </div>

        <div class="be-row be-row--nums">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步数</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.steps" min="1" max="50" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Scale</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.scale"
              min="0"
              max="35"
              step="0.1"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Rescale</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.cfgRescale"
              min="0"
              max="1"
              step="0.05"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">种子</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.seed" min="0" />
          </div>
        </div>
        <p class="bbi-field-hint">Scale = 提示词相关性;Rescale = 相关性调整;种子 0 = 随机。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Variety Boost(画面多样性,按尺寸自动计算)</span>
          <input v-model="settings.nai.varietyBoost" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="bbi-num-row">
          <span class="bbi-field-label">同时出图数</span>
          <input
            class="bbi-input bbi-num"
            type="number"
            v-model.number="settings.nai.concurrency"
            min="1"
            max="4"
          />
        </div>
        <p class="bbi-field-hint">
          NAI 服务端不排队,并发高容易被限流(429),建议保持 1;超出的请求自动排队等待。
          被限流时会自动退避重试(最多 3 次),并让所有排队任务一起冷却,不会连着撞上去。
        </p>
      </Collapsible>

      <Collapsible title="Vibe 库(氛围转移)" :open="false">
        <p v-if="vibesSupported" class="bbi-field-hint vibe-hint">
          上传参考图,生成时叠加其风格/氛围;编码按当前选中的模型进行,会消耗一次接口调用。
        </p>
        <p v-else class="bbi-field-hint vibe-hint">
          Current model does not support Vibe Transfer.
        </p>

        <div class="vibe-actions">
          <button class="bbi-btn" type="button" :disabled="vibeEncoding || !vibesSupported" @click="vibeFileInput?.click()">
            <Icon name="plus" />
            {{ vibeEncoding ? '编码中…' : '上传图片编码' }}
          </button>
          <button class="bbi-btn" type="button" @click="vibeImportInput?.click()">
            <Icon name="download" />
            导入 .naiv4vibe
          </button>
          <label class="bbi-switch-row vibe-normalize">
            <span class="bbi-field-label">强度归一化</span>
            <input v-model="settings.nai.normalizeRefStrength" type="checkbox" class="bbi-checkbox" :disabled="!vibesSupported" />
          </label>
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
              共 {{ settings.nai.vibes.length }} 个 · 已启用 {{ enabledCount }}
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
                  title="只叠加这一组:关掉组外全部勾选,开启本组"
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
                    <label class="vibe-enable" title="生成时叠加此 vibe">
                      <input v-model="vibe.enabled" type="checkbox" class="bbi-checkbox" />
                      启用
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
                      title="该 vibe 缺当前模型的编码,生成时会被跳过;点击按当前模型补编码"
                      @click="reencodeVibe(vibe)"
                    >
                      <Icon name="refresh" :size="12" /> 补当前模型编码
                    </button>
                    <span v-else-if="!vibesSupported" class="vibe-missing">
                      当前模型暂不支持 Vibe
                    </span>
                    <span v-else-if="!vibe.modelKeys.includes(currentVibeKey)" class="vibe-missing">
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
                    <button class="bbi-btn bbi-btn-sm" type="button" title="删除" @click="removeVibe(vibe)">
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
          提示词预设同理:前置固定正向 → 画师串，后置固定正向 → 正面质量词，固定负向 → 负面提示词（自动带上当前模型官方基线）。
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
      </NaiFullPresetPanel>
    </div>

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
          把智绘姬的全部 {{ artistImportResult?.plans.length ?? 0 }} 个提示词预设复制到柏宝绘，只建副本、不改动智绘姬的数据。
          映射：前置固定正向 → 画师串，后置固定正向 → 正面质量词，固定负向 → 负面提示词（前面自动拼上当前模型的官方基线）。
          同名条目会覆盖更新（之前导入过的可直接重新导入修复），内容完全相同的自动跳过。
        </p>
        <ul class="art-import-list">
          <li v-for="(plan, i) in artistImportResult?.plans ?? []" :key="i" class="art-import-item">
            <div class="art-import-head">
              <span class="art-import-name" :title="plan.source">{{ plan.source || '(未命名)' }}</span>
              <span class="art-import-badge" :class="`is-${plan.state}`">
                {{ plan.state === 'import' ? '将导入' : plan.state === 'overwrite' ? '将覆盖' : '已存在' }}
              </span>
              <span v-if="plan.active" class="art-import-badge is-active">当前使用中</span>
            </div>
            <div class="art-import-fields">
              <code class="art-import-line" :title="plan.prompt"
                ><span class="art-import-key">画师串</span>{{ plan.prompt || '(空)' }}</code
              >
              <code class="art-import-line" :title="plan.quality"
                ><span class="art-import-key">正向</span>{{ plan.quality || '(空)' }}</code
              >
              <code class="art-import-line" :title="plan.negative"
                ><span class="art-import-key">负向</span>{{ plan.negative || '(空)' }}</code
              >
            </div>
          </li>
        </ul>
        <label v-if="chatu8ActiveRef" class="art-import-switch">
          <input type="checkbox" v-model="switchActiveArtist" />
          <span>
            导入后切换到智绘姬当前使用的预设
            <code>{{ chatu8ActiveRef.source }}</code>
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

    <!-- ===== 画师串库管理器:搜索/预览图/勾选批量删除 ===== -->
    <NaiArtistManager v-model:open="artistManagerOpen" />

    <ConfirmDialog
      v-model:open="endpointDeleteOpen"
      title="删除接入点"
      confirm-text="删除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveEndpoint"
    >
      确定删除接入点「{{ endpoint.name || '未命名接入点' }}」？地址与 API Key 会一并删除。
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="artistDeleteOpen"
      title="删除画师串"
      confirm-text="删除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveArtist"
    >
      确定删除画师串「{{ artist?.name || '未命名画师串' }}」？删除后无法恢复。
    </ConfirmDialog>

    <!-- ===== 质量词 / 负面词编辑弹窗(与设置页自定义提示词同款) ===== -->
    <ModalMask :open="!!editingNaiPrompt" @close="closeNaiPrompt">
      <div
        v-if="editingNaiPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`编辑${editingNaiPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingNaiPrompt.readonly ? '查看' : '编辑' }}{{ editingNaiPrompt.label }}
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeNaiPrompt">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-modal-label">{{ editingNaiPrompt.hint }}</p>

        <BbiTextarea
          v-model="naiPromptDraft"
          class="bbi-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
          :readonly="editingNaiPrompt.readonly"
        />

        <footer class="bbi-modal-foot">
          <template v-if="!editingNaiPrompt.readonly">
            <button class="bbi-btn bbi-btn-danger" type="button" @click="resetNaiPromptDraft">
              <Icon name="refresh" /> 恢复默认
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="closeNaiPrompt">取消</button>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="saveNaiPrompt">完成</button>
          </template>
          <template v-else>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="closeNaiPrompt">关闭</button>
          </template>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* 默认参数的语义配对紧凑行:双字段行两列、数字参数行四列;
   窄屏双字段行落单列、数字行落 2×2。
   垂直节奏由行容器统一管(行内字段的 margin-bottom 归零),
   不靠 .bbi-field 自带的:last-child 规则——行尾字段会被它吃掉下间距。 */
.be-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
  margin-bottom: 18px;
}

.be-row .bbi-field {
  margin-bottom: 0;
}

/* 参数区的自绘下拉吃满字段宽:与同行的 .bbi-input(模型名/尺寸)左右对齐,
   子组件根类默认 180px/flex:none,这里压过去。 */
.be-select {
  width: 100%;
}

.be-row--nums {
  grid-template-columns: repeat(4, 1fr);
}

@media (max-width: 640px) {
  .be-row {
    grid-template-columns: 1fr;
  }

  .be-row--nums {
    grid-template-columns: repeat(2, 1fr);
  }
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
/* 左侧「使用此渠道 / 当前出图渠道」与右侧测试连接分据两端 */
.conn-use,
.conn-inuse {
  margin-right: auto;
}
.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}
.vibe-hint {
  margin-top: 0;
}

/* —— 画师串库(形制照搬 ComfyUIPanel 的 .wf-*) —— */
/* 选择行:grid 而非 flex——靠 flex-basis 撑出的对齐一 wrap 就散,
   固定首列宽让标签列与下方各行的标签列同起点。 */
.art-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.art-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.art-row > .bbi-input {
  min-width: 0;
}
/* 下拉不吃满:名称通常很短,拉满只会拖出半截空白(子组件根类默认 180px/不伸缩,此处 0,2,0 压过) */
.art-row > .art-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.art-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
/* 四个操作低频且同级,图标化后整行只剩下拉一个视觉重点;文案退到 title/aria-label */
.art-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.art-op:disabled {
  opacity: 0.4;
  cursor: default;
}
.art-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.art-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.art-hint {
  margin-top: 8px;
}

/* V5 画师串差异提醒:警示色,与常规说明区分开 */
.art-hint-warn {
  color: var(--bbi-warning);
}
/* 画师串与下方质量词/负面词的分界 */
.art-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 12px 0;
}
/* 绑定列表与上方画师串编辑区拉开一点;「已被画师串覆盖」用警示色——渠道值正被覆盖,
   用户在渠道行改了却不生效,需要一眼看出原因 */
.art-bound-list {
  margin-top: 10px;
}
.bbi-prompt-state.is-shadowed {
  color: var(--bbi-warning);
  background: transparent;
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

/* 操作按钮基类:.bbi-icon-btn 只在 App.vue 的 scoped 块里声明,此处补一份
   (与 ComfyUIPanel 同款处理;漏了会渲染成浏览器原生按钮,shadow DOM 里也拿不到 ST 样式) */
.bbi-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}

/* —— 质量词/负面词列表行 + 弹窗:样式随设置页「自定义提示词」,scoped 不跨组件故补一份 —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑(状态药丸 .bbi-prompt-state 在 base.css 全局,无需补) */
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
.bbi-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}
/* 弹窗:更宽 + 大文本框 */
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
/* 把「恢复默认」推到最左(本文件的迁移弹窗此前裸用过此类名,靠 foot 的 flex-end 蒙对) */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险按钮:与设置页/ConfirmDialog 同一份口径。base 规则不能只写 :hover ——
   scoped 不跨组件、base.css 里也没有,只写 hover 的话平时是默认墨色,鼠标一过才变红。 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.migrate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.vibe-normalize {
  margin-left: auto;
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
  font-size: 12px;
  color: #c44747;
}

/* —— 分组 —— */
/* 工具条:搜索框吃满,计数与「整理分组」靠右。长列表口径与设置页排除弹窗一致
   (搜索 + 子串匹配收敛渲染量),故不做分页——vibe 靠缩略图认人,翻页只会
   把「我那张图在第几页」变成新的记忆负担。 */
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
/* 组头:整块浅底,把「组」和组内条目在视觉上分层;粘顶让长组滚动时组名不丢 */
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
/* 组名区整体可点(折叠):按钮撑满剩余宽度,点空白处也能收起 */
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
/* 展开态朝下(与 Collapsible 同口径:收起时回到未旋转的朝右/朝上) */
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
/* 「生效中」复用状态药丸基样式,上色口径与 wf-state.is-ok 一致 */
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
/* 组内条目左缩进一格,读得出层级 */
.vibe-group-body {
  padding-left: 10px;
}
/* 组头本身就是一条分界,组内首条不再画上边线(否则紧贴组头是两道线) */
.vibe-group-body > .vibe-item:first-child {
  border-top: 0;
}
.vibe-group-select {
  width: 130px;
}
/* 组头操作里的小图标钮:.bbi-icon-mini 只在其它页的 scoped 块里声明,此处补一份 */
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
  /* 窄屏:组头两行——组名一行,操作另起一行靠右,避免按钮把组名挤成一条缝 */
  .vibe-group-ops {
    width: 100%;
    justify-content: flex-end;
  }
  .vibe-group-body {
    padding-left: 0;
  }
  /* 同理:四个图标钮 + 标签会把画师串下拉挤成一条缝,标签独占首行,
     下拉与操作组同行分据两端 */
  .art-row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }
  .art-row > .bbi-field-label:first-child {
    grid-column: 1 / -1;
  }
  .art-row > .art-select {
    max-width: none;
  }
}
</style>
