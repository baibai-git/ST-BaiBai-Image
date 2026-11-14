import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { normalizeOrientation } from '@/backends/size';
import { NaiError } from '@/backends/nai';
import { ComfyUIError } from '@/backends/comfyui';
import { activeTagKind, backendStatus, decideSeed, generateImage, type BackendStatus } from '@/generate';
import type { GenerationMeta } from '@/generationMeta';
import { saveExternalImage } from '@/floor/storage';
import { getContext } from '@/st/context';
import { serializeImageTag } from '@/st/imageTagRegex';
import {
  buildEntryTag,
  charTagLib,
  charTagsBeforeFloor,
  lockedCharTagNames,
  type CharTagEntry,
} from '@/state/charTags';
import { PLUGIN_VERSION } from '@/version';
import {
  PUBLIC_API_VERSION,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type GetCharactersOptions,
  type PublicBackendStatus,
  type PublicCharacter,
  type PublicCharacterList,
  type PublicError,
  type PublicErrorCode,
  type PublicGenerateProgress,
} from './types';

/**
 * 公开接口的实现层。**跨插件边界的全部脏活都收在这里。**
 *
 * 三条纪律,每条都对应一类真实会咬人的问题:
 *
 * 1. **一切出去的数据都深拷贝**。charTagLib.entries 是 Vue reactive 数组,
 *    原样递出去等于把角色库的写权限也一起给了 —— 第三方随手改一下,轻则被下一次
 *    recomputeCharTags() 静默冲掉(用户看见「我改的东西又没了」),重则把 reactive
 *    代理带进它自己的响应式系统,两边互相触发更新。
 *
 * 2. **错误一律归一成带 code 的普通 Error**。NaiError / ComfyUIError / DOMException
 *    的 instanceof 跨 bundle 必然失效(两份构造函数),第三方只能匹配 message 文案——
 *    而文案是中文、会随版本改。故这里统一挂 code,文档明说「按 code 分支」。
 *
 * 3. **图一律转 data URL 再交出去**。ComfyUI 直连模式返回的是 blob: URL,要配对
 *    revokeObjectURL:第三方忘了就泄漏,我们替它 revoke 它的 <img> 就变空白。
 *    data URL 无主、无生命周期,代价是字符串大一些 —— 这个代价值得。
 */

export function clonePublic<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/* —— 修订号:角色库每变一次 +1,第三方据此做缓存失效 —— */

let revision = 0;

export function getPublicRevision(): number {
  return revision;
}

export function bumpPublicRevision(): number {
  revision += 1;
  return revision;
}

/* —— 错误归一 —— */

/**
 * 造一个带 code 的 Error。**不派生 Error 子类**:子类的 instanceof 跨 bundle 无效,
 * 造出来的类型信息第三方拿不到,纯属自欺。
 */
export function publicError(code: PublicErrorCode, message: string): PublicError {
  const error = new Error(message) as PublicError;
  error.code = code;
  return error;
}

/** 已经是我们造的、带合法 code 的错误吗(避免二次包装丢原始 code)。 */
function hasPublicCode(error: unknown): error is PublicError {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return (
    code === 'aborted' ||
    code === 'not_configured' ||
    code === 'invalid_args' ||
    code === 'rate_limited' ||
    code === 'backend_error'
  );
}

/**
 * 把内部错误翻成公开 code。
 *
 * 取消判定看 `name === 'AbortError'` 而非 instanceof DOMException:
 * abort 可能由第三方自己的 AbortController 触发,那个 DOMException 来自**它的** realm,
 * instanceof 在我们这边是 false —— 于是用户主动取消会被报成 backend_error。
 *
 * rate_limited 与 backend_error 分开,是因为两者的**处置方式**不同:前者该等一会儿再来
 * (柏宝绘的自动退避已经用尽了),后者是配置/网络问题,再来一次也是同样的错。
 */
