export { DEFAULT_JAILBREAK_PROMPT } from './prompts/prefix';
import { DEFAULT_DSH_SKILL_REQUEST } from './prompts/dshSkillRequest';
export { DEFAULT_DSH_SKILL_REQUEST } from './prompts/dshSkillRequest';
export { DEFAULT_COMFY_SPEC } from './prompts/comfySpec';
export { DEFAULT_COMFY_NL_SPEC } from './prompts/comfyNaturalLanguage';
export { DEFAULT_NAI_SPEC } from './prompts/naiLegacySpec';
export { DEFAULT_COMFY_THINKING } from './prompts/comfyCheck';
export { DEFAULT_NAI_THINKING } from './prompts/naiLegacyCheck';
export { DEFAULT_NAI_V5_THINKING } from './prompts/naiV5Check';
export { DEFAULT_NAI_V5_SPEC } from './prompts/naiV5Spec';
import type { BackendId, BackendConn, ComfyWorkflowPreset, ComfyRunConn, ComfyUISettings, UiPrefs, ImageDisplaySize, ApiChannel, AutoTagSettings, StoragePrefs, ExcludesSettings, AutoTagPrompts, ImageSettings } from './settings/types';
export type { BackendId, BackendConn, ComfyWorkflowPreset, ComfyRunConn, ComfyUISettings, UiPrefs, ImageDisplaySize, ApiChannel, AutoTagSettings, StoragePrefs, ExcludesSettings, AutoTagPrompts, ImageSettings } from './settings/types';
import type { NaiModel, NaiVibeEncodings, NaiVibeData, NaiVibe, NaiArtistPreset, NaiEndpoint, NaiSettings } from './settings/naiTypes';
export type { NaiModel, NaiVibeEncodings, NaiVibeData, NaiVibe, NaiArtistPreset, NaiEndpoint, NaiSettings } from './settings/naiTypes';
import {
  normalizeSimpleConfig,
  simpleDefaults,
} from '@/backends/comfyTemplates';
import { BUILTIN_NAI_ARTISTS, isBuiltinNaiArtist, naiDefaultUndesired } from '@/backends/nai';
import {
  normalizeOrientationLock,
  parseSize,
  type OrientationLock,
} from '@/backends/size';
import {
  clampVibeStrength,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import { getContext } from '@/st/context';
import { mangaDefaults, normalizeManga } from '@/manga/layouts';
import { reactive, watch } from 'vue';
// 顺序即展示顺序(渠道页页签 / 设置页出图后端下拉):NAI 用户最多,排最前;webui 隐藏但保留。
export const BACKENDS: { value: BackendId; label: string }[] = [
  { value: 'nai', label: 'NAI' },
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'webui', label: 'WebUI' },
];

/**
 * 可选模型:只留 4.5 与 V5。两代共用同一套「Base + 原生 Character Prompts + 英文自然
 * 语言」协议,收窄后 naiSupportsCharacterPrompts 对全部可选模型恒真 —— 单串 tag 那套
 * DEFAULT_NAI_SPEC / DEFAULT_NAI_THINKING 因此不再可达,设置页也相应撤掉了入口。
 *
 * ⚠ 存量选着已下线模型的配置会被 normalizeNai 回落到 naiDefaults().model:画风、Anlas
 * 消耗与 vibe 编码 key 都会随之改变。这是有意接受的代价(4.5 以下已基本无人使用),
 * 只在控制台留一条告警,不弹窗打扰。
 */
export const NAI_MODELS: { value: NaiModel; label: string }[] = [
  { value: 'nai-diffusion-5-full', label: 'NAI 5 Full(最新,无过滤)' },
  { value: 'nai-diffusion-5-curated', label: 'NAI 5 Curated(有内容过滤)' },
  { value: 'nai-diffusion-4-5-full', label: 'NAI 4.5 Full(无过滤)' },
  { value: 'nai-diffusion-4-5-curated', label: 'NAI 4.5 Curated(有内容过滤)' },
];

/** 官方站地址。内置那条接入点的 url 恒为它(UI 禁改,normalize 也把脏数据纠回来)。 */
export const NAI_OFFICIAL_URL = 'https://image.novelai.net';

/** 内置官方接入点的固定 id。靠它认人而非靠 url 比对(与内置画师串 `bi_*` 同套路)。 */
export const OFFICIAL_NAI_ENDPOINT_ID = 'nep_official';

/** 这条是不是内置官方接入点(url 只读、不可删、不可改名)。 */
export function isOfficialNaiEndpoint(id: string): boolean {
  return id === OFFICIAL_NAI_ENDPOINT_ID;
}

/**
 * 显示大小选项(顺序即下拉顺序)。封的是**高度**而不是宽度:PC 上嫌大的,是竖图铺满
 * 楼层宽度后比一屏还高;按宽度封顶,竖图照样高,横图反倒被压得过小。宽度随原图比例,
 * 且始终不超过楼层宽度——窄屏(手机竖屏)上竖图本来就矮于 600px,默认档基本无感。
 */
export const IMAGE_DISPLAY_SIZES: { value: ImageDisplaySize; label: string; maxHeight: number | null }[] = [
  { value: 'small', label: '小（高度不超过 400px）', maxHeight: 400 },
  { value: 'medium', label: '中（高度不超过 600px）', maxHeight: 600 },
  { value: 'large', label: '大（高度不超过 800px）', maxHeight: 800 },
  { value: 'full', label: '铺满楼层宽度（不限高度）', maxHeight: null },
];

/** 显示大小 → 图片显示高度上限(px);null = 不封顶,铺满楼层宽度(0.3.0 及以前的样子)。 */
export function imageDisplayMaxHeight(size: ImageDisplaySize): number | null {
  return IMAGE_DISPLAY_SIZES.find(option => option.value === size)?.maxHeight ?? null;
}

// extension_settings 里的命名空间键。
const SETTINGS_KEY = 'baibai_image';

/** 内置默认条目名规则:共享存储创建时播种(与柏宝书 DEFAULT_WI_PATTERNS 同值)。 */
const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];

function excludesDefaults(): ExcludesSettings {
  return {
    excludedChars: [],
    excludedWorldNames: [],
    excludedWorldInfoPatterns: [],
    customStripTags: [],
  };
}

function backendDefaults(url: string): BackendConn {
  return {
    url,
    qualityTags: '',
    negativePrompt: '',
    resolution: '',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
  };
}

/** 新预设的默认名(迁移与建库都用它,保持一致口径)。 */
const DEFAULT_WORKFLOW_NAME = '默认工作流';
/** 默认横竖尺寸(与 backendDefaults 同值;预设级尺寸独立于渠道级,故单列一份)。 */
const DEFAULT_PORTRAIT_SIZE = '832×1216';
const DEFAULT_LANDSCAPE_SIZE = '1216×832';

let workflowSeq = 0;

/** 新建一条空工作流预设(id 生成口径同 newChannel)。 */
export function newComfyWorkflow(name = DEFAULT_WORKFLOW_NAME): ComfyWorkflowPreset {
  workflowSeq += 1;
  return {
    id: `wf_${Date.now()}_${workflowSeq}`,
    name,
    mode: 'custom',
    workflow: '',
    simple: simpleDefaults(),
    naturalLanguage: false,
    generateNegative: false,
    portraitSize: DEFAULT_PORTRAIT_SIZE,
    landscapeSize: DEFAULT_LANDSCAPE_SIZE,
    orientationLock: 'auto',
  };
}

