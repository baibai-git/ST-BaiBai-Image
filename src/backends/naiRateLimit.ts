/**
 * NAI 限流自愈:重试策略 + 全局节奏状态。
 *
 * 为什么需要:generate-image 是浏览器直连的阻塞式 POST,没有服务端队列。原先吃到 429
 * 就直接把卡片标红交给用户手点,而且错误是**按槽位隔离**的 —— 被限流时闸门照旧一个接
 * 一个往下泵(release → pump → 立刻发下一个 → 又 429),打出一串密集失败请求,恰恰
 * 最像滥用。这里补三样:
 *
 * 1. **错误分类**:429 / 5xx / 网络级失败才重试;400/401/402 这类配置错误立刻抛。
 *    不分类的话,一个填错的 key 会被退避重试放大成四倍请求量。
 * 2. **退避重试**:指数退避 + 抖动,并把对方给的 Retry-After 当下界。
 * 3. **闸门级冷却**:429 不只让当前请求退避,还给**整个闸门**上冷却
 *    (floor/genQueue.ts 取槽后等待),否则其余槽位会在同一秒里接着撞上去。
 *
 * 另加相邻请求最小间隔,给「正常出图耗时撑不出间隔」的场合兜底(小图/低步数/快速失败重发)。
 *
 * 状态刻意做成模块级、**按闸门(= 接入点 id)分账**:节奏按账号生效,不按卡片,闸门(floor)
 * 与后端(backends/nai)读写的必须是同一份;而不同接入点是不同的站/账号,公益站 A 吃了 429
 * 不该把官方站也一起冻住。所有时间戳都可注入,故整个策略层不用假时钟就能单测。
 */

/** 总尝试次数上限(含首发):1 次首发 + 3 次重试。 */
export const NAI_MAX_ATTEMPTS = 4;

/** 相邻两次 NAI 请求的最小间隔。正常出图耗时远大于此,只在连发/快速失败时起作用。 */
export const NAI_MIN_INTERVAL_MS = 1500;

/** 吃到 429 但对方没给 Retry-After 时的默认全局冷却。 */
export const NAI_RATE_LIMIT_COOLDOWN_MS = 15_000;

/** 退避基数。 */
const BACKOFF_BASE_MS = 2000;

/**
 * 单次等待上限,同时也是 Retry-After 的采信上限。
 * 设上限的理由:对方(或第三方镜像)给个 Retry-After: 3600 时,卡片不该无声无息挂一小时——
 * 等到上限还不行就把错误抛给用户,让他自己决定。
 */
const MAX_WAIT_MS = 60_000;

/* ============ 纯策略 ============ */

/**
 * 用户主动取消:一律不重试。
 * 鸭子类型判 name,不用 `instanceof DOMException`——本模块的输入既可能是浏览器的
 * DOMException,也可能是 fetch/上游包装出的普通 Error,认名字才两边都盖得住。
 */
export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
}

/**
 * 这个状态码值不值得重试。
 * 408/429 是明确的「慢点/重来」;5xx 是服务端临时故障(含第三方镜像常见的 Cloudflare 52x)。
 * 501 例外:那是「压根没实现」,重试到世界尽头也一样。
 */
export function isRetryableNaiStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status !== 501;
}

/**
 * 该不该重试。**故意只吃原始值**(错误对象 + 状态码),不认识 NaiError ——
 * 否则 naiRateLimit ↔ nai 互相 import 成环。
 *
 * 无状态码的分两种:fetch 的 TypeError 是网络级失败(断网/CORS/拒连),值得重试;
 * 我们自己抛的校验/解析错误(「zip 包内没有图片」之类)重试一万次也是同一个结果,不重试。
 */
export function shouldRetryNai(error: unknown, status: number | undefined): boolean {
  if (isAbortError(error)) return false;
  if (status !== undefined) return isRetryableNaiStatus(status);
  return error instanceof TypeError;
}