export function toPublicError(error: unknown): PublicError {
  if (hasPublicCode(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'AbortError') {
    return publicError('aborted', message || '已取消');
  }
  // NaiError 带 status:429/408 是限流(能重试),其余 4xx/5xx 是后端错
  if (error instanceof NaiError) {
    const status = error.status;
    if (status === 429 || status === 408) return publicError('rate_limited', message);
    return publicError('backend_error', message);
  }
  if (error instanceof ComfyUIError) return publicError('backend_error', message);
  // 兜底也看一眼文案:上面两个 instanceof 在同 bundle 内是可靠的,但内部还有别处抛的
  // 纯 Error(如 uploadUserImage 的 ImageStoreError),它们没有 status 可看
  if (/\b429\b|限流|rate limit/i.test(message)) return publicError('rate_limited', message);
  return publicError('backend_error', message || '生成失败');
}

/* —— 角色列表 —— */

function toPublicCharacter(entry: CharTagEntry, locked: ReadonlySet<string>): PublicCharacter {
  return {
    name: entry.name,
    // tag 用 buildEntryTag 现算,不自己拼:它是「字段 → tag 串」的唯一口径
    // (含「老条目只有整串 raw」那条回落),抄第二份必然与卡片实际出图的串漂移
    tag: buildEntryTag(entry),
    fields: { ...entry.fields },
    nl: entry.nl,
    source: entry.source,
    // 锁定名 = 全局库有、本聊天没同名覆盖。这正是「全局条目」的判据
    // (见 charTags.ts computeLockedCharTagNames),不必另立标记
    scope: locked.has(entry.name) ? 'global' : 'chat',
    desc: entry.desc,
    // history 刻意不给:50 条变更记录对第三方无用,而**给出去就删不掉了**
    // (删字段要升 apiVersion)。真有人要,日后加个 options 开关即可。
  };
}

export function getCharacters(options: GetCharactersOptions = {}): PublicCharacterList {
  const floor = options.floor;
  if (floor !== undefined && !Number.isInteger(floor)) {
    throw publicError('invalid_args', 'floor 必须是整数');
  }
  // 指定楼层走快照重放(那一楼当时的档案);否则用现成的响应式库
  const entries = floor === undefined ? charTagLib.entries : charTagsBeforeFloor(floor);
  const locked = lockedCharTagNames();
  return {
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision,
    floor: floor ?? null,
    // map 出的对象已是新建的普通对象(fields 也展开过),不含 reactive 代理
    characters: entries.map(entry => toPublicCharacter(entry, locked)),
  };
}

/* —— 后端状态 —— */

/**
 * 公共接口眼里的后端状态:当前方案是漫画时一律算「未配置」。
 * 第三方递进来的是插画提示词,漫画模型吃的是分镜 JSON,硬画只会出废图;
 * 报在 configured 上,第三方按既有的 not_configured 分支就能处理,不必认识新错误码。
 */
function publicBackendStatus(): BackendStatus {
  const status = backendStatus();
  if (status.configured && activeTagKind() === 'comic') {
    return { ...status, configured: false, reason: '当前出图方案是漫画方案，公共接口只支持插画' };
  }
  return status;
}

/**
 * 后端状态。**字段是白名单而非黑名单**:只挑这四项出去,
 * 而不是「把 status 整个递出去再删掉敏感字段」—— 后者日后往内部结构加字段时会静默泄漏。
 * 尤其 settings.nai.key 与各后端 url 绝不出现在这里。
 */
export function getBackendStatus(): PublicBackendStatus {
  const status = publicBackendStatus();
  return {
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    backend: status.backend,
    configured: status.configured,
    model: status.model,
    supportsCharacters: status.supportsCharacters,
    reason: status.reason,
  };
}

/* —— 生成 —— */

/** 第三方传进来的 characters:逐项清洗成内部形状,名字或 tag 空的丢掉。 */
function normalizeCharacters(raw: GenerateRequest['characters']): ImageCharacterPrompt[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const tag = typeof item.tag === 'string' ? item.tag.trim() : '';
    const nl = typeof item.nl === 'string' ? item.nl.trim() : '';
    return name && tag ? [{ name, tag, nl }] : [];
  });
}

/**
 * 结果图 → data URL。
 *
 * server 代理模式下 result.url 本就是 data URL,原样返回(不过一遍 fetch,省一次拷贝);
 * 直连模式是 blob: URL,读回来重编码。理由见文件头第 3 条。
 */