/**
 * 新装即带一条空预设,而不是空库。
 * 只用一套工作流的人不该被迫先「新建」才有地方粘 JSON——手感与改造前的单文本框完全一致,
 * 「库」这个概念对他们保持隐形。也顺带让 workflows 恒非空的不变式从出生起就成立。
 */
function comfyDefaults(): ComfyUISettings {
  const preset = newComfyWorkflow();
  return {
    ...backendDefaults('http://127.0.0.1:8188'),
    imageFormat: 'jpeg',
    workflows: [preset],
    activeWorkflowId: preset.id,
  };
}

/** 新画师串的默认名。 */
const DEFAULT_ARTIST_NAME = '画师串 1';

let artistSeq = 0;

/** 新建一条空配方(id 生成口径同 newComfyWorkflow / newChannel;art_ 前缀不与 wf_/ch_ 撞)。 */
export function newNaiArtist(name = DEFAULT_ARTIST_NAME): NaiArtistPreset {
  artistSeq += 1;
  return { id: `art_${Date.now()}_${artistSeq}`, name, prompt: '', quality: '', negative: '' };
}

/** 内置官方接入点。key 随用户填(内置的只是地址与名字,不是别人的密钥)。 */
function officialNaiEndpoint(key = ''): NaiEndpoint {
  return { id: OFFICIAL_NAI_ENDPOINT_ID, name: 'NovelAI 官方', url: NAI_OFFICIAL_URL, key };
}

let naiEpSeq = 0;

/** 新建一条空接入点(id 前缀 nep_,不与 art_/wf_/ch_ 的 id 空间相撞)。 */
export function newNaiEndpoint(name = '新接入点'): NaiEndpoint {
  naiEpSeq += 1;
  return { id: `nep_${Date.now()}_${naiEpSeq}`, name, url: '', key: '' };
}

function naiDefaults(): NaiSettings {
  return {
    ...backendDefaults(NAI_OFFICIAL_URL),
    resolution: '832×1216',
    // 新装即带内置官方那条并选中它:地址是必需品,空列表会让「测试连接」无处可点
    endpoints: [officialNaiEndpoint()],
    activeEndpointId: OFFICIAL_NAI_ENDPOINT_ID,
    key: '',
    model: 'nai-diffusion-5-full',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5.5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    concurrency: 1,
    vibes: [],
    // 用户库为空:库里只有用户自己建的配方,官方推荐的那条是内置只读条目
    // (BUILTIN_NAI_ARTISTS),不进 settings。
    artistPresets: [],
    // 新装用户默认启用内置「默认画师串」——默认值只在这条路径生效:
    // hydrate 时旧用户的 stored.nai.activeArtistId 已存在(哪怕空串),会被
    // normalizeNai 原样保留,不受影响。
    activeArtistId: BUILTIN_NAI_ARTISTS[0]?.id ?? '',
    naturalLanguage: true,
    orientationLock: 'auto',
  };
}

function defaults(): ImageSettings {
  return {
    enabled: true,
    ui: {
      theme: 'day',
      navPosition: 'auto',
      navTapClose: true,
      showTopBar: false,
      showOrb: false,
      orbImage: '',
      orbShape: 'bookmark',
      orbOpacity: 62,
      orbSize: 48,
      cardTheme: 'st',
      autoCollapseImages: false,
      imageDisplaySize: 'medium',
    },
    // 出图后端默认 ComfyUI(当前唯一实现的出图后端);webui 渠道已隐藏,不再作为可选值
    defaultBackend: 'comfyui',
    webui: backendDefaults('http://127.0.0.1:7860'),
    comfyui: comfyDefaults(),
    nai: naiDefaults(),
    channels: [],
    assignments: { tagGen: '' },
    worldBooks: { enabled: false, includeTavern: false, names: [] },
    autoTag: {
      dshSession: false,
      dshDedicated: false,
      dshUserMessages: false,
      dshRuleSource: 'plugin',
      dshSkillRequest: DEFAULT_DSH_SKILL_REQUEST,
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: {
        jailbreak: '',
        naiSpec: '',
        naiV5Spec: '',
        comfySpec: '',
        comfyThinking: '',
        naiThinking: '',
        naiV5Thinking: '',
      },
    },
    excludes: excludesDefaults(),
    storage: { saveAsJpeg: true },
    manga: mangaDefaults(),
  };
}

let chanSeq = 0;

/** 补全单个渠道的缺失字段并校验类型(与柏宝书同构,共享存储来回序列化也安全)。 */
function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : `ch_${Date.now()}_${++chanSeq}`,
    name: typeof c.name === 'string' ? c.name : '新渠道',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    temperature: typeof c.temperature === 'number' ? c.temperature : 1.0,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 65535,
    timeoutSec:
      typeof c.timeoutSec === 'number' && Number.isFinite(c.timeoutSec) && c.timeoutSec > 0
        ? Math.floor(c.timeoutSec)
        : 180,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string')
      : [],
    // 后加字段:老渠道无此键 → 空串(auto,不发参数),行为与加字段前完全一致
    reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
  };
}

export function newChannel(): ApiChannel {
  chanSeq += 1;
  return {
    id: `ch_${Date.now()}_${chanSeq}`,
    name: '新渠道',
    url: '',
    key: '',
    model: '',
    temperature: 1.0,
    maxTokens: 65535,
    timeoutSec: 180,
    stream: false,
    excludeParams: [],
    reasoningEffort: '',
  };
}

/** 「生成 tag」当前指派的渠道;未指派(跟随主 API)或渠道已删时返回 null。 */
export function getTagGenChannel(): ApiChannel | null {
  const id = settings.assignments.tagGen;
  if (!id) return null;
  return settings.channels.find(c => c.id === id) ?? null;
}

/**
 * 当前使用的工作流预设。
 *
 * 不返回 null:workflows 恒非空(comfyDefaults 出生即带一条、normalizeComfyUI 收尾兜底),
 * activeWorkflowId 悬空时也在 normalize 阶段回落过。这里再取一次 [0] 兜底,是为了
 * 「UI 运行中把库改坏」这种时序,让调用方不必到处判空。
 * 刻意只读不写:本函数在 computed 里被调用,写 settings 会引起递归求值。
 */
export function activeComfyPreset(): ComfyWorkflowPreset {
  const list = settings.comfyui.workflows;
  return list.find(w => w.id === settings.comfyui.activeWorkflowId) ?? list[0] ?? newComfyWorkflow();
}

/** 画幅锁选项(顺序即分段按钮顺序);NAI 渠道与 ComfyUI 每套工作流的面板共用这一份。 */
export const ORIENTATION_LOCKS: { value: OrientationLock; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'portrait', label: '竖屏' },
  { value: 'landscape', label: '横屏' },
];

/**
 * 当前出图后端的画幅锁:NAI 取渠道级那一份,ComfyUI 取当前工作流预设那一份;其余后端不锁。
 *
 * 出图(generate.ts)、自动 tag 协议与收尾(autoTag/prompt.ts、runner.ts)、卡片占位与
 * 提示词编辑弹窗都从这里取——判据只此一处,免得「协议说锁竖、出图却按 tag 出横」。
 * 同样刻意只读不写(在 computed 里被调用)。
 */
