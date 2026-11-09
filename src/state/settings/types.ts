import type { OrientationLock, SizePair } from '@/backends/size';
import type { ComfyPresetMode, ComfySimpleConfig } from '@/backends/comfyTemplates';
import type { NaiSettings } from './naiTypes';
import type { MangaSettings } from '@/manga/layouts';
/**
 * 柏宝绘设置(全局,跨聊天)。存进 ST 的 extension_settings(→ 服务器 settings.json),
 * 因而跨设备同步:手机/局域网另一端打开同一 ST 账户即可见到同一份设置。
 */

/** 生图后端 */
export type BackendId = 'webui' | 'comfyui' | 'nai';

/** 各后端共有骨架:连接 + 出图参数。具体参数后面按后端加。 */
export interface BackendConn {
  /** 服务地址,如 http://127.0.0.1:7860 */
  url: string;
  /** 正面质量词。语义按后端各自解释:webui 骨架期仅存值未生效;
   *  nai 视为覆盖值——留空则按模型取官方质量词(见 nai.ts naiDefaultQualityTags)。 */
  qualityTags: string;
  /** 负面提示词。webui 骨架期仅存值未生效;nai 已并入 undesiredContent,只留作存量迁移来源。 */
  negativePrompt: string;
  /** 分辨率,如 832×1216。webui 骨架期仅存值;comfyui/nai 已改用下面的横竖两格。 */
  resolution: string;
  /** 竖屏尺寸,如 832×1216。模型判定为竖屏(单人/特写/立绘)的画面用它。
   *  comfyui 已下沉到单套工作流(见 ComfyWorkflowPreset),这里只留作存量迁移来源。 */
  portraitSize: string;
  /** 横屏尺寸,如 1216×832。模型判定为横屏(群像/远景/全景)的画面用它。
   *  comfyui 同上,只留作存量迁移来源。 */
  landscapeSize: string;
}

/**
 * 一套具名工作流。除 JSON 外还带着「这套底模要什么」——切过去即全套生效。
 *
 * 为什么自然语言开关与横竖尺寸归预设而非渠道:它们本质是底模的属性。
 * Illustrious/Pony 吃 danbooru 短 tag、832×1216;Flux/SD3.5 吃自然语言、1024 方图。
 * 留在渠道级的话,每次切工作流都得再手改两处,「切换」这件事就只做了一半。
 * url 反过来仍是渠道级(一台 ComfyUI 服务器跑所有工作流)。
 */
export interface ComfyWorkflowPreset extends SizePair {
  id: string;
  /** 显示名(下拉列表与切换用;允许重名,以 id 为键)。 */
  name: string;
  /**
   * 配置方式,两模式互斥:
   * - custom:粘贴 Save (API Format) 的 JSON,动态值用 %prompt% 等占位符;
   * - simple:选模型/LoRA + 填基础参数,出图时由 comfyTemplates 组装 JSON,无占位符。
   */
  mode: ComfyPresetMode;
  /** custom 模式的工作流 JSON;simple 模式下保留但不生效(切回不丢)。 */
  workflow: string;
  /** simple 模式的参数;custom 模式下保留但不生效(切回不丢)。 */
  simple: ComfySimpleConfig;
  /** 生成自然语言:开=自动 tag 以连贯短句写正向提示词(Flux/SD3.5 等);关=逗号分隔 tag。 */
  naturalLanguage: boolean;
  /** AI 生成动态负面词；未设置或关闭时只使用工作流固定负面。 */
  generateNegative?: boolean;
  /** 画幅锁:auto = 由自动 tag 判定横竖;portrait/landscape = 这套工作流一律出该方向(见 size.ts)。 */
  orientationLock: OrientationLock;
}

/**
 * 出图/测试连接实际需要的字段:渠道级 url + 当前预设派生(见 effectiveComfyConn)。
 *
 * backends/comfyui.ts 只认这个收窄后的形状,不认整个 ComfyUISettings——
 * 后端层拿到的应该是「这一次出图用什么」,而不是「用户存了几套工作流」。
 */
export interface ComfyRunConn extends SizePair {
  url: string;
  /** 浏览器取图格式；原始输出文件仍留在 ComfyUI。 */
  imageFormat?: 'original' | 'jpeg';
  workflow: string;
  mode: ComfyPresetMode;
  simple: ComfySimpleConfig;
}

