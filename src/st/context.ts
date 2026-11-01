/**
 * SillyTavern getContext() 的薄封装 + 类型。
 * 整个扩展只通过这里接触宿主,稳定且单点。
 * 运行时 getContext 挂在 window.SillyTavern 上(ST 的稳定扩展 API)。
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  swipes?: string[];
  swipe_info?: Array<{ extra?: Record<string, unknown> }>;
  swipe_id?: number;
  send_date?: string;
  extra?: Record<string, unknown>;
}

/**
 * 是不是一条「剧情消息」——即 ST 的真·系统消息之外的一切,**含被 /hide 隐藏的普通楼**。
 *
 * 判据只看 extra.type:ST 只给 narrator/comment/sys 这类真系统消息盖这个戳
 * (system-messages.js、slash-commands.js 的 /role system),而 /hide 只翻 is_system、
 * 不碰 extra(chats.js hideChatMessageRange)。所以隐藏的普通楼在这里是 true——
 * 隐藏的语义是「不进提示词」,不是「不是剧情」,ST 自己也这么认:messageFormatting
 * 对隐藏楼有一句 `// Let hidden messages have markdown`,强行把 isSystem 置回 false,
 * 好让它照常吃 markdown 与正则(我们的锚点正则也是靠这条才在隐藏楼生效)。
 *
 * **只有这一份**:楼层按钮的显隐、自动 tag 的目标闸门、历史上下文的取舍共用它。
 * 各写一份的后果是活生生的 bug——旧版 actionButton 直接读 DOM 的 is_system 属性,
 * 隐藏楼一律不给按钮,而 runner 其实放行,用户看到的就是「有的楼没有按钮」。
 */
export function isStoryMessage(message: STMessage | undefined): message is STMessage {
  if (!message || typeof message.mes !== 'string' || !message.mes.trim()) return false;
  return !(message.is_system && typeof message.extra?.type === 'string');
}

/** 剧情消息里的 AI 楼(用户楼不算)。楼层按钮与自动 tag 的目标楼判据。 */
export function isAiStoryMessage(message: STMessage | undefined): message is STMessage {
  return isStoryMessage(message) && !message.is_user;
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STEventTypes {
  USER_MESSAGE_RENDERED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  CHAT_CHANGED: string;
  MESSAGE_EDITED: string;
  MESSAGE_UPDATED: string;
  MESSAGE_SWIPED: string;
  MESSAGE_DELETED: string;
  [k: string]: string;
}

/** 角色卡(只用到极少字段;avatar 是稳定唯一键,name 可能重名) */
export interface STCharacter {
  name: string;
  avatar: string;
  [k: string]: unknown;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  characters?: STCharacter[];
  /** 当前角色在 characters 中的索引(字符串/数字);群聊时为空 */
  characterId?: string | number;
  /** 当前群组 id;非群聊为空 */
  groupId?: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveChat: () => Promise<void>;
  reloadCurrentChat?: () => Promise<void>;
  updateMessageBlock?: (
    messageId: number,
    message: STMessage,
    options?: { rerenderMessage?: boolean },
  ) => unknown;
  /** 扩展全局设置对象(= extension_settings,写进服务器 settings.json,跨设备同步)。ST 稳定 API。 */
  extensionSettings?: Record<string, unknown>;
  /** 防抖保存全局设置(连同 extensionSettings 落盘到服务器)。ST 稳定 API。 */
  saveSettingsDebounced?: () => void;
  /**
   * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次性补全。来源 script.js,ST 稳定 API。
   * prompt 传消息数组时只发这些消息、不带聊天历史/角色卡;api 缺省=main_api(用户当前主 API)。
   * 内部走 sendOpenAIRequest('quiet', …),quiet 强制非流式,返回清洗后的整段文本。
   */
  generateRaw?: (params: {
    prompt: Array<{ role: string; content: string }> | string;
    api?: string | null;
    systemPrompt?: string;
    responseLength?: number | null;
    prefill?: string;
    jsonSchema?: unknown;
  }) => Promise<string>;
  /** 展开 {{char}}/{{user}} 等宏。带角色卡描述时,字段里可能含宏,需用它还原。ST 稳定 API。 */
  substituteParams?: (content: string) => string;
  /**
   * 用当前分词器数 token。ST 稳定 API(tokenizers.js)。
   * 【口径】用的是**主界面当前 API/模型**的分词器,与副 API 渠道的模型未必同源,
   * 故结果只能当估算(UI 上以 ≈ 标注),不能与上游返回的真实 usage 混为一谈。
   */
  getTokenCountAsync?: (str: string, padding?: number) => Promise<number>;
  /**
   * 按文本激活世界书条目(关键词触发 + constant 常驻)。ST 稳定 API(world-info.js)。
   * chat 为待扫描文本数组(由旧到新);isDryRun=true 仅扫描不触发副作用事件。
   */
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, unknown>,
  ) => Promise<{
    worldInfoBefore?: string;
    worldInfoAfter?: string;
    worldInfoString?: string;
    /** @深度条目:{depth, role, entries: string[]}。很多蓝灯条目在这里 */
    worldInfoDepth?: Array<{ depth?: number; role?: number; entries?: string[] }>;
    /** 作者注前/后条目(content 字符串数组) */
    anBefore?: string[];
    anAfter?: string[];
  }>;
  /** 全部已加载的世界书文件名(全局 + 角色绑定)。ST 稳定 API。 */
  getWorldInfoNames?: () => string[];
  /** 主上下文最大 token(给 getWorldInfoPrompt 的预算参数) */
  maxContext?: number;
  // 兼容旧式命名
  event_types?: STEventTypes;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
}

