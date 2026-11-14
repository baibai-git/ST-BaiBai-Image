/**
 * 「一次出图」的共用中段 —— 楼层卡片与公开接口的唯一生成入口。
 *
 * 原本这段活全写在 Card.vue 的 generate() 里,与槽位运行态(beginGen/failGen)、
 * 落盘(saveImageResult)、重水合(hydrateMessage)缠在一起。公开接口要让第三方
 * 「自己决定图显示在哪」,要的恰恰是**掐头去尾的中段**:
 *
 *   前(调用方):登记运行态 / 校验参数
 *   ★ 中(本模块):NAI 闸门 → 按 backend 分派 → 拿到图
 *   后(调用方):落盘、显示、收尾埋点
 *
 * **闸门不可绕过**,这是本模块存在的首要理由:直接调 backends/nai.ts 的
 * generateNaiImage 会跑在 floor/genQueue.ts 的并发闸门与全局节奏之外,0.2.0 整版的
 * NAI 限流自愈(429 全局冷却、相邻请求最小间隔、退避重试)当场失效。第三方并发调用
 * 是常态,绕过去的症状是用户 NAI 账号吃一串密集 429 —— 而用户只会认为柏宝绘坏了。
 * 故公开接口与卡片共用本函数,闸门在这里包死。
 *
 * 本模块**刻意不碰**:楼层坐标、genState、extra、水合、请求历史埋点。
 * 埋点留给调用方是有意为之:一条历史记录的「成功」判据各家不同——楼层卡片要等
 * saveImageResult 落盘成功才算成,还要把「图拿到了却因任务被取代而丢弃」记成已取消;
 * 本模块只知道请求本身的成败,替调用方下结论会把那两种情形谎报成成功。
 * 故 decideSeed 单独导出:调用方先定种子(埋点需要它)、再把它显式传进来。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { comfySimpleParams, composeNegative, composePositive, validateSimpleConfig, type SimpleGenValues } from '@/backends/comfyTemplates';
import { generateComfyImage, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import { buildMossPrompt, type ComicLayout } from '@/backends/mossLayout';
import { generateNaiImage, naiRandomSeed, naiSupportsCharacterPrompts } from '@/backends/nai';
import { effectiveOrientation, parseSize, pickSize, type Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import type { GenerationMeta } from '@/generationMeta';
import { imageTagKind, type ImageTagContent } from '@/st/imageTagRegex';
import { activeComfyPreset, activeComfyServer, activeNaiEndpoint, activeNaiPlan, activeOrientationLock, effectiveComfyConn, effectiveNai, settings, type BackendId, type ComfyKind } from '@/state/settings';

/** 一次生成的输入。与协议层 ImageInsertion 同形,但不含正文位置信息。 */
export interface GenerateInput {
  /** 正向 danbooru 短 tag。 */
  prompt: string;
  /** 自然语言部分(可空)。 */
  nl?: string;
  /** 本画面动态负面(可空)。ComfyUI 走 %negative_prompt%;NAI 的负面取渠道配置,不吃这个。 */
  negative?: string;
  /** NAI 4.5/V5 原生多角色提示;ComfyUI 不支持(见 charactersApplied)。 */
  characters?: ImageCharacterPrompt[];
  /**
   * 画幅方向;缺省竖屏。具体像素取渠道配置里的横竖尺寸。
   * 渠道锁定了方向(activeOrientationLock)时一律按锁定方向出,这里传什么都不算数。
   */
  size?: Orientation;
  /** 本次种子。由调用方经 decideSeed() 先行确定(埋点要在发请求前拿到它)。 */
  seed: number;
  /**
   * 漫画一页的分镜(tag 类型为 comic)。有它时 prompt/nl 不用:正向提示词按实际像素现算成
   * MOSS layout JSON——bbox 是像素坐标,画幅定了才算得出来,所以不能提前存进 tag。
   */
  comic?: ComicLayout;
}

/** 生成过程中的进度上报(卡片用它显示排队位置与退避进度)。 */
export interface GenerateProgress {
  /** 已取得闸门槽位、请求即将发出(NAI 从「排队中」进入「生成中」的时机)。 */
  onStart?: () => void;
  /** ComfyUI 服务端队列里前面还有几个;null = 未知。 */
  onQueue?: (ahead: number | null) => void;
  /** NAI 限流退避进度;传 null 表示已不在退避中。 */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** 本次实际使用的种子(原样回传,调用方不必自己记)。 */
  seed: number;
  /** 本次实际出图的画幅方向(渠道锁定时即锁定方向,可能与入参 size 不同)。 */
  size: Orientation;
  backend: BackendId;
  /**
   * characters 是否真的发给了后端。
   * ComfyUI 链路**不支持**多角色提示(comfyui.ts / comfyTemplates.ts 全程不读该字段),
   * 传了也是静默丢弃 —— 故显式回报,调用方据此决定要不要提示用户换后端。
   * 不在这里「降级拼进 prompt」:那正是 0.2.3 修掉的重叠躯干问题(一张图里多份完整外貌)。
   */
  charactersApplied: boolean;
  /**
   * 本次实际使用的画师串 / vibe / 采样参数 / 模型，供落盘随图记录（见 generationMeta.ts）。
   * NAI 的画师串与 vibe 不在 tag 文本里，不在这里冒泡出去就只能永久丢失。
   */
  meta: GenerationMeta;
}