/** ComfyUI 连接与工作流库。 */
export interface ComfyUISettings extends BackendConn {
  imageFormat: 'original' | 'jpeg';
  /** 工作流库。**不变式:恒非空**(至少一条,见 normalizeComfyUI 收尾兜底)。 */
  workflows: ComfyWorkflowPreset[];
  /** 当前使用的工作流 id;指向已删条目时由 normalize 回落到第一条。 */
  activeWorkflowId: string;
}

/** 界面偏好里要跨设备同步的部分;activePage 等纯本机临时态不在此。 */
export interface UiPrefs {
  /** 主题名(合法值见 state/ui.ts 的 THEMES;这里只存字符串,避免 settings 反向依赖 ui) */
  theme: string;
  /** 导航位置:top/bottom/auto */
  navPosition: string;
  /** 移动端:再点当前页导航按钮即关闭整窗。默认开;怕误触的用户可关。 */
  navTapClose: boolean;
  /** 在 ST 顶栏注入一个快速打开按钮(魔杖菜单入口照旧保留)。默认关。 */
  showTopBar: boolean;
  /** 屏幕边缘悬浮球,点击打开柏宝绘。默认关。 */
  showOrb: boolean;
  /** 悬浮球自定义图标(ST 服务器图片路径;空=默认画笔图标)。跨设备同步。 */
  orbImage: string;
  /** 悬浮球形状:bookmark 书签(默认)/ circle 圆 / square 方。 */
  orbShape: string;
  /** 悬浮球静止时不透明度(百分比 20–100,默认 62)。唤起/拖动时一律全显。 */
  orbOpacity: number;
  /** 悬浮球基准尺寸(px,32–80,默认 48)。 */
  orbSize: number;
  /**
   * 楼层卡片主题(合法值同 theme,见 state/ui.ts 的 THEMES)。
   * 默认 'st' = 从宿主 --SmartTheme* 派生,卡片融进当前 ST 配色;
   * 想让卡片走柏宝绘品牌观感就选 night/pastel 等。与设置窗口主题(theme)分开,
   * 因为两者诉求不同:窗口是独立界面,卡片嵌在聊天流里。
   */
  cardTheme: string;
  /**
   * 楼层图片默认折叠:开启后卡片默认收成一条细条(点击展开),适合公共场合防窥。
   * 只是「默认」——卡片上手动展开/折叠过的槽位以手动状态为准(会话内,见 floor/collapseState.ts)。
   */
  autoCollapseImages: boolean;
  /**
   * 楼层图片显示大小(合法值见 IMAGE_DISPLAY_SIZES)。只管聊天里显示多大,
   * 与出图分辨率、横竖方向无关,生成的文件一字节不变。
   */
  imageDisplaySize: ImageDisplaySize;
}

/** 楼层图片显示大小。 */
export type ImageDisplaySize = 'small' | 'medium' | 'large' | 'full';

/**
 * 副 API 渠道(OpenAI 兼容)。结构与柏宝书完全一致:渠道列表通过共享存储
 * (extensionSettings['baibai_api_channels'])在各「柏宝」插件间同步——
 * 在柏宝书里配好的渠道,这里直接可用;任一端增删改,另一端实时跟随。
 */