export function activeOrientationLock(): OrientationLock {
  if (settings.defaultBackend === 'nai') return settings.nai.orientationLock;
  if (settings.defaultBackend === 'comfyui') return activeComfyPreset().orientationLock;
  return 'auto';
}

/**
 * 出图/测试连接用的 conn:渠道级 url + 当前预设的工作流与横竖尺寸。
 * backends/comfyui.ts 只吃这个形状,不关心库里还有几套。
 */
export function effectiveComfyConn(): ComfyRunConn {
  const preset = activeComfyPreset();
  return {
    url: settings.comfyui.url,
    imageFormat: settings.comfyui.imageFormat,
    workflow: preset.workflow,
    mode: preset.mode,
    simple: preset.simple,
    portraitSize: preset.portraitSize,
    landscapeSize: preset.landscapeSize,
  };
}

/**
 * 当前选中的画师串;**未选 / 指向已删条目时返回 null(= 不使用)**。
 *
 * 与 activeComfyPreset 的「永不 null」刻意相反:工作流不给就出不了图,所以那边一路兜底;
 * 画师串不给只是不加画风,兜底成 [0] 反而会把「不使用」悄悄变成「用库里第一条」,
 * 是画面级的静默改动。
 * 同样刻意只读不写:本函数在 computed 里被调用,写 settings 会引起递归求值。
 *
 * 注意拼装侧不走这里,走 backends/nai.ts 的 naiArtistPrompt(纯函数、吃 NaiSettings)——
 * settings.ts 已 import 本模块的 naiDefaultUndesired,反向加值依赖会成运行时环。
 */
export function activeNaiArtist(): NaiArtistPreset | null {
  const id = settings.nai.activeArtistId;
  if (!id) return null;
  // 查找域 = 用户库 ∪ 内置库(与 nai.ts 的 naiActivePreset 同口径)
  return (
    settings.nai.artistPresets.find(a => a.id === id) ??
    BUILTIN_NAI_ARTISTS.find(a => a.id === id) ??
    null
  );
}

/**
 * 当前使用的接入点。
 *
 * 不返回 null(同 activeComfyPreset,与 activeNaiArtist 的「可为 null」相反):
 * endpoints 恒非空、id 悬空也在 normalize 阶段回落过,这里再兜一层是为了
 * 「UI 运行中把列表改坏」这种时序,让调用方不必到处判空。
 * 刻意只读不写:本函数在 computed 里被调用,写 settings 会引起递归求值。
 */
export function activeNaiEndpoint(): NaiEndpoint {
  const list = settings.nai.endpoints;
  return list.find(e => e.id === settings.nai.activeEndpointId) ?? list[0] ?? officialNaiEndpoint();
}

/**
 * 出图/测试连接/vibe 编码用的 NaiSettings:渠道级全部参数 + 当前接入点的 url/key。
 *
 * **后端层一律吃这个,不吃 settings.nai**(同 effectiveComfyConn 的理由):
 * backends/nai.ts 关心的是「这一次往哪儿发、用谁的 key」,而不是「用户存了几个站」。
 * 漏走一处的症状很隐蔽——那处会用上存量的 nai.url/nai.key(老用户还是通的),
 * 只有切到第二个接入点的人才会发现某个功能还在往老地址发。
 */
export function effectiveNai(): NaiSettings {
  const ep = activeNaiEndpoint();
  return { ...settings.nai, url: ep.url, key: ep.key };
}

/**
 * 存量迁移:老配置只有单一 resolution(NAI 默认竖版 832×1216)。
 * 升级后按宽高关系把它归进对应那一格,另一格用默认值——
 * 用户之前特意调过的尺寸不会被默认值悄悄顶掉。
 */
function migrateSize(o: Partial<BackendConn>, def: BackendConn, want: 'portrait' | 'landscape'): string {
  const key = want === 'landscape' ? 'landscapeSize' : 'portraitSize';
  const current = o[key];
  if (typeof current === 'string' && current.trim()) return current;
  const legacy = typeof o.resolution === 'string' ? parseSize(o.resolution) : null;
  if (legacy) {
    const legacyIs = legacy.width > legacy.height ? 'landscape' : 'portrait';
    if (legacyIs === want) return o.resolution as string;
  }
  return def[key];
}

function normalizeBackend(raw: unknown, def: BackendConn): BackendConn {
  const o = (raw ?? {}) as Partial<BackendConn>;
  return {
    url: typeof o.url === 'string' ? o.url : def.url,
    qualityTags: typeof o.qualityTags === 'string' ? o.qualityTags : def.qualityTags,
    negativePrompt: typeof o.negativePrompt === 'string' ? o.negativePrompt : def.negativePrompt,
    resolution: typeof o.resolution === 'string' ? o.resolution : def.resolution,
    portraitSize: migrateSize(o, def, 'portrait'),
    landscapeSize: migrateSize(o, def, 'landscape'),
  };
}