async function toDataUrl(url: string, format: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取图片失败 (${response.status})`);
  const bytes = new Uint8Array(await (await response.blob()).arrayBuffer());
  let binary = '';
  // 分块拼接:一次 String.fromCharCode(...几 MB) 会爆调用栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = format === 'jpg' ? 'jpeg' : format;
  return `data:image/${mime};base64,${btoa(binary)}`;
}

/** 进度回调包装:第三方的回调抛错不能连累生成(它只是想看个进度)。 */
function safeProgress(
  onProgress: GenerateOptions['onProgress'],
): (progress: PublicGenerateProgress) => void {
  if (typeof onProgress !== 'function') return () => {};
  return progress => {
    try {
      onProgress(progress);
    } catch (error) {
      console.warn('[柏宝绘] 公共接口 onProgress 回调异常', error);
    }
  };
}

export async function generate(
  request: GenerateRequest,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  if (!request || typeof request !== 'object') {
    throw publicError('invalid_args', 'generate 需要一个参数对象');
  }
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  if (!prompt) throw publicError('invalid_args', 'prompt 不能为空');
  if (request.seed !== undefined && (typeof request.seed !== 'number' || !Number.isFinite(request.seed))) {
    throw publicError('invalid_args', 'seed 必须是数字');
  }

  // 先报 not_configured,别让第三方等一个注定 401 的请求
  const status = publicBackendStatus();
  if (!status.configured) {
    throw publicError('not_configured', status.reason || '柏宝绘出图后端未配置');
  }

  const report = safeProgress(options.onProgress);
  const signal = options.signal;
  const characters = normalizeCharacters(request.characters);
  const nl = typeof request.nl === 'string' ? request.nl.trim() : '';
  const negative = typeof request.negative === 'string' ? request.negative.trim() : '';
  // 方向容忍式归一:传了认不出的值按竖屏,不为一个画幅参数让整次生成失败
  const size = normalizeOrientation(request.size);
  const seed = decideSeed(status.backend, request.seed);

  // NAI 要过并发闸门,可能先排一会儿队;ComfyUI 直接发,队列在服务端
  report({ phase: status.backend === 'nai' ? 'queued' : 'generating' });

  let output;
  try {
    output = await generateImage({ prompt, nl, negative, characters, size, seed }, signal, {
      onStart: () => report({ phase: 'generating' }),
      onQueue: ahead => report({ phase: 'queued-remote', ahead }),
      onRetry: retry =>
        retry
          ? report({ phase: 'retrying', attempt: retry.attempt, max: retry.max })
          : report({ phase: 'generating' }),
    });
  } catch (error) {
    throw toPublicError(error);
  }

  const { result } = output;
  try {
    const dataUrl = await toDataUrl(result.url, result.format);
    // 落盘默认开(用户定的口径):默认进图库,第三方要「阅后即焚」才显式传 false
    const wantSave = request.save !== false;
    let path: string | null = null;
    if (wantSave) {
      report({ phase: 'saving' });
      // 存实际出图的方向:渠道锁定时它与请求的 size 不同,图库里的 tag 要如实描述这张图
      path = await saveToGallery(request, prompt, nl, negative, characters, output.size, seed, result, output.meta);
    }
    return {
      apiVersion: PUBLIC_API_VERSION,
      pluginVersion: PLUGIN_VERSION,
      dataUrl,
      format: result.format,
      path,
      seed: output.seed,
      backend: output.backend,
      charactersApplied: output.charactersApplied,
    };
  } catch (error) {
    throw toPublicError(error);
  } finally {
    // blob URL 用完即撕:dataUrl 已经拿到,原始 blob 再留着就是纯泄漏
    result.revoke();
  }
}

/**
 * 落盘进图库。**失败只警告不抛** —— 图已经在 dataUrl 里了,
 * 因为存不进图库就让第三方连图都拿不到是本末倒置(它可能压根不在乎图库)。
 * 返回 null 让调用方从 path 上看出来没存成。
 */
async function saveToGallery(
  request: GenerateRequest,
  prompt: string,
  nl: string,
  negative: string,
  characters: ImageCharacterPrompt[],
  size: ReturnType<typeof normalizeOrientation>,
  seed: number,
  result: Parameters<typeof saveExternalImage>[3],
  meta: GenerationMeta,
): Promise<string | null> {
  // 存的是 **tag 原文**(含 <bbi_image> 壳),不是拼好的展示文本:
  // 图库读侧写后要 parseImageTagContent 再 formatPromptText(与楼层卡片同一口径),
  // 这里存展示文本会让图库解析出一团糊在一起的裸 tag。
  const tag = serializeImageTag({ tag: prompt, nl, negative, characters, size });
  const name =
    (typeof request.character === 'string' ? request.character.trim() : '') ||
    getContext()?.name2?.trim() ||
    '未命名角色';
  try {
    return await saveExternalImage(name, tag, seed, result, meta);
  } catch (error) {
    console.warn('[柏宝绘] 公共接口生成的图片落盘失败（图片本身已返回给调用方）', error);
    return null;
  }
}