export interface ApiChannel {
  id: string;
  /** 显示名 */
  name: string;
  /** OpenAI 兼容的 base url,如 https://api.openai.com/v1 */
  url: string;
  /** 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token */
  maxTokens: number;
  /** 单次请求超时(秒)。超过后主动中断;每个渠道独立配置,默认 180 秒。 */
  timeoutSec: number;
  /** 流式传输(默认关);开启后按 SSE 增量拼接 */
  stream: boolean;
  /** 排除参数:这些字段名会在构造请求体时从 body 中删除,
   *  用于规避不接受某些参数(如 temperature/max_tokens)的兼容端点报错。 */
  excludeParams: string[];
  /**
   * 思考强度(推理模型的 reasoning_effort)。空串 = auto = 不发这个参数(默认,老渠道即此值)。
   *
   * 取值不做白名单校验,原样发给端点:各家词汇不统一(OpenAI 的 minimal/low/medium/high/xhigh、
   * 部分中转站的 max/none……),中转站比我们更清楚自己的模型吃什么,校验只会误伤。
   *
   * 非空时整条请求改走 custom 源(见 api/client.ts 的 buildRequestBody):
   * ST 代理对 openai 源的 reasoning_effort 有**模型名白名单**(src/constants.js 的
   * OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),模型名对不上就**静默丢弃且照样返回 200**——
   * 用户设了却毫无效果、还看不出来。custom 源的 custom_include_body 是纯 merge,不过白名单。
   *
   * ⚠️ 跨插件:本字段是绘独有的,柏宝书 ≤ 当前版本的 normalizeChannel 是「逐字段重建对象」,
   * 不认识的键会被丢掉。在书里**新增/编辑/删除渠道**、或**点测试渠道**(可能自动改写 url)
   * 会触发共享存储回写,进而抹掉本字段。只开书、或在书里改摘要/提示词/排除名单则不受影响。
   * 等书那边补上同名字段后此风险消失。
   */
  reasoningEffort: string;
}

export interface AutoTagSettings {
  /** Only the tag-generation task uses a persistent DSH bridge; ordinary channels are unchanged. */
  dshSession?: boolean;
  /** Send DSH request messages as user without changing their fixed/dynamic grouping. */
  dshUserMessages?: boolean;
  /** Reuse one plugin-owned DSH conversation, with each task isolated by the bridge. */
  dshDedicated?: boolean;
  /** Applies only to DSH MOSS manga planning; Skill owns spec/check, host keeps its protocol. */
  dshRuleSource?: 'plugin' | 'skill';
  /** Per-generation Skill request text; {{skill_id}} resolves from the bridge binding. */
  dshSkillRequest?: string;
  dshDedicatedState?: {
    instanceId: string;
    bindings: Record<string, { session_id: string; initialized: boolean; rulesHash?: string; atlasHash?: string }>;
  };
  /** 新 AI 正文落地后自动请求模型。 */
  enabled: boolean;
  /** 发送最近多少个 AI 故事楼及其间 user 楼的清洗后正文；目标楼计入数量。 */
  contextMessages: number;
  /** 单楼要求模型返回的最少画面数；0 = 允许没有值得绘制的画面。 */
  minImages: number;
  /** 单楼允许模型选择的最大画面数。 */
  maxImages: number;
  /** 生成失败自动重试次数(请求异常或返回无法解析都算),0 = 不重试,默认 1。 */
  retryCount: number;
  /** 写入 tag 后是否立即调用出图渠道自动生成图片(默认开;关闭则卡片上手动点「生成」)。 */
  autoGenerate: boolean;
  /** 可编辑提示词集(破限/后端规范/思维链);空串 = 回落内置默认。 */
  prompts: AutoTagPrompts;
}

/**
 * 排除设置(镜像共享存储;真身在 extensionSettings['baibai_exclude_settings'])。
 * 与柏宝书共用同一份名单、同一套匹配口径:任一端改动自动同步,双端行为一致。
 */
/** 落盘存储行为(影响新生成图片的保存格式)。 */
export interface StoragePrefs {
  /**
   * 新图统一转存 JPG(固定质量 0.9)再落盘,不再保存 PNG。
   * 体积约为 PNG 的 10–20%;代价是图内嵌的生成参数(NAI tEXt / ComfyUI 工作流块,
   * 即「拖回官方站复现」依赖的信息)随转码丢失——提示词与种子仍保存在 extra 里,
   * 但无法再从图片本身提取。仅影响新图,存量 PNG 不动;转码失败自动回退 PNG。
   */
  saveAsJpeg: boolean;
}

export interface ExcludesSettings {
  /** 排除的角色名:这些名字(含重名卡)的聊天里,自动 tag 全流程停用(与柏宝书记忆停用同名单)。 */
  excludedChars: string[];
  /** 整本排除的世界书文件名:这些书的所有激活条目都不进 tag 生成的副 API 参考(仅影响副 API)。 */
  excludedWorldNames: string[];
  /** 按条目名(comment)过滤的规则:命中任一规则的条目不进副 API 参考。
   *  每条当正则编译(普通名字天然=包含匹配),编译失败降级为字面子串包含。 */
  excludedWorldInfoPatterns: string[];
  /** 自定义清洗标签(只填标签名,不带尖括号,如 snow):清洗正文时
   *  <snow>…</snow> 连同内部内容一并删掉。与柏宝书共用名单。 */
  customStripTags: string[];
}