/** 单条预设清洗:缺字段/类型不符逐项回退,尺寸空串按默认补(工作流用了 %width% 时要有值可用)。 */
function normalizeWorkflowPreset(raw: unknown, seq: number): ComfyWorkflowPreset {
  const o = (raw ?? {}) as Partial<ComfyWorkflowPreset>;
  const size = (value: unknown, def: string) =>
    typeof value === 'string' && value.trim() ? value : def;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `wf_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' && o.name ? o.name : DEFAULT_WORKFLOW_NAME,
    // 存量预设没有 mode 字段 → custom(它们都是粘 JSON 的);simple 逐字段清洗出全量默认值
    mode: o.mode === 'simple' ? 'simple' : 'custom',
    workflow: typeof o.workflow === 'string' ? o.workflow : '',
    simple: normalizeSimpleConfig(o.simple),
    naturalLanguage: typeof o.naturalLanguage === 'boolean' ? o.naturalLanguage : false,
    generateNegative: o.generateNegative === true,
    portraitSize: size(o.portraitSize, DEFAULT_PORTRAIT_SIZE),
    landscapeSize: size(o.landscapeSize, DEFAULT_LANDSCAPE_SIZE),
    orientationLock: normalizeOrientationLock(o.orientationLock),
  };
}

/**
 * 存量迁移:老配置的 comfyui 是「单套工作流」——workflow / naturalLanguage 两个平铺字段
 * 加渠道级的横竖尺寸。升级后把这四项原样折成库里的第一条预设(与 foldLegacyNegative、
 * migrateSize 同口径:用户特意设过的值绝不被默认值悄悄顶掉)。
 *
 * workflow 为空串也照样建这一条:那正是用户当前面对的空槽位,不是垃圾数据——
 * 何况 workflows 恒非空的不变式要求库里至少有一条。
 */
function foldLegacyWorkflow(o: Partial<ComfyUISettings>, conn: BackendConn): ComfyWorkflowPreset {
  const legacy = o as Partial<{ workflow: unknown; naturalLanguage: unknown }>;
  const preset = newComfyWorkflow();
  return {
    ...preset,
    workflow: typeof legacy.workflow === 'string' ? legacy.workflow : '',
    naturalLanguage: typeof legacy.naturalLanguage === 'boolean' ? legacy.naturalLanguage : false,
    // 渠道级横竖尺寸下沉进预设;normalizeBackend 已做过 resolution→横竖两格的老迁移
    portraitSize: conn.portraitSize.trim() || preset.portraitSize,
    landscapeSize: conn.landscapeSize.trim() || preset.landscapeSize,
  };
}

function normalizeComfyUI(raw: unknown, def: ComfyUISettings): ComfyUISettings {
  const conn = normalizeBackend(raw, def);
  const o = (raw ?? {}) as Partial<ComfyUISettings>;

  const workflows = Array.isArray(o.workflows)
    ? o.workflows.map(normalizeWorkflowPreset)
    : [foldLegacyWorkflow(o, conn)];
  // 不变式兜底:脏数据把库清空了也要留一条,否则面板与出图门槛全得处理 undefined
  if (!workflows.length) workflows.push(newComfyWorkflow());

  // 指向已删条目(或压根没存)时回落第一条:悬空 id 会让面板显示空白、出图取不到工作流
  const activeWorkflowId =
    typeof o.activeWorkflowId === 'string' && workflows.some(w => w.id === o.activeWorkflowId)
      ? o.activeWorkflowId
      : workflows[0].id;

  return { ...conn, imageFormat: o.imageFormat === 'original' ? 'original' : 'jpeg', workflows, activeWorkflowId };
}

const NAI_MODEL_VALUES = new Set<string>(NAI_MODELS.map(m => m.value));

function clampNumber(value: unknown, def: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : def;
}

function normalizeVibeEncodings(raw: unknown): NaiVibeEncodings {
  const encodings: NaiVibeEncodings = {};
  if (!raw || typeof raw !== 'object') return encodings;
  for (const [key, value] of Object.entries(raw)) {
    const v = value as Partial<{ encoding: unknown; infoExtracted: unknown }> | null;
    if (v && typeof v.encoding === 'string' && v.encoding) {
      encodings[key] = {
        encoding: v.encoding,
        infoExtracted: clampNumber(v.infoExtracted, 1, 0, 1),
      };
    }
  }
  return encodings;
}

function readLegacyVibeData(raw: unknown): NaiVibeData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<NaiVibe & NaiVibeData>;
  if (typeof o.dataPath === 'string' && o.dataPath) return null;
  const data = {
    image: typeof o.image === 'string' ? o.image : '',
    thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : '',
    encodings: normalizeVibeEncodings(o.encodings),
  };
  return data.image || data.thumbnail || Object.keys(data.encodings).length ? data : null;
}

function normalizeVibe(raw: unknown, seq: number): NaiVibe | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<NaiVibe & NaiVibeData>;
  const encodings = normalizeVibeEncodings(o.encodings);
  const id = typeof o.id === 'string' && o.id ? o.id : `vibe_${Date.now()}_${seq}`;
  const image = typeof o.image === 'string' ? o.image : '';
  const modelKeys = Array.isArray(o.modelKeys)
    ? o.modelKeys.filter((key): key is string => typeof key === 'string' && !!key)
    : Object.keys(encodings);
  return {
    id,
    name: typeof o.name === 'string' && o.name ? o.name : 'Vibe',
    dataPath: typeof o.dataPath === 'string' ? o.dataPath : '',
    thumbnailPath: typeof o.thumbnailPath === 'string' ? o.thumbnailPath : '',
    modelKeys,
    hasImage: typeof o.hasImage === 'boolean' ? o.hasImage : !!image,
    fingerprint:
      typeof o.fingerprint === 'string' && o.fingerprint ? o.fingerprint : vibeFingerprint(encodings),
    strength: clampVibeStrength(o.strength),
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    group: typeof o.group === 'string' ? o.group.trim() : '',
  };
}

async function migrateLegacyVibesInPlace(
  stored: unknown,
): Promise<{ migrated: number; error: unknown }> {
  const root = stored as { nai?: { vibes?: unknown } };
  const vibes = root?.nai?.vibes;
  if (!Array.isArray(vibes)) return { migrated: 0, error: null };
  const total = vibes.reduce((count, vibe) => count + (readLegacyVibeData(vibe) ? 1 : 0), 0);
  if (!total) return { migrated: 0, error: null };

  toastr.info(`检测到 ${total} 个旧版 Vibe，正在自动搬迁大文件…`, '柏宝绘');
  let migrated = 0;
  let firstError: unknown = null;
  for (let index = 0; index < vibes.length; index++) {
    const raw = vibes[index];
    const data = readLegacyVibeData(raw);
    if (!data) continue;
    const normalized = normalizeVibe(raw, index);
    if (!normalized) continue;
    try {
      const paths = await saveVibeFiles(data, null, normalized.id);
      vibes[index] = vibeMetaFromData(
        normalized.id,
        normalized.name,
        paths.dataPath,
        paths.thumbnailPath,
        data,
        normalized.strength,
        normalized.enabled,
        normalized.group,
      );
      migrated++;
      console.info(`[柏宝绘] 旧版 Vibe 自动搬迁 ${migrated}/${total}`);
    } catch (error) {
      firstError ??= error;
      console.error(`[柏宝绘] Vibe「${normalized.name}」自动搬迁失败`, error);
    }
  }
  if (firstError) {
    toastr.error('部分旧版 Vibe 搬迁失败，原数据已保留；刷新后会自动重试。', '柏宝绘');
    return { migrated, error: firstError };
  }
  toastr.success(`已自动修复 ${migrated} 个旧版 Vibe，后续加载将恢复正常。`, '柏宝绘');
  return { migrated, error: null };
}

/**
 * 存量迁移:早先负面词分「附加负面(negativePrompt)」+ 官方基线两段拼,现在合成
 * undesiredContent 一个框。老配置里的附加负面若不搬,升级后会静默失效(用户排除的
 * 内容悄悄回来了),故按当年的拼接顺序折进去:附加在前 + 该模型官方词在后。
 */
function foldLegacyNegative(o: Partial<NaiSettings>, model: NaiModel, def: string): string {
  if (typeof o.undesiredContent === 'string') return o.undesiredContent;
  const legacy = typeof o.negativePrompt === 'string' ? o.negativePrompt.trim() : '';
  if (!legacy) return def;
  return [legacy, naiDefaultUndesired(model)].filter(Boolean).join(', ');
}

/** 单条配方清洗:缺字段/类型不符逐项回退;prompt 允许空串(空槽位不是垃圾数据)。 */
function normalizeArtistPreset(raw: unknown, seq: number): NaiArtistPreset {
  const o = (raw ?? {}) as Partial<NaiArtistPreset>;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `art_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' && o.name ? o.name : `画师串 ${seq + 1}`,
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    // 存量条目没有这两个键:补空串 = 跟随渠道级,升级后提示词输出零变化
    quality: typeof o.quality === 'string' ? o.quality : '',
    negative: typeof o.negative === 'string' ? o.negative : '',
    // 可选键:非字符串/空串一律视为无预览(不落 undefined 以外的脏数据)
    previewPath:
      typeof o.previewPath === 'string' && o.previewPath ? o.previewPath : undefined,
  };
}

/**
 * 单条接入点清洗。官方条的 name/url 一律纠回内置值:UI 已禁掉改名与改址,
 * 还能出现别的值只有手改 settings.json 一途;纠回去也顺带让内置名随插件版本更新。
 * key 例外 —— 那是用户自己的密钥,内置的只是地址与名字。
 */