/**
 * 解析 Retry-After 响应头:支持「秒数」与「HTTP 日期」两种写法,取不到返回 null。
 * 结果夹到 [0, MAX_WAIT_MS]。
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, MAX_WAIT_MS) : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_WAIT_MS);
}

/**
 * 第 attempt 次重试(1 起)该等多久。
 *
 * 抖动只在 50%–100% 区间取:下界保住基本退避力度,随机化则避免多张卡同时醒来又撞一起。
 * Retry-After 当**下界**用 —— 对方明确说了等多久,不能比它更早回去敲门。
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), MAX_WAIT_MS);
  const jittered = Math.round(exponential * (0.5 + 0.5 * random()));
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), MAX_WAIT_MS);
}

/* ============ 按闸门分账的节奏状态 ============ */

/**
 * 不指名闸门时用的那一本账(单测与历史调用)。生产路径一律传接入点 id。
 * 空串不会与真实接入点撞:接入点 id 恒非空(normalize 兜底)。
 */
export const DEFAULT_NAI_GATE = '';

interface PacingState {
  cooldownUntil: number;
  /**
   * 上一次请求发出的时刻。初值 -Infinity 而非 0:0 的语义是「1970 年发过一次」,
   * 只在 now 远大于最小间隔时才碰巧等价于「没发过」。-Infinity 让「从未发过 → 无需等待」
   * 与时钟取值无关地成立。
   */
  lastStartAt: number;
}

const pacing = new Map<string, PacingState>();
let minIntervalMs = NAI_MIN_INTERVAL_MS;

function pacingOf(gate: string): PacingState {
  let state = pacing.get(gate);
  if (!state) {
    state = { cooldownUntil: 0, lastStartAt: Number.NEGATIVE_INFINITY };
    pacing.set(gate, state);
  }
  return state;
}

/** 429 冷却的下界:见 noteNaiRateLimited。 */
const MIN_COOLDOWN_MS = 1000;

/**
 * 记一次 429:给该闸门上冷却(别的接入点不受影响)。
 *
 * **只延后不提前** —— 并发 ≥2 时几个槽位可能接连撞上,后来的短冷却不该把前面的长冷却冲掉。
 * **下界 1s** —— 哪怕对方给的是 `Retry-After: 0`(或一个已过期的日期),429 也总该让闸门
 * 喘一口气;一个「立刻重来」的 429 最容易滚成连发死循环,那正是要防的东西。
 */
export function noteNaiRateLimited(
  retryAfterMs: number | null,
  now: number = Date.now(),
  gate: string = DEFAULT_NAI_GATE,
): void {
  const state = pacingOf(gate);
  const requested = retryAfterMs ?? NAI_RATE_LIMIT_COOLDOWN_MS;
  const until = now + Math.min(Math.max(requested, MIN_COOLDOWN_MS), MAX_WAIT_MS);
  if (until > state.cooldownUntil) state.cooldownUntil = until;
}

/** 记一次请求发出的时刻(最小间隔的基准)。取槽后与每次重试前都要记。 */
export function noteNaiRequestStart(now: number = Date.now(), gate: string = DEFAULT_NAI_GATE): void {
  pacingOf(gate).lastStartAt = now;
}

/** 现在还得等多久才允许发下一个请求:冷却剩余与最小间隔剩余取大。 */
export function naiPacingDelayMs(now: number = Date.now(), gate: string = DEFAULT_NAI_GATE): number {
  const state = pacingOf(gate);
  return Math.max(0, state.cooldownUntil - now, state.lastStartAt + minIntervalMs - now);
}

/** 冷却剩余(仅供展示/诊断;闸门判断用 naiPacingDelayMs)。 */
export function naiCooldownRemainingMs(now: number = Date.now(), gate: string = DEFAULT_NAI_GATE): number {
  return Math.max(0, pacingOf(gate).cooldownUntil - now);
}

/**
 * 最小间隔的唯一旋钮。生产代码不调(常量即口径),留给单测把间隔关掉,
 * 好让「并发」与「节奏」两组测试互不干扰。
 */