/**
 * 自动 tag 请求的可编辑提示词集。各条留空 = 回落内置默认(与柏宝书自定义提示词同口径)。
 *
 * ⚠ 键名与设置页标签不是一一对应的:设置页里的「NAI 规范 / NAI 思维链」实际存在
 * naiV5Spec / naiV5Thinking(历史命名),而同名的 naiSpec / naiThinking 是 4.5 以下
 * 那套单串 tag 版本 —— 已随模型列表收窄下线,无 UI 入口。键一律保留,免得动存量设置。
 *
 * 规范与思维链(两个后端都是)支持自然语言条件段:{{#nl}}…{{/nl}} 只在开启「生成自然语言」
 * 时保留,{{^nl}}…{{/nl}} 只在关闭时保留(展开见 autoTag/prompt.ts 的 expandNlSections)。
 * NAI 的两份内置默认靠它在开关两侧共用一份文本;开启侧展开后与 0.3.0 的内置文本逐字相同。
 */
export interface AutoTagPrompts {
  /** 破限词:置顶 system,降低副 API 拒答率。 */
  jailbreak: string;
  /** 【已下线,无 UI 入口】NAI 4 系及以下的单串 tag 规范;回落 DEFAULT_NAI_SPEC。 */
  naiSpec: string;
  /** NAI 规范(4.5/V5 的 Base Prompt + 原生 Character Prompts);设置页显示为「NAI 规范」。 */
  naiV5Spec: string;
  /** ComfyUI 后端 tag 书写规范,拼在任务提示词里;留空回落内置默认(DEFAULT_COMFY_SPEC)。
   *  支持 {{nl}} 宏:开启「生成自然语言」时展开为自然语言规范,关闭时置空;
   *  自定义内容不含宏时,开启开关会把自然语言规范追加在末尾(防止开关静默失效)。 */
  comfySpec: string;
  /** 输出前思考检查清单(ComfyUI 后端);留空回落内置默认(DEFAULT_COMFY_THINKING)。
   *  思维链按后端各存一份:槽位块要求填的字段必须在同后端规范里有判据和词表,
   *  共用一份会让某个后端被要求填它的规范从未教过的东西。 */
  comfyThinking: string;
  /** 【已下线,无 UI 入口】NAI 4 系及以下的思考清单;回落 DEFAULT_NAI_THINKING。 */
  naiThinking: string;
  /** NAI 思维链(4.5/V5);留空回落内置默认(DEFAULT_NAI_V5_THINKING)。
   *  槽位块是 Base + 每角色块,与 comfy 那份的单串形态不同,不可互换。 */
  naiV5Thinking: string;
}

export interface ImageSettings {
  /** 插件总开关。 */
  enabled: boolean;
  /** 界面偏好(主题/导航位置等),随设置存进 extension_settings → 跨设备同步 */
  ui: UiPrefs;
  /** 渠道页初始展示的后端(无设置项,固定默认值) */
  defaultBackend: BackendId;
  /** 后端连接配置 */
  webui: BackendConn;
  comfyui: ComfyUISettings;
  nai: NaiSettings;
  /** 副 API 渠道列表(镜像共享存储;真身在 extensionSettings['baibai_api_channels']) */
  channels: ApiChannel[];
  /** 任务指派的渠道 id。tagGen=生成画图 tag;空串=跟随主 API。 */
  assignments: { tagGen: string };
  /** 自动判断并向正文插入生图 tag。 */
  autoTag: AutoTagSettings;
  /** 柏宝绘独立书单，不改变酒馆的世界书选择。 */
  worldBooks: { enabled: boolean; includeTavern: boolean; names: string[] };
  /** 排除设置(镜像共享存储;真身在 extensionSettings['baibai_exclude_settings'])。 */
  excludes: ExcludesSettings;
  /** 落盘存储行为(新图格式)。 */
  storage: StoragePrefs;
  /** 漫画 Layout 模式:模型只写符号框(panel/slot),坐标由插件查表注入。 */
  manga: MangaSettings;
}