function normalizeNaiEndpoint(raw: unknown, seq: number): NaiEndpoint {
  const o = (raw ?? {}) as Partial<NaiEndpoint>;
  const id = typeof o.id === 'string' && o.id ? o.id : `nep_${Date.now()}_${seq}`;
  if (isOfficialNaiEndpoint(id)) return officialNaiEndpoint(typeof o.key === 'string' ? o.key : '');
  return {
    id,
    name: typeof o.name === 'string' && o.name ? o.name : `接入点 ${seq + 1}`,
    url: typeof o.url === 'string' ? o.url : '',
    key: typeof o.key === 'string' ? o.key : '',
  };
}

/**
 * 接入点列表的存量迁移与不变式兜底。
 *
 * 老配置只有渠道级 url/key 一对:收成第一条(名字按它指向官方还是第三方分别取),
 * 并保证内置官方那条一定在列——用户当初填的若是第三方站,官方条补在**其后**,
 * 免得静默把当前使用的那条挤到第二位、还顺手换了出图出口。
 */
function migrateNaiEndpoints(o: Partial<NaiSettings>): NaiEndpoint[] {
  const list = Array.isArray(o.endpoints) ? o.endpoints.map(normalizeNaiEndpoint) : [];

  if (!list.length) {
    // 存量:渠道级 url/key 收成第一条。url 恰是官方地址(绝大多数人)时直接并入官方条,
    // 不另起一条,否则列表一上来就是两条内容相同的。
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const key = typeof o.key === 'string' ? o.key : '';
    if (!url || url.replace(/\/+$/, '') === NAI_OFFICIAL_URL) return [officialNaiEndpoint(key)];
    return [{ id: `nep_legacy`, name: '我的接入点', url, key }, officialNaiEndpoint()];
  }

  // 官方条被删掉了(手改 settings.json,或以后版本回滚往返):补回去,但不抢当前那条的位置
  if (!list.some(e => isOfficialNaiEndpoint(e.id))) list.push(officialNaiEndpoint());
  return list;
}

function normalizeNai(raw: unknown, def: NaiSettings): NaiSettings {
  const conn = normalizeBackend(raw, def);
  const o = (raw ?? {}) as Partial<NaiSettings>;
  const stored = typeof o.model === 'string' ? o.model : '';
  const model = NAI_MODEL_VALUES.has(stored) ? (stored as NaiModel) : def.model;
  // 已下线模型(4.5 以下)静默回落会换掉画风与 vibe 编码 key。不弹窗(该人群已基本不存在),
  // 但留一条控制台告警 —— 否则「我的模型自己变了」这类反馈完全无据可查。
  if (stored && stored !== model) {
    console.warn(`[柏宝绘] NAI 模型「${stored}」已下线,本次回落为 ${model}`);
  }

  // 画师串库:允许为空,故没有「恒非空」兜底(与 normalizeComfyUI 刻意不同)
  const artistPresets = Array.isArray(o.artistPresets)
    ? o.artistPresets.map(normalizeArtistPreset)
    : def.artistPresets;
  const endpoints = migrateNaiEndpoints(o);
  // 悬空 id 一律清成空串(= 不使用)。**不**照抄 normalizeComfyUI 的「回落第一条」:
  // 用户删掉当前画师串后本该「什么都不加」,回落会给他静默换一套画风,而下拉显示的
  // 也正是那一条(看起来就是自己设的),几乎无法排查。
  // 清成空串同时让 activeArtistId ∈ {'', 用户库 id, 内置库 id} 成为不变式,面板无需再判悬空。
  const activeArtistId =
    typeof o.activeArtistId === 'string' &&
      (artistPresets.some(a => a.id === o.activeArtistId) || isBuiltinNaiArtist(o.activeArtistId))
      ? o.activeArtistId
      : '';

  return {
    ...conn,
    // 「附加负面」已并入 undesiredContent 一个框,存量值折进去(见 foldLegacyNegative)
    negativePrompt: '',
    // 接入点:存量 url/key 收成第一条;恒非空且必含官方条(见 migrateNaiEndpoints)。
    // 悬空 id 回落第一条——与画师串「悬空清空」相反:地址是必需品,清空就出不了图了。
    endpoints,
    activeEndpointId:
      typeof o.activeEndpointId === 'string' && endpoints.some(e => e.id === o.activeEndpointId)
        ? o.activeEndpointId
        : endpoints[0].id,
    // 存量字段:出图已不读它(走 effectiveNai),原样留着只为回滚时配置不丢
    key: typeof o.key === 'string' ? o.key : def.key,
    model,
    // 覆盖值:空串是有意义的存储值(=跟随模型官方词),故不能用 `&& o.x` 那种把 '' 吞掉的守卫
    undesiredContent: foldLegacyNegative(o, model, def.undesiredContent),
    sampler: typeof o.sampler === 'string' && o.sampler ? o.sampler : def.sampler,
    steps: Math.round(clampNumber(o.steps, def.steps, 1, 50)),
    scale: clampNumber(o.scale, def.scale, 0, 35),
    cfgRescale: clampNumber(o.cfgRescale, def.cfgRescale, 0, 1),
    noiseSchedule:
      typeof o.noiseSchedule === 'string' && o.noiseSchedule ? o.noiseSchedule : def.noiseSchedule,
    seed: Math.round(clampNumber(o.seed, def.seed, 0, 4294967295)),
    varietyBoost: typeof o.varietyBoost === 'boolean' ? o.varietyBoost : def.varietyBoost,
    normalizeRefStrength:
      typeof o.normalizeRefStrength === 'boolean' ? o.normalizeRefStrength : def.normalizeRefStrength,
    concurrency: Math.round(clampNumber(o.concurrency, def.concurrency, 1, 4)),
    vibes: Array.isArray(o.vibes)
      ? o.vibes.map((v, i) => normalizeVibe(v, i)).filter((v): v is NaiVibe => v !== null)
      : def.vibes,
    artistPresets,
    activeArtistId,
    // 老配置缺这两个字段:回落默认 = 开着自然语言、不锁方向,即改动前的行为
    naturalLanguage: typeof o.naturalLanguage === 'boolean' ? o.naturalLanguage : def.naturalLanguage,
    orientationLock: normalizeOrientationLock(o.orientationLock),
  };
}

/**
 * 把用户输入规整成可安全拼进正则的标签名(与柏宝书 settings.ts 的 sanitizeTagName 同口径)。
 * 用黑名单(而非白名单)剔除会破坏标签语法/正则的危险字符:尖括号、斜杠、空白、正则元字符;
 * 中文及其它 unicode 字母一律保留(用户可能写 <雪><状态栏> 这类中文标签)。
 */
export function sanitizeTagName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^<\/?/, '') // 开头的 < 或 </
    .replace(/>$/, '') // 结尾的 >
    .trim()
    .replace(/[<>/\\\s.*+?^${}()|[\]]/g, ''); // 剔除尖括号/斜杠/空白/正则元字符,中文等保留
}

/** 排除名单清洗(与柏宝书 normalize 同口径):去空、去重、标签名消毒;缺字段/类型不符回退空数组。 */
function normalizeExcludes(raw: unknown): ExcludesSettings {
  const d = excludesDefaults();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<ExcludesSettings>;
  return {
    excludedChars: Array.isArray(r.excludedChars)
      ? r.excludedChars.filter((x): x is string => typeof x === 'string')
      : d.excludedChars,
    excludedWorldNames: Array.isArray(r.excludedWorldNames)
      ? r.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : d.excludedWorldNames,
    excludedWorldInfoPatterns: Array.isArray(r.excludedWorldInfoPatterns)
      ? r.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : d.excludedWorldInfoPatterns,
    customStripTags: Array.isArray(r.customStripTags)
      ? Array.from(
        new Set(
          r.customStripTags
            .filter((x): x is string => typeof x === 'string')
            .map(sanitizeTagName)
            .filter(Boolean),
        ),
      )
      : d.customStripTags,
  };
}