/** 后端就绪状态。 */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** NAI 为模型名;ComfyUI 为当前工作流预设名。 */
  model: string;
  /** 当前后端是否支持 characters(NAI 4.5/V5 为 true,ComfyUI 恒 false)。 */
  supportsCharacters: boolean;
  /** configured=false 时的人话原因;已就绪为空串。 */
  reason: string;
}

/**
 * 当前后端能不能出图。**唯一判据**,卡片(configured)与公开接口共用。
 *
 * ComfyUI 要按模式分别校验(custom 要工作流 JSON;simple 要模型/VAE/CLIP 选齐,
 * 与出图组装同一口径 validateSimpleConfig,避免「卡片能点、出图才报错」);NAI 要 url + key。
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai') {
    const model = activeNaiPlan().model;
    // 支持与否只看模型,与配没配齐无关:第三方要在出图前就知道该不该传 characters
    const supportsCharacters = naiSupportsCharacterPrompts(model);
    const base = { backend, model, supportsCharacters };
    // 地址与 key 取**当前方案引用的接入点**那一份(见 effectiveNai)。
    // reason 里刻意**不带接入点名字**:它会经 getBackendStatus 原样递给第三方,而名字是用户
    // 自己敲的——有人就拿站点域名当名字,带上等于把地址漏进公开返回值(见 public/api.ts 白名单)。
    // 少了名字也不难定位:面板下拉里选中的就是这条。
    const conn = activeNaiEndpoint();
    if (!conn.url.trim()) {
      return { ...base, configured: false, reason: '当前 NAI 接入点未填写服务地址' };
    }
    if (!conn.key.trim()) {
      return { ...base, configured: false, reason: '当前 NAI 接入点未填写 API Key' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'comfyui') {
    const preset = activeComfyPreset();
    const base = { backend, model: preset.name, supportsCharacters: false };
    // 同 NAI 接入点:reason 不带服务器名(用户常拿地址当名字,reason 会递给第三方)
    if (!activeComfyServer().url.trim()) {
      return { ...base, configured: false, reason: '当前出图方案的渠道未填写地址' };
    }
    if (preset.mode === 'simple') {
      const invalid = validateSimpleConfig(preset.simple);
      if (invalid) return { ...base, configured: false, reason: invalid };
      return { ...base, configured: true, reason: '' };
    }
    if (!preset.workflow.trim()) {
      return { ...base, configured: false, reason: '当前工作流预设未填写工作流 JSON' };
    }
    return { ...base, configured: true, reason: '' };
  }

  // webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai),真出现就是「没选后端」
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '出图后端未选择,请在柏宝绘「渠道」页选择出图渠道',
  };
}

/**
 * 当前方案出的是哪类图:NAI 恒为插画;ComfyUI 看当前方案的类型。
 * tag 的类型写在正文里,与它对不上的 tag 不能用当前方案出(插画 tag 喂给漫画模型、
 * 或分镜 JSON 喂给插画模型都只会出废图)——卡片据此禁用生成并提示整楼重新生成。
 */
export function activeTagKind(): ComfyKind {
  return settings.defaultBackend === 'comfyui' ? activeComfyPreset().kind : 'illustration';
}

/**
 * 这条 tag 能不能用当前方案出图:能 = 空串,不能 = 给用户看的原因。
 * 卡片据此禁用生成、静默跳过自动出图,并给「按当前方案重新生成本楼」的入口——
 * 换类型只能整楼重来(漫画是整楼分页,与插画的逐张 tag 对不上号)。
 */
export function tagBlockReason(
  content: Pick<ImageTagContent, 'kind' | 'layout'>,
  planKind: ComfyKind = activeTagKind(),
): string {
  const kind = imageTagKind(content);
  if (kind === 'comic' && !content.layout) return '漫画分镜格式损坏，无法出图';
  if (kind === planKind) return '';
  return kind === 'comic' ? '这是漫画分镜，当前出图方案不是漫画方案' : '这是插画 tag，当前出图方案是漫画方案';
}