/** 一条已激活的世界书条目(checkWorldInfo 返回的条目对象;只取渲染/拼接用到的字段)。 */
export interface WorldInfoEntry {
  /** 所属世界书文件名 */
  world?: string;
  /** 条目备注/标题 */
  comment?: string;
  /** 条目正文 */
  content?: string;
  [k: string]: unknown;
}

/** checkWorldInfo 的返回结构(只声明我们要用的字段)。 */
interface CheckWorldInfoResult {
  /** 全部激活条目(已完成扫描/递归/预算,是最终该进提示词的集合) */
  allActivatedEntries?: Set<WorldInfoEntry> | Map<string, WorldInfoEntry>;
  [k: string]: unknown;
}

type CheckWorldInfoFn = (
  chat: string[],
  maxContext: number,
  isDryRun: boolean,
  globalScanData?: Record<string, unknown>,
) => Promise<CheckWorldInfoResult>;

/**
 * 取 ST 的 checkWorldInfo(getContext 未暴露,从 /scripts/world-info.js 动态取)。
 * 与 getWorldInfoPrompt 不同:它返回**条目对象集合**(带 world/comment/content),
 * 才能逐条渲染——而 getWorldInfoPrompt 只吐拼好的字符串,元信息全丢。
 * 取不到(旧版/路径变动)时返回 null,调用方据此降级回 getWorldInfoPrompt。
 */
export async function getCheckWorldInfo(): Promise<CheckWorldInfoFn | null> {
  try {
    // 变量持有路径,避免 Vite/vue-tsc 把它当本地模块解析
    const wiPath = '/scripts/world-info.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ wiPath);
    const fn = mod.checkWorldInfo;
    return typeof fn === 'function' ? (fn as CheckWorldInfoFn) : null;
  } catch {
    return null;
  }
}

/** 独立书单入口：宿主兼容补丁直接复用原扫描器，不修改全局启用名单。 */
export type CheckWorldInfoForBooksFn = (
  chat: string[], maxContext: number, isDryRun: boolean, worldNames: string[],
) => Promise<CheckWorldInfoResult>;

export async function getCheckWorldInfoForBooks(): Promise<CheckWorldInfoForBooksFn | null> {
  try {
    const wiPath = '/scripts/world-info.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ wiPath);
    return typeof mod.checkWorldInfoForBooks === 'function'
      ? mod.checkWorldInfoForBooks as CheckWorldInfoForBooksFn
      : null;
  } catch {
    return null;
  }
}

/**
 * ST-Prompt-Template(提示词模板插件)挂在 globalThis 的执行器接口(见其 exports.ts)。
 * 只用到 prepareContext + evalTemplate:前者备好含变量/世界书上下文的 env,
 * 后者对含 <% %> 的文本跑 EJS。用于让副 API 读到的世界书拿到「执行后」的成品,而非原文。
 * 插件未安装时 globalThis.EjsTemplate 为 undefined,调用方据此降级。
 */
export interface EjsTemplateApi {
  prepareContext: (context?: Record<string, unknown>, end?: number) => Promise<Record<string, unknown>>;
  evalTemplate: (
    code: string,
    context?: Record<string, unknown> | null,
    options?: Record<string, unknown>,
  ) => Promise<string | null>;
}

/** 取 ST-Prompt-Template 暴露的模板执行器;未安装/接口不完整时返回 null(调用方降级为不执行 EJS)。 */
export function getEjsTemplate(): EjsTemplateApi | null {
  const api = (globalThis as { EjsTemplate?: Partial<EjsTemplateApi> }).EjsTemplate;
  if (api && typeof api.prepareContext === 'function' && typeof api.evalTemplate === 'function') {
    return api as EjsTemplateApi;
  }
  return null;
}

interface SillyTavernGlobal {
  getContext?: () => STContext;
}

/** 取 ST 上下文;ST 尚未就绪时返回 null(调用方负责轮询/延后)。 */
export function getContext(): STContext | null {
  try {
    const st = (window as unknown as { SillyTavern?: SillyTavernGlobal }).SillyTavern;
    return st?.getContext?.() ?? null;
  } catch {
    return null;
  }
}