/** 把任意来源的原始对象并入默认值,容错缺字段/类型不符。 */
function normalize(raw: unknown): ImageSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const r = raw as Partial<ImageSettings>;
  const merged: ImageSettings = { ...d, ...r };
  // ui 是嵌套对象,展开合并不会补全缺字段,逐字段兜底
  const ru = (r.ui ?? {}) as Partial<UiPrefs>;
  merged.ui = {
    theme: typeof ru.theme === 'string' ? ru.theme : d.ui.theme,
    navPosition: typeof ru.navPosition === 'string' ? ru.navPosition : d.ui.navPosition,
    navTapClose: typeof ru.navTapClose === 'boolean' ? ru.navTapClose : d.ui.navTapClose,
    showTopBar: typeof ru.showTopBar === 'boolean' ? ru.showTopBar : d.ui.showTopBar,
    showOrb: typeof ru.showOrb === 'boolean' ? ru.showOrb : d.ui.showOrb,
    orbImage: typeof ru.orbImage === 'string' ? ru.orbImage : d.ui.orbImage,
    orbShape: typeof ru.orbShape === 'string' ? ru.orbShape : d.ui.orbShape,
    // 透明度:钳到 20–100,缺失/非法回退默认(太低会看不见,设 20 下限)
    orbOpacity:
      typeof ru.orbOpacity === 'number' && Number.isFinite(ru.orbOpacity)
        ? Math.min(100, Math.max(20, Math.round(ru.orbOpacity)))
        : d.ui.orbOpacity,
    // 尺寸:钳到 32–80,缺失/非法回退默认
    orbSize:
      typeof ru.orbSize === 'number' && Number.isFinite(ru.orbSize)
        ? Math.min(80, Math.max(32, Math.round(ru.orbSize)))
        : d.ui.orbSize,
    cardTheme: typeof ru.cardTheme === 'string' ? ru.cardTheme : d.ui.cardTheme,
    autoCollapseImages:
      typeof ru.autoCollapseImages === 'boolean' ? ru.autoCollapseImages : d.ui.autoCollapseImages,
    // 老配置缺字段 → 默认档(中)。不为「保持铺满」做迁移:铺满正是要修的问题,想要回去下拉里选
    imageDisplaySize: IMAGE_DISPLAY_SIZES.some(option => option.value === ru.imageDisplaySize)
      ? (ru.imageDisplaySize as ImageDisplaySize)
      : d.ui.imageDisplaySize,
  };
  // webui 已隐藏:存量数据里的 'webui' 一律迁移到默认后端(否则规范/出图口径会落空)
  merged.defaultBackend =
    merged.defaultBackend === 'comfyui' || merged.defaultBackend === 'nai'
      ? merged.defaultBackend
      : d.defaultBackend;
  merged.webui = normalizeBackend(r.webui, d.webui);
  merged.comfyui = normalizeComfyUI(r.comfyui, d.comfyui);
  merged.nai = normalizeNai(r.nai, d.nai);
  // 副 API 渠道:逐个补全字段并校验类型
  merged.channels = (Array.isArray(r.channels) ? r.channels : []).map(normalizeChannel);
  // 任务指派:嵌套对象,逐字段兜底(老数据没有 assignments 键时回退空串=跟随主 API)
  const ra = (r.assignments ?? {}) as Partial<{ tagGen: string }>;
  merged.assignments = { tagGen: typeof ra.tagGen === 'string' ? ra.tagGen : '' };
  merged.worldBooks = {
    enabled: r.worldBooks?.enabled === true,
    includeTavern: r.worldBooks?.includeTavern === true,
    names: Array.isArray(r.worldBooks?.names)
      ? [...new Set(r.worldBooks.names.filter((n): n is string => typeof n === 'string').map(n => n.trim()).filter(Boolean))]
      : [],
  };
  const rt = (r.autoTag ?? {}) as Partial<AutoTagSettings>;
  // 存量配置只有 maxImages:缺少 minImages 时回落 0,完整保留「没好画面可以不出图」的旧行为。
  // 先归一化上限,再把下限夹进 [0,上限],保证所有后续调用都能直接依赖范围不变式。
  const maxImages =
    typeof rt.maxImages === 'number' && Number.isFinite(rt.maxImages)
      ? Math.max(1, Math.floor(rt.maxImages))
      : d.autoTag.maxImages;
  const minImages =
    typeof rt.minImages === 'number' && Number.isFinite(rt.minImages)
      ? Math.min(maxImages, Math.max(0, Math.floor(rt.minImages)))
      : d.autoTag.minImages;
  merged.autoTag = {
    dshSession: rt.dshSession === true,
    dshDedicated: rt.dshDedicated === true,
    dshUserMessages: rt.dshUserMessages === true,
    dshRuleSource: rt.dshRuleSource === 'skill' ? 'skill' : 'plugin',
    dshSkillRequest: typeof rt.dshSkillRequest === 'string' ? rt.dshSkillRequest : DEFAULT_DSH_SKILL_REQUEST,
    ...(rt.dshDedicatedState && typeof rt.dshDedicatedState.instanceId === 'string' && /^[a-f0-9-]{32,36}$/i.test(rt.dshDedicatedState.instanceId)
      ? { dshDedicatedState: { instanceId: rt.dshDedicatedState.instanceId,
        bindings: Object.fromEntries(Object.entries(rt.dshDedicatedState.bindings ?? {}).filter(([,binding]) => binding && typeof binding.session_id === 'string' && !!binding.session_id.trim()).map(([key,binding]) => [key,{session_id:binding.session_id,initialized:binding.initialized===true,...(typeof binding.rulesHash==='string' ? {rulesHash:binding.rulesHash} : {}),...(typeof binding.atlasHash==='string' && /^[a-f0-9]{64}$/.test(binding.atlasHash) ? {atlasHash:binding.atlasHash} : {})}])) } } : {}),
    enabled: typeof rt.enabled === 'boolean' ? rt.enabled : d.autoTag.enabled,
    contextMessages:
      typeof rt.contextMessages === 'number' && Number.isFinite(rt.contextMessages)
        ? Math.max(1, Math.floor(rt.contextMessages))
        : d.autoTag.contextMessages,
    minImages,
    maxImages,
    retryCount:
      typeof rt.retryCount === 'number' && Number.isFinite(rt.retryCount)
        ? Math.min(5, Math.max(0, Math.floor(rt.retryCount)))
        : d.autoTag.retryCount,
    autoGenerate:
      typeof rt.autoGenerate === 'boolean' ? rt.autoGenerate : d.autoTag.autoGenerate,
    // 可编辑提示词集:逐字段兜底;旧版 jailbreakPrompt 字段迁移进 prompts.jailbreak
    prompts: (() => {
      const rp = (rt.prompts ?? {}) as Partial<AutoTagPrompts>;
      // 旧字段不在类型里,从原始对象读取(老版本设置才带)
      const legacy = rt as Partial<AutoTagSettings> & { jailbreakPrompt?: unknown };
      const legacyJailbreak = typeof legacy.jailbreakPrompt === 'string' ? legacy.jailbreakPrompt : '';
      // 旧版单份 thinking 拆成三份(comfy/nai/naiV5)。老内容一律是照 ComfyUI 形态写的
      // (单串 tag + 邻接绑定),只迁进同形态的 comfy 与 nai 两格;V5 留空回落新默认——
      // 把 ComfyUI 口径灌进 V5 等于把「思维链教它做规范禁止的事」这个 bug 固化下来。
      const legacyPrompts = rp as Partial<AutoTagPrompts> & { thinking?: unknown };
      const legacyThinking =
        typeof legacyPrompts.thinking === 'string' ? legacyPrompts.thinking : '';
      return {
        jailbreak: typeof rp.jailbreak === 'string' ? rp.jailbreak : legacyJailbreak,
        naiSpec: typeof rp.naiSpec === 'string' ? rp.naiSpec : '',
        naiV5Spec: typeof rp.naiV5Spec === 'string' ? rp.naiV5Spec : '',
        comfySpec: typeof rp.comfySpec === 'string' ? rp.comfySpec : '',
        comfyThinking: typeof rp.comfyThinking === 'string' ? rp.comfyThinking : legacyThinking,
        naiThinking: typeof rp.naiThinking === 'string' ? rp.naiThinking : legacyThinking,
        naiV5Thinking: typeof rp.naiV5Thinking === 'string' ? rp.naiV5Thinking : '',
      };
    })(),
  };
  merged.excludes = normalizeExcludes(r.excludes);
  // 存储行为:嵌套对象逐字段兜底(老数据无 storage 键 → 默认关)
  const rs = (r.storage ?? {}) as Partial<StoragePrefs>;
  merged.storage = {
    saveAsJpeg: typeof rs.saveAsJpeg === 'boolean' ? rs.saveAsJpeg : d.storage.saveAsJpeg,
  };
  merged.manga = normalizeManga(r.manga);
  return merged;
}