/**
 * 定本次种子。**必须在发请求前定好**:一是部分采样器节点不接受 -1 自动随机,
 * 二是埋点与落盘(entry.seed)都要记下它,事后「同种子再来一张」才有依据。
 *
 * 口径:显式指定 > NAI 当前方案的固定种子(>0)> 随机。
 * NAI 与 ComfyUI 的随机上界不同(各自协议的合法范围),故分开取。
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') {
    const fixed = activeNaiPlan().seed;
    return fixed > 0 ? fixed : naiRandomSeed();
  }
  return randomSeed();
}

/**
 * 按当前设置出一张图。**楼层卡片与公开接口的唯一生成路径。**
 *
 * 不负责落盘、不负责显示、不登记运行态、不做埋点 —— 那些是调用方的事。
 * signal 一路透传到 fetch/轮询;取消时抛 AbortError(DOMException)。
 *
 * 闸门纪律(见 floor/genQueue.ts):NAI 路径必须持槽发请求,release 放在 finally,
 * 漏一格就永久少一格并发。
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  // 兜底:卡片侧已用 configured 拦在按钮上,公开接口侧也会先报 not_configured。
  // 真漏到这里说明上游判据漂了,宁可明说也别发一个注定 401/404 的请求。
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');
  // 同上兜底:卡片对类型不符的 tag 不给生成按钮
  const kind = activeTagKind();
  if (input.comic && kind !== 'comic') throw new Error('这是漫画分镜，当前出图方案不是漫画方案');
  if (!input.comic && kind === 'comic') throw new Error('当前出图方案是漫画方案，不能画插画 tag');

  const isNai = status.backend === 'nai';
  const characters = input.characters ?? [];
  // 支持与否由后端说了算:ComfyUI 恒不支持;NAI 看模型是否 4.5/V5
  const charactersApplied = characters.length > 0 && status.supportsCharacters;

  let release: (() => void) | null = null;
  try {
    // 持槽:取到槽位后本函数内一直持有,直到 finally 释放。闸门按接入点分(各站各自限流)。
    // 参数仍在取到槽后才解开(排队期间改的步数等照样生效);排队中途切了方案换了站,
    // 本次也只是在旧站的闸门里排的队,下一张起就归新站,不值得为此重排。
    if (isNai) release = await acquireNaiSlot(signal, activeNaiEndpoint().id);
    progress.onStart?.();

    // 画幅锁在这里统一生效(卡片与公开接口同走本函数):只决定这一次用哪格尺寸,
    // tag 里记的方向原样不动——promptHash 吃 tag 原文,改写会让老图无辜变 stale。
    const size = effectiveOrientation(activeOrientationLock(), input.size ?? 'portrait');
    let result: ComfyImageResult;
    let meta: GenerationMeta;
    if (isNai) {
      const output = await generateNaiImage(
        effectiveNai(),
        // characters 原样透传:不支持的模型由 buildNaiParameters 自己滤掉(同一口径
        // naiSupportsCharacterPrompts),在这儿再滤一遍只会多一处会漂的判据
        { prompt: input.prompt, nl: input.nl ?? '', characters, seed: input.seed, size },
        signal,
        { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
      );
      result = output.result;
      meta = { backend: 'nai', model: status.model, ...output.usage };
    } else {
      let conn = effectiveComfyConn();
      // 尺寸解析口径与 generateComfyImage 一致（未解析出时 0 = 用工作流自带尺寸）。
      const px = parseSize(pickSize(conn, size));
      const width = px?.width ?? 0;
      const height = px?.height ?? 0;
      let prompt = input.prompt;
      let nl = input.nl ?? '';
      if (input.comic) {
        if (!px) throw new Error('漫画需要在出图方案里填好横竖尺寸（分镜坐标要按实际像素换算）');
        // 固定正面并进 summary;不清掉的话 composePositive 会把它拼在 JSON 前面,整串就不是 JSON 了
        prompt = buildMossPrompt(input.comic, width, height, conn.mode === 'simple' ? conn.simple.positive : '');
        nl = '';
        if (conn.mode === 'simple') conn = { ...conn, simple: { ...conn.simple, positive: '' } };
      }
      result = await generateComfyImage(
        conn,
        {
          prompt,
          nl,
          negative_prompt: input.negative ?? '',
          seed: input.seed,
          size,
        },
        signal,
        { onQueue: ahead => progress.onQueue?.(ahead) },
      );
      // ComfyUI 没有运行期跳过的概念，配方全在预设里，可在此直接快照。
      const simpleValues: SimpleGenValues = {
        prompt,
        nl,
        negative: input.negative,
        seed: input.seed,
        width,
        height,
      };
      meta = {
        backend: 'comfyui',
        model: status.model,
        width,
        height,
        // custom 模式的提示词由工作流里的占位符决定，无法在这里拼出全文，留空。
        positive: conn.mode === 'simple' ? composePositive(conn.simple, simpleValues) : '',
        negative: conn.mode === 'simple' ? composeNegative(conn.simple, simpleValues) : '',
        artist: null,
        vibes: [],
        params: conn.mode === 'simple' ? comfySimpleParams(conn.simple) : { mode: 'custom' },
      };
    }

    // 退避文案到此为止:图已拿到,落盘还要一会儿,不该继续显示「稍后重试」
    progress.onRetry?.(null);
    return { result, seed: input.seed, size, backend: status.backend, charactersApplied, meta };
  } finally {
    release?.();
  }
}