export function setNaiMinInterval(ms: number): void {
  minIntervalMs = Math.max(0, ms);
}

/** 复位所有闸门的节奏状态(不动最小间隔,那是 setNaiMinInterval 的事)。 */
export function resetNaiPacing(): void {
  pacing.clear();
}

/* ============ 可取消的等待 ============ */

/**
 * setTimeout 的可取消版:等待期间用户点「取消」要立刻抛 AbortError,
 * 不能让卡片按着「取消」还傻等几十秒退避。
 *
 * (backends/comfyui.ts 有一份同形的私有实现。刻意不合并:那是另一个后端的内部工具,
 * 为一个 15 行的 promise 原语让 comfy 去 import nai 的模块不值当。)
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ============ 重试执行器 ============ */

/** 重试进度回报:卡片据此把「生成中…」换成重试文案。 */
export interface NaiRetryInfo {
  /** 即将开始的是第几次重试(1 起)。 */
  attempt: number;
  /** 最多重试几次。 */
  max: number;
  /** 本次要等多久(ms)。 */
  waitMs: number;
  /** 触发本次重试的错误。 */
  error: unknown;
}

export interface NaiRetryOptions {
  signal?: AbortSignal;
  /** 记账到哪个闸门(接入点 id);须与调用方取槽时的闸门一致。 */
  gate?: string;
  onRetry?: (info: NaiRetryInfo) => void;
  /** 等待实现。留给单测注入,免得跑一遍测试真睡几十秒。 */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 鸭子类型取状态码与 Retry-After:不 import NaiError,免成环(见 shouldRetryNai)。 */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

function errorRetryAfterMs(error: unknown): number | null {
  const ms = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof ms === 'number' ? ms : null;
}

/**
 * 跑一次 NAI 请求,失败且可重试则退避后重来,最多 NAI_MAX_ATTEMPTS 次。
 *
 * run 必须是**可重跑**的:调用方要把「只该做一次」的准备工作(拼参数、读 vibe 数据)
 * 留在外面,只把真正发请求的那一段包进来。
 *
 * 等待时长取「本次退避」与「闸门节奏」的大值:并发 ≥2 时别的槽位可能刚吃到 429 并
 * 上了更长的冷却,本次重试也得一并遵守,否则冷却只拦得住新任务、拦不住重试。
 */
export async function runNaiWithRetry<T>(
  run: () => Promise<T>,
  opts: NaiRetryOptions = {},
): Promise<T> {
  const { signal, onRetry, delay = abortableDelay, gate = DEFAULT_NAI_GATE } = opts;
  const maxRetries = NAI_MAX_ATTEMPTS - 1;

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const status = errorStatus(error);
      // 不可重试(取消 / key 错 / 订阅过期 / 参数非法)或次数用尽:原样抛出,
      // 保住原错误信息 —— 用户要看的是「API Key 错误」,不是「重试 4 次后失败」。
      if (attempt > maxRetries || !shouldRetryNai(error, status)) throw error;

      const retryAfterMs = errorRetryAfterMs(error);
      // 429 = 对方明确说「太快了」。除了自己退避,还要给整个闸门上冷却,
      // 否则队列里其余任务会在同一秒接着撞上去 —— 那串密集失败才是封号风险所在。
      if (status === 429) noteNaiRateLimited(retryAfterMs, Date.now(), gate);

      const waitMs = Math.max(retryDelayMs(attempt, retryAfterMs), naiPacingDelayMs(Date.now(), gate));
      onRetry?.({ attempt, max: maxRetries, waitMs, error });
      console.warn(
        `[柏宝绘] NAI 请求失败,${Math.round(waitMs / 1000)}s 后重试(第 ${attempt}/${maxRetries} 次):`,
        error,
      );
      await delay(waitMs, signal);
      noteNaiRequestStart(Date.now(), gate);
    }
  }
}