// import 阶段 ST 往往尚未就绪,先以默认值建 reactive;真实值由 hydrateSettings 灌入。
export const settings = reactive<ImageSettings>(defaults());

// 守门标志:hydrate 完成前不回写,避免「默认值」覆盖服务器上已存的设置。
let ready = false;

// hydrate 完成后要通知的订阅者(如 ui.ts:settings 就绪后才能拿到同步过来的主题/导航位置)。
// 若订阅时已就绪则立刻回调,避免错过时序。
const readyCbs: Array<() => void> = [];
export function onSettingsReady(cb: () => void): void {
  if (ready) cb();
  else readyCbs.push(cb);
}

function applyInto(target: ImageSettings, src: ImageSettings): void {
  target.enabled = src.enabled;
  target.ui = src.ui;
  target.defaultBackend = src.defaultBackend;
  target.webui = src.webui;
  target.comfyui = src.comfyui;
  target.nai = src.nai;
  target.channels = src.channels;
  target.assignments = src.assignments;
  target.autoTag = src.autoTag;
  target.worldBooks = src.worldBooks;
  target.excludes = src.excludes;
  target.storage = src.storage;
  target.manga = src.manga;
}

/* —— 渠道共享存储:与柏宝书等「柏宝」插件共用同一份渠道列表 ——
   真身存在 extensionSettings[SHARED_CHANNELS_KEY](带 revision),各插件的设置里只留镜像。
   任一端写入后广播事件,其他端收到后从 extensionSettings 重读并应用,实现跨插件实时同步。 */
const SHARED_CHANNELS_KEY = 'baibai_api_channels';
const SHARED_CHANNELS_EVENT = 'st-baibai-api-channels:changed';
const SHARED_CHANNELS_SCHEMA_VERSION = 1;

interface SharedChannelsStore {
  schemaVersion: number;
  revision: number;
  channels: ApiChannel[];
}

let sharedChannelsFingerprint = '';
let sharedChannelsRevision = 0;
let sharedChannelsListenerBound = false;

function channelFingerprint(channels: ApiChannel[]): string {
  return JSON.stringify(channels);
}

function readSharedChannels(raw: unknown): SharedChannelsStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedChannelsStore>;
  if (!Array.isArray(store.channels)) return null;
  return {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    channels: store.channels.map(normalizeChannel),
  };
}

function writeSharedChannels(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedChannelsRevision += 1;
  const store: SharedChannelsStore = {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision: sharedChannelsRevision,
    channels: JSON.parse(JSON.stringify(settings.channels)) as ApiChannel[],
  };
  ctx.extensionSettings[SHARED_CHANNELS_KEY] = store;
  sharedChannelsFingerprint = channelFingerprint(store.channels);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_CHANNELS_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applySharedChannels(store: SharedChannelsStore): void {
  const fingerprint = channelFingerprint(store.channels);
  sharedChannelsRevision = Math.max(sharedChannelsRevision, store.revision);
  if (fingerprint === sharedChannelsFingerprint) return;
  settings.channels = store.channels;
  sharedChannelsFingerprint = fingerprint;

  // 被指派的渠道已不在共享列表里 → 清掉指派(回落跟随主 API)
  const ids = new Set(settings.channels.map(channel => channel.id));
  if (settings.assignments.tagGen && !ids.has(settings.assignments.tagGen)) {
    settings.assignments.tagGen = '';
  }
}

function bindSharedChannelsListener(): void {
  if (sharedChannelsListenerBound) return;
  sharedChannelsListenerBound = true;
  window.addEventListener(SHARED_CHANNELS_EVENT, () => {
    const ctx = getContext();
    const store = readSharedChannels(ctx?.extensionSettings?.[SHARED_CHANNELS_KEY]);
    if (store) applySharedChannels(store);
  });
}

/**
 * 渠道共享存储接管(消费者模式,参照柏宝砚/ST-BaiBai-Pen 的共享渠道协议):
 * - 共享存储存在 → 领养;
 * - 不存在且本插件已有渠道(绘单装用户配过)→ 以自身为种子建仓;
 * - 不存在且本插件也没有渠道 → **不建仓**,只同步内存指纹。
 *   空渠道列表绝不创建共享存储,防止空 store 占位后被书领养、双方同步成空。
 */
function hydrateSharedChannels(legacyChannels: ApiChannel[]): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedChannels(ctx.extensionSettings[SHARED_CHANNELS_KEY]);
  if (stored) {
    applySharedChannels(stored);
  } else {
    settings.channels = legacyChannels.map(normalizeChannel);
    sharedChannelsFingerprint = channelFingerprint(settings.channels);
    // 已有渠道才允许建仓;空列表不建仓(消费者模式,等书或用户改动时再建)
    if (settings.channels.length > 0) writeSharedChannels(false);
  }
  bindSharedChannelsListener();
}

/* ============ 排除设置共享存储(与柏宝书共用,协议与渠道完全同构) ============ */

const SHARED_EXCLUDES_KEY = 'baibai_exclude_settings';
const SHARED_EXCLUDES_EVENT = 'st-baibai-exclude-settings:changed';
const SHARED_EXCLUDES_SCHEMA_VERSION = 1;

interface SharedExcludesStore {
  schemaVersion: number;
  revision: number;
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  customStripTags: string[];
}

let sharedExcludesFingerprint = '';
let sharedExcludesRevision = 0;
let sharedExcludesListenerBound = false;

function excludesFingerprint(ex: ExcludesSettings): string {
  return JSON.stringify([
    ex.excludedChars,
    ex.excludedWorldNames,
    ex.excludedWorldInfoPatterns,
    ex.customStripTags,
  ]);
}

/** 判断名单里除内置默认条目名规则(mvu)外,是否还有任何用户数据。 */
function excludesHasUserData(ex: ExcludesSettings): boolean {
  const patterns = ex.excludedWorldInfoPatterns.filter(p => !DEFAULT_WI_PATTERNS.includes(p));
  return (
    ex.excludedChars.length > 0 ||
    ex.excludedWorldNames.length > 0 ||
    patterns.length > 0 ||
    ex.customStripTags.length > 0
  );
}

/** 从共享存储原样读出四名单,逐名单按 normalizeExcludes 同口径清洗(缺字段/类型不符回退空数组)。 */
function readSharedExcludes(raw: unknown): SharedExcludesStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedExcludesStore>;
  if (!Array.isArray(store.excludedChars)) return null;
  const normalized = normalizeExcludes({
    excludedChars: store.excludedChars,
    excludedWorldNames: store.excludedWorldNames,
    excludedWorldInfoPatterns: store.excludedWorldInfoPatterns,
    customStripTags: store.customStripTags,
  });
  return {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    ...normalized,
  };
}

function writeSharedExcludes(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedExcludesRevision += 1;
  const store: SharedExcludesStore = {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision: sharedExcludesRevision,
    ...JSON.parse(JSON.stringify(settings.excludes)) as ExcludesSettings,
  };
  ctx.extensionSettings[SHARED_EXCLUDES_KEY] = store;
  sharedExcludesFingerprint = excludesFingerprint(store);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_EXCLUDES_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applySharedExcludes(store: SharedExcludesStore): void {
  const fingerprint = excludesFingerprint(store);
  sharedExcludesRevision = Math.max(sharedExcludesRevision, store.revision);
  if (fingerprint === sharedExcludesFingerprint) return;
  settings.excludes = {
    excludedChars: store.excludedChars,
    excludedWorldNames: store.excludedWorldNames,
    excludedWorldInfoPatterns: store.excludedWorldInfoPatterns,
    customStripTags: store.customStripTags,
  };
  sharedExcludesFingerprint = fingerprint;
}

function bindSharedExcludesListener(): void {
  if (sharedExcludesListenerBound) return;
  sharedExcludesListenerBound = true;
  window.addEventListener(SHARED_EXCLUDES_EVENT, () => {
    const ctx = getContext();
    const store = readSharedExcludes(ctx?.extensionSettings?.[SHARED_EXCLUDES_KEY]);
    if (store) applySharedExcludes(store);
  });
}

/**
 * 排除设置共享存储接管(消费者模式,参照柏宝砚/ST-BaiBai-Pen 的共享渠道协议):
 * - 共享存储存在 → 领养共享数据;
 * - 共享存储不存在但本插件名单已有用户数据 → 以本插件名单为种子建仓(绘单装用户);
 * - 共享存储不存在且本插件也没有用户数据 → **不建仓**,只在本地播种内置默认规则。
 *   没有数据的一方绝不创建共享存储,防止空 store 占位后被书领养、双方互相同步成空。
 * 播种只在「无存储」时发生,天然满足「只发一次、删了不补回」。
 */
function hydrateSharedExcludes(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedExcludes(ctx.extensionSettings[SHARED_EXCLUDES_KEY]);
  if (stored) {
    // 领同居中:共享存储存在但无用户数据(疑似早期版本空种子),本插件却有数据 → 以本插件为准回写,
    // 修复历史遗留的空 store(回写广播后书会领养真实数据)。
    if (!excludesHasUserData(stored) && excludesHasUserData(settings.excludes)) {
      writeSharedExcludes(true);
    } else {
      applySharedExcludes(stored);
    }
  } else {
    // 本地播种内置默认条目名规则(绘单装时开箱即用)
    for (const pat of DEFAULT_WI_PATTERNS) {
      if (!settings.excludes.excludedWorldInfoPatterns.includes(pat)) {
        settings.excludes.excludedWorldInfoPatterns.push(pat);
      }
    }
    sharedExcludesFingerprint = excludesFingerprint(settings.excludes);
    // 名单里已有用户数据才允许建仓;空名单不建仓(消费者模式,等书或用户改动时再建)
    if (excludesHasUserData(settings.excludes)) writeSharedExcludes(false);
  }
  bindSharedExcludesListener();
}

/* ============ 排除角色闸门(与柏宝书 isCurrentChatExcluded 同口径) ============ */

/** 当前单角色聊天的角色名;群聊或未进入聊天时返回 null(群聊不参与排除)。 */
function currentCharName(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊:多角色,不按单名排除
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  return ch?.name ?? null;
}

/**
 * 当前聊天是否被排除(该角色名在排除名单里)。被排除则自动 tag 全流程停用。
 * 按「名字」匹配:同名的重名卡会被一并排除——与柏宝书排除角色的口径完全一致。
 */
export function isCurrentChatExcluded(): boolean {
  if (!settings.excludes.excludedChars.length) return false;
  const name = currentCharName();
  return name !== null && settings.excludes.excludedChars.includes(name);
}

/** 写回 extension_settings 并防抖落盘到服务器(跨设备同步的关键)。 */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
  // 渠道有改动 → 同步写共享存储并广播(指纹比对防回环)
  const fingerprint = channelFingerprint(settings.channels);
  if (fingerprint !== sharedChannelsFingerprint) writeSharedChannels();
  // 排除名单有改动 → 同步写共享存储并广播(指纹比对防回环)
  const exFingerprint = excludesFingerprint(settings.excludes);
  if (exFingerprint !== sharedExcludesFingerprint) writeSharedExcludes();
  ctx.saveSettingsDebounced?.();
}

/**
 * ST 就绪后调用:从 extension_settings 载入真实设置并放行 watch 回写。
 * 可安全重复调用(只在首次真正 hydrate)。
 */
export async function hydrateSettings(): Promise<void> {
  if (ready) return;
  const ctx = getContext();
  if (!ctx?.extensionSettings) return; // ST 未就绪,稍后重试

  const stored = ctx.extensionSettings[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    const migration = await migrateLegacyVibesInPlace(stored);
    if (migration.error) {
      if (migration.migrated) ctx.saveSettingsDebounced?.();
      throw migration.error;
    }
    applyInto(settings, normalize(stored));
    if (migration.migrated) {
      ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
      ctx.saveSettingsDebounced?.();
    }
  } else {
    // 把默认值写进 extension_settings,确立同步源
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
    ctx.saveSettingsDebounced?.();
  }

  // 渠道列表改由共享存储接管(存在则以共享为准,不存在则以自身为种子写入)
  hydrateSharedChannels(settings.channels);

  // 排除名单同样改由共享存储接管(创建时播种内置默认条目名规则)
  hydrateSharedExcludes();

  ready = true;
  for (const cb of readyCbs.splice(0)) {
    try {
      cb();
    } catch {
      /* 订阅者自身异常不阻断后续 */
    }
  }
}

watch(
  settings,
  () => {
    if (!ready) return; // hydrate 前不回写,防止默认值覆盖服务器设置
    persist();
  },
  { deep: true },
);
