import { getContext } from '@/st/context';
import { randomUuid } from '@/randomUuid';
import type { ApiChannel } from '@/state/settings';
import {
  beginLlm,
  failLlm,
  finishLlm,
  patchLlmMessages,
  patchLlmTokens,
  safeHistory,
  FOLLOW_MAIN_API,
} from '@/state/history';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 * (与柏宝书 src/api/client.ts 同源,行为保持一致。)
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 酒馆助手实验适配层只依赖这几个方法;不引入它的完整类型包。 */
interface TavernHelperGenerateApi {
  getLoadedPresetName?: () => string;
  getPresetNames?: () => string[];
  getPreset?: (presetName: string) => {
    settings?: {
      reasoning_effort?: string;
    };
  };
  generate(config: {
    generation_id: string;
    preset_name: string;
    user_input: string;
    should_stream: boolean;
    should_silence: true;
    should_return_reasoning: true;
    overrides: { chat_history: { prompts: ChatMsg[]; author_note?: string } };
    custom_api: Record<string, unknown>;
  }): Promise<unknown>;
  stopGenerationById?: (id: string) => boolean;
}

function getTavernHelperGenerate(): TavernHelperGenerateApi | null {
  const api = (globalThis as { TavernHelper?: Partial<TavernHelperGenerateApi> }).TavernHelper;
  return typeof api?.generate === 'function' ? (api as TavernHelperGenerateApi) : null;
}

interface PendingRawApiResponse {
  value: unknown;
  read: Promise<void> | null;
  requestMarker: string;
  wiScanMarker: string;
  wiScanEndMarker: string;
  onMessages?: (messages: ChatMsg[]) => void;
}

/**
 * TH 在 handleResponse 中把上游响应压成 {content, reasoning};要保留 finish_reason/usage/完整 choices,
 * 只能在同一 fetch 响应被 TH 消费前 clone。同时借这一关捕获实际发给 ST 代理的 messages
 * 补录到请求历史(防止正则或第三方钩子改写 prompt 时历史漏录),并在转发前剥离内部关联标记。
 * 所有在途请求共用一个包装器,避免并发嵌套恢复错顺序。
 */
const pendingRawApiResponses = new Map<string, PendingRawApiResponse>();
let originalFetchForRawCapture: typeof fetch | null = null;
let rawCaptureFetch: typeof fetch | null = null;

function stripPresetMarkerText(text: string, marker: string): string {
  if (!marker || !text.includes(marker)) return text;
  return text.replaceAll(`${marker}\n`, '').replaceAll(marker, '');
}

function isGenerateRequestUrl(input: RequestInfo | URL): boolean {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof Request !== 'undefined' && input instanceof Request
          ? input.url
          : '';
  return url.includes(GENERATE_URL);
}

function registerRawApiCapture(
  generationId: string,
  options: {
    requestMarker: string;
    wiScanMarker: string;
    wiScanEndMarker: string;
    onMessages?: (messages: ChatMsg[]) => void;
  },
): void {
  pendingRawApiResponses.set(generationId, {
    value: undefined,
    read: null,
    requestMarker: options.requestMarker,
    wiScanMarker: options.wiScanMarker,
    wiScanEndMarker: options.wiScanEndMarker,
    onMessages: options.onMessages,
  });
  if (rawCaptureFetch) return;
  const original = globalThis.fetch;
  originalFetchForRawCapture = original;
  rawCaptureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    let pending: PendingRawApiResponse | undefined;
    let nextInit = init;
    if (typeof body === 'string' && isGenerateRequestUrl(input)) {
      for (const [id, candidate] of pendingRawApiResponses) {
        if (
          body.includes(id) ||
          body.includes(candidate.requestMarker) ||
          body.includes(candidate.wiScanMarker)
        ) {
          pending = candidate;
          break;
        }
      }
      if (pending) {
        const markers = [pending.requestMarker, pending.wiScanMarker, pending.wiScanEndMarker];
        let cleanedBody = body;
        for (const marker of markers) {
          const escapedMarker = JSON.stringify(marker).slice(1, -1);
          cleanedBody = cleanedBody
            .replaceAll(`${escapedMarker}\\n`, '')
            .replaceAll(escapedMarker, '')
            .replaceAll(`${marker}\n`, '')
            .replaceAll(marker, '');
        }
        if (cleanedBody !== body) {
          nextInit = { ...init, body: cleanedBody };
        }
        if (pending.onMessages) {
          const captured = extractMessagesFromFetchBody(cleanedBody, markers);
          if (captured) pending.onMessages(captured);
        }
      }
    }
    const response = await original.call(globalThis, input, nextInit);
    if (pending) {
      const cloned = response.clone();
      pending.read = readClonedRawApiPayload(cloned)
        .then(data => {
          pending.value = data;
        })
        .catch(error => {
          console.debug('[柏宝绘] 原始 API 响应克隆解析失败(已忽略)', error);
        });
    }
    return response;
  };
  globalThis.fetch = rawCaptureFetch;
}

/** 从发给 /api/backends/chat-completions/generate 的 JSON 请求体中提取最终 messages 列表。 */
function extractMessagesFromFetchBody(body: string, markers: string[]): ChatMsg[] | null {
  try {
    const parsed = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(parsed?.messages)) return null;
    const out: ChatMsg[] = [];
    for (const item of parsed.messages) {
      if (!item || typeof item !== 'object') continue;
      const role = (item as { role?: unknown }).role;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
      let content = textOf((item as { content?: unknown }).content);
      for (const marker of markers) {
        content = stripPresetMarkerText(content, marker);
      }
      out.push({ role, content });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** 兼容普通 JSON 与 SSE 流式响应的原始诊断信息提取,失败时保留 finish_reason / error / 部分增量。 */
async function readClonedRawApiPayload(cloned: Response): Promise<unknown> {
  const contentType = cloned.headers?.get?.('content-type') ?? '';
  const text = await cloned.text();
  if (!text.trim()) {
    return { status: cloned.status, contentType, body: '' };
  }
  if (!contentType.includes('text/event-stream') && !text.trimStart().startsWith('data:')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  let content = '';
  let reasoning = '';
  const finishReasons: string[] = [];
  const errors: unknown[] = [];
  let usage: unknown;
  let lastEvent: unknown;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      lastEvent = parsed;
      if (parsed?.error) errors.push(parsed.error);
      if (parsed?.usage) usage = parsed.usage;
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      const piece = textOf(delta?.content) || textOf(choice?.text);
      if (piece) content += piece;
      const rPiece = textOf(delta?.reasoning) || textOf(delta?.reasoning_content) || textOf(delta?.thinking);
      if (rPiece) reasoning += rPiece;
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finishReasons.push(choice.finish_reason);
      }
    } catch {
      // 忽略单行非 JSON 注释或心跳
    }
  }
  return {
    stream: true,
    status: cloned.status,
    finish_reasons: finishReasons,
    ...(usage !== undefined ? { usage } : {}),
    ...(errors.length ? { errors } : {}),
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(lastEvent !== undefined ? { last_event: lastEvent } : {}),
  };
}

async function readRawApiResponse(generationId: string): Promise<unknown> {
  const pending = pendingRawApiResponses.get(generationId);
  await pending?.read;
  return pending?.value;
}

function unregisterRawApiCapture(generationId: string): void {
  pendingRawApiResponses.delete(generationId);
  if (pendingRawApiResponses.size || !rawCaptureFetch) return;
  // 其他插件在期间又包了 fetch 时不覆盖它;正常运行则恢复原函数。
  if (globalThis.fetch === rawCaptureFetch && originalFetchForRawCapture) {
    globalThis.fetch = originalFetchForRawCapture;
  }
  rawCaptureFetch = null;
  originalFetchForRawCapture = null;
}

/** 当前预设实验模式是否可调用。 */
export function currentPresetAvailable(): boolean {
  return getTavernHelperGenerate() !== null;
}

/** 读取成功返回名列表;TH 未加载、接口缺失或读取异常返回 null,调用方不得据此误判预设已删除。 */
function readStPresetNames(): string[] | null {
  const helper = getTavernHelperGenerate();
  if (!helper?.getPresetNames) return null;
  try {
    return helper.getPresetNames().filter(name => typeof name === 'string' && name.trim() && name !== 'in_use');
  } catch {
    return null;
  }
}

/** ST 已保存的聊天补全预设名;in_use 是当前未保存状态的伪预设,不列入可指定项。 */
export function listStPresetNames(): string[] {
  return readStPresetNames() ?? [];
}

/** 指定预设是否仍存在;null = 当前无法确认。 */
export function isStPresetAvailable(name: string): boolean | null {
  return readStPresetNames()?.includes(name) ?? null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留,避免破坏 /v2/coding 等自定义路由。
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 测试渠道时备用的 /v1 形式。只在首个地址明确返回 404/405 时才会尝试。 */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * 用途标签,只用于请求历史页的展示(如「自动 tag」)。
   * 不传也不影响请求本身,历史里显示为「未标注」。
   */
  source?: string;
  /**
   * 调用方验收回调:拿到文本后、记入历史前执行。
   *
   * 历史里「成功」的口径是「调用方验收通过」,不是「HTTP 拿到了文本」——
   * 否则「返回了但协议解析不过 → 调用方重试」会留下两条绿色成功记录,
   * 看历史的人会误以为成功也重复调用。验收抛错 = 记为失败并把错误原样抛出,
   * 由调用方决定重试/放弃。
   */
  validate?: (content: string) => void;
}

/* ============ 请求历史埋点(纯辅助,绝不允许影响主流程) ============ */

/** 从响应体取 OpenAI 标准 usage。ST 代理非流式分支原样透传上游 JSON,故这里拿到的是真值。 */
function readUsage(data: any): { prompt: number | null; completion: number | null } {
  const usage = data?.usage;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    prompt: num(usage?.prompt_tokens),
    completion: num(usage?.completion_tokens),
  };
}

/**
 * 本地估算 token(拿不到真值时的兜底):流式与「跟随主 API」两条路都没有 usage。
 *
 * 用 ST 的 getTokenCountAsync —— 但它用的是**主界面当前模型**的分词器,
 * 与副 API 渠道的模型未必同源,所以结果只能当估算,UI 上以 ≈ 标注。
 * 任何失败都降级为 null(不显示数字),不抛。
 */
async function estimateTokens(id: number, messages: ChatMsg[], response: string): Promise<void> {
  try {
    const count = getContext()?.getTokenCountAsync;
    if (typeof count !== 'function') return;
    const promptText = messages.map(m => m.content).join('\n');
    const prompt = await count(promptText);
    const completion = response ? await count(response) : 0;
    safeHistory(() =>
      patchLlmTokens(
        id,
        typeof prompt === 'number' ? prompt : null,
        typeof completion === 'number' ? completion : null,
      ),
    );
  } catch (e) {
    console.debug('[柏宝绘] token 估算失败(已忽略)', e);
  }
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * 给完整请求生命周期套超时:不仅覆盖 fetch 建连,也覆盖非流式 JSON 读取和流式 SSE 读取。
 * 外部 signal 仍可提前取消;只有本定时器触发时才转换成明确的超时报错。
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label}超时(>${timeoutSec}秒)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

/**
 * 构造发给 ST 代理的请求体(纯函数,便于测两条分支的产物)。
 *
 * 两条分支,按渠道有没有设思考强度二选一:
 *
 * ① 未设(reasoningEffort 为空 = auto):走 `chat_completion_source: 'openai'`,
 *    除下面固定的 `tool_choice` 外,与加本功能之前**逐字节一致**——存量用户零变化。
 *
 * ② 已设:走 `'custom'`。因为 ST 代理对 openai 源的 reasoning_effort 卡**模型名白名单**
 *    (src/constants.js 的 OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),
 *    模型名对不上就静默丢弃、还照样返回 200(实测确认),用户设了却无效且看不出来。
 *    custom 源的 custom_include_body 由服务端 mergeObjectWithYaml 直接并进上游请求体,
 *    不过任何白名单,任意字段/嵌套对象都能透传。
 *
 * 两条路都仍然走 ST 服务端转发(同一个 /generate 端点),没有浏览器直连,
 * 因此 CORS、密钥不落浏览器、SSE 转发等性质完全不变。
 *
 * custom 源的两个坑(都已规避):
 * - 它**不读 proxy_password**,只读 ST 自己存的 Custom 密钥,所以 key 必须靠
 *   custom_include_headers 注入 Authorization(服务端 `...headers` 排在默认
 *   Authorization 之后,覆盖成立);
 * - custom_include_* 是 YAML 字符串且**解析失败会静默忽略**(util.js 的 catch 是空的)。
 *   key 里带 `:` `#` `{` 或以 `*` 开头都会让 YAML 解析炸 → header 没注入 →
 *   退回用 ST 的 Custom 密钥,可能把用户另一个服务商的 key 发到本端点。
 *   故一律用 JSON.stringify 生成(YAML 是 JSON 的超集),转义交给它,不手拼。
 *
 * 另:请求体固定带 `tool_choice: 'none'`,这是给第三方 fetch 拦截器的声明式放行握手。
 * 酒馆助手预设脚本(如 Kemini Dramatron 面板)可能 monkey-patch `window.parent.fetch`,
 * 拦截所有 `/api/backends/…/generate` 请求并注入合成工具 + 控制消息,让模型把整段输出
 * 塞进工具调用。对生图 tag 这种「要严格 JSON 协议」的请求,它会把控制消息插进对话、
 * 诱导模型改用工具调用而非直接输出 JSON,拖慢数倍甚至逼出重试。
 * 这类拦截器普遍支持「调用方自带 tool_choice 就放行」(Dramatron 的 callerControlsTools
 * 对 'none' 明确 bypass),所以我们主动声明不用工具。
 * 对上游无影响:ST 服务端只在 tools 为非空数组时才转发 tool_choice
 * (src/endpoints/backends/chat-completions.js),本函数从不发 tools,该字段到不了服务商。
 *
 * (与柏宝书 src/api/client.ts 的同名函数同源,行为保持一致。)
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  stream: boolean,
): Record<string, unknown> {
  const effort = channel.reasoningEffort?.trim() ?? '';
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // 不用工具:见函数头注释,防第三方 fetch 拦截器把生图 tag 改写成工具调用
    tool_choice: 'none',
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url || !channel.model) throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');

  const stream = channel.stream ?? false;
  const body = buildRequestBody(channel, messages, reverseProxy, stream);

  const timeoutSec = validTimeoutSec(channel.timeoutSec);

  // 历史埋点:登记在真正发请求之前,失败/超时也留痕(排查时要看的往往正是失败那次)。
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || '未标注',
      channelName: channel.name || channel.model || '(未命名渠道)',
      model: channel.model,
      stream,
      messages,
    }),
  );

  try {
    const result = await withTimeout(timeoutSec, opts.signal, '副 API 请求', async signal => {
      const resp = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`, resp.status);
      }

      // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
      if (stream) {
        const streamed = await readSseContent(resp);
        if (!streamed) throw new ApiError('空回复');
        // 流式无 usage:ST 构造上游请求体是字段白名单,不含 stream_options,
        // 没法让上游在末尾回 usage chunk。只能事后本地估算。
        return { content: streamed, usage: { prompt: null, completion: null } };
      }

      const data = await resp.json();
      if (data?.error) {
        throw new ApiError(data.error.message || '副 API 返回错误');
      }

      const parsed = extractContent(data);
      if (!parsed) throw new ApiError('空回复');
      // ST 代理非流式分支是 response.send(json) 原样透传,故 usage 是上游真值。
      return { content: parsed, usage: readUsage(data) };
    });

    // 验收在记历史之前:验收不过 → 落进 catch 记失败,不给「HTTP 成功」的假象
    opts.validate?.(result.content);

    if (historyId !== null) {
      const hasReal = result.usage.prompt !== null;
      safeHistory(() =>
        finishLlm(historyId, {
          response: result.content,
          promptTokens: result.usage.prompt,
          completionTokens: result.usage.completion,
          tokensEstimated: false,
        }),
      );
      // 没有真值(流式)才估算。估算是异步的,不 await——不能让它拖慢主流程。
      if (!hasReal) void estimateTokens(historyId, messages, result.content);
    }
    return result.content;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      safeHistory(() => failLlm(historyId, e instanceof Error ? e.message : String(e), aborted));
    }
    throw e;
  }
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 * 推理模型的思维链增量(delta.reasoning 等)单独缓冲:只有 content 全空时才回退用它,
 * 避免在 content 正常时把思维链混进正文。
 */
export async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // 无法流式读取(理论上不会):退回当作整体 JSON 处理
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let reasoningOut = '';
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按行解析,保留最后一段不完整的行到下次
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
        const choice = json?.choices?.[0];
        const src = choice?.delta ?? choice?.message;
        const piece = textOf(src?.content) || textOf(choice?.text);
        if (piece) out += piece;
        const reasoningPiece =
          textOf(src?.reasoning) || textOf(src?.reasoning_content) || textOf(src?.thinking);
        if (reasoningPiece) reasoningOut += reasoningPiece;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // 单行解析失败忽略(可能是注释行/心跳)
      }
    }
  }
  return out.trim() || reasoningOut.trim();
}

/** 把可能是 string / content-parts 数组 / 其他类型的值转成文本;非字符串成分一律丢弃。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

/**
 * 从响应体提取答案文本。
 * 标准链:message.content / choices[0].text / data.content;
 * 推理模型(如 deepseek-v4-flash)可能把整段答案(思维链+最终 JSON)全放进
 * reasoning / reasoning_content / thinking 而 content 为空——标准链全空时回退取之,
 * 混入的思维链由 parseImagePlan 的 JSON 块扫描自然剔除。
 */
export function extractContent(data: any): string {
  const msg = data?.choices?.[0]?.message;
  const content =
    textOf(msg?.content) || textOf(data?.choices?.[0]?.text) || textOf(data?.content);
  if (content.trim()) return content.trim();
  return (
    textOf(msg?.reasoning) || textOf(msg?.reasoning_content) || textOf(msg?.thinking)
  ).trim();
}

/* ============ 跟随主 API(主界面当前在用的 API 设置) ============ */

/** 跟随主 API 时的响应上限:够装下思维链 + 输出,避免被主 API 默认 max tokens 截断。 */
const MAIN_API_RESPONSE_LENGTH = 65535;

/**
 * 是否具备「跟随主 API」的条件:ST 暴露了 generateRaw(稳定 API)即可。
 * 不再依赖连接管理/连接档——直接借用主界面当前正在用的 API。
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次补全。
 * 走 ST 的 generateRaw:只发我们给的这几条消息,不带聊天历史/角色卡;无需连接档。
 * quiet 类型内部强制非流式,返回清洗后的整段文本;失败抛 ApiError。
 *
 * ⚠️ 这条路径的请求体由 ST 构造,带不上 `tool_choice: 'none'`,第三方 fetch 拦截器
 * (如 Kemini 防截断脚本)仍可能改写它。生成 tag 尽量指派副 API 渠道,走 buildRequestBody 那条路。
 */
export async function requestViaMainApi(messages: ChatMsg[], opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw new ApiError('当前 ST 版本不支持 generateRaw,无法跟随主 API');
  }

  // 历史埋点。跟随主 API 走 ST 内部黑盒,拿不到 usage,token 一律靠估算。
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || '未标注',
      channelName: FOLLOW_MAIN_API,
      model: '',
      stream: false,
      messages,
    }),
  );

  try {
    const content = (await ctx.generateRaw({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
    if (!content) throw new ApiError('空回复');
    // 与副 API 同口径:验收不过记失败,不记「成功」
    opts.validate?.(content);
    if (historyId !== null) {
      safeHistory(() =>
        finishLlm(historyId, {
          response: content,
          promptTokens: null,
          completionTokens: null,
          tokensEstimated: true,
        }),
      );
      void estimateTokens(historyId, messages, content);
    }
    return content;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      safeHistory(() => failLlm(historyId, e instanceof Error ? e.message : String(e), aborted));
    }
    throw e;
  }
}

/* ============ ST 当前预设(实验,经酒馆助手) ============ */

export const CURRENT_PRESET_CHANNEL = '当前预设（名称不可用）';

/**
 * 预设模式仅放行的 ST 宿主内置 extension_prompts 白名单:
 * - 世界书深度条目(customDepthWI-*)、角色卡深度备注(DEPTH_PROMPT)、用户人设(PERSONA_DESCRIPTION)、
 *   酒馆助手自身一次性临时输入/指定预设 in_chat 注入(TEMP_USER_MESSAGE / TH-CustomInjects-*)。
 * 其余全局挂在 extension_prompts 下的条目(如柏宝书的主聊记忆简报与 D0 时间锚点强令续写、
 * Horae 分割锚点、剧情引导、作者注、日程表等)都是面向主聊天剧情续写的,在预设组装期间一律屏蔽,
 * 组装完成后立刻按快照还原,避免主聊续写指令劫持生图任务且不影响主聊天。
 */
function isAllowedPresetExtensionPromptKey(key: string): boolean {
  return (
    key === 'DEPTH_PROMPT' ||
    key === 'PERSONA_DESCRIPTION' ||
    key === 'TEMP_USER_MESSAGE' ||
    key.startsWith('customDepthWI-') ||
    key.startsWith('TH-CustomInjects-')
  );
}

/**
 * 屏蔽主聊续写类全局 extension_prompts,返回幂等恢复函数。
 *
 * 关键细节:不用 `delete extensionPrompts[key]`,而是把原对象保留在快照里、原地替换成 `{ ...entry, value: '' }`。
 * 原因:ST 宿主(如 world-info.js:5290 读取 `extensionPrompts['2_floating_prompt'].value`)会假定已知 key
 * 对应的对象存在而直接访问 `.value`,删掉整条对象会直接抛 TypeError。
 * 同时在 `2_floating_prompt` 缺失时补一个空值占位(并记录是否原本存在以便还原),
 * 避免 `overrides.chat_history.author_note: ''` 让酒馆助手跳过 `setAuthorNotePrompt` 时宿主再踩空。
 *
 * 在 CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_DATA(预设已组装完毕、即将发 HTTP 请求前)或 finally 时立即还原,
 * 窗口仅覆盖本地内存组装的几十毫秒,绝不在等待模型生成的几十秒里持续遮挡主聊天。
 */
interface SavedExtensionPromptEntry {
  existed: boolean;
  entry?: Record<string, unknown>;
  maskedRef?: Record<string, unknown>;
}
let activeExtensionPromptShields = 0;
let savedExtensionPromptsSnapshot: Map<string, SavedExtensionPromptEntry> | null = null;
let presetExtensionPromptMaskDepth = 0;

function maskSingleExtensionPrompt(
  extensionPrompts: Record<string, Record<string, unknown>>,
  key: string,
): void {
  if (isAllowedPresetExtensionPromptKey(key)) return;
  const current = extensionPrompts[key];
  if (!current || typeof current !== 'object') return;
  if (savedExtensionPromptsSnapshot && !savedExtensionPromptsSnapshot.has(key)) {
    savedExtensionPromptsSnapshot.set(key, { existed: true, entry: current });
  }
  const masked = { ...current, value: '', scan: false };
  const snap = savedExtensionPromptsSnapshot?.get(key);
  if (snap) snap.maskedRef = masked;
  extensionPrompts[key] = masked;
}

function suspendMainChatExtensionPrompts(
  extensionPrompts: Record<string, Record<string, unknown>> | undefined,
): () => void {
  if (!extensionPrompts || typeof extensionPrompts !== 'object') return () => undefined;
  let released = false;

  if (activeExtensionPromptShields === 0) {
    savedExtensionPromptsSnapshot = new Map();
  }
  activeExtensionPromptShields += 1;
  presetExtensionPromptMaskDepth += 1;

  for (const key of Object.keys(extensionPrompts)) {
    maskSingleExtensionPrompt(extensionPrompts, key);
  }
  // world-info.js:5290 在 shouldWIAddPrompt 为真时会无保护读取 extensionPrompts['2_floating_prompt'].value;
  // 无论该键此前是否存在,确保它总是一个带空串 value 的对象(还原时按 existed 精确复原)。
  if (!('2_floating_prompt' in extensionPrompts)) {
    const placeholder = { value: '', position: 1, depth: 4, scan: false, role: 0 };
    savedExtensionPromptsSnapshot?.set('2_floating_prompt', {
      existed: false,
      maskedRef: placeholder,
    });
    extensionPrompts['2_floating_prompt'] = placeholder;
  }

  return () => {
    if (released) return;
    released = true;
    activeExtensionPromptShields = Math.max(0, activeExtensionPromptShields - 1);
    presetExtensionPromptMaskDepth = Math.max(0, presetExtensionPromptMaskDepth - 1);
    if (activeExtensionPromptShields === 0 && savedExtensionPromptsSnapshot) {
      for (const [key, saved] of savedExtensionPromptsSnapshot) {
        // 还原条件:当前仍是我们放置的 maskedRef(或被宿主清空),防止覆盖期间外部主动写入的新值;
        // 特殊处理 2_floating_prompt:checkWorldInfo 在组装期间可能把世界书 AN 拼进它,必须无条件还原回主聊原值。
        const current = extensionPrompts[key];
        const untouched = current === saved.maskedRef || current === undefined;
        if (!untouched && key !== '2_floating_prompt') continue;
        if (saved.existed && saved.entry) {
          extensionPrompts[key] = saved.entry;
        } else {
          delete extensionPrompts[key];
        }
      }
      savedExtensionPromptsSnapshot = null;
    }
  };
}

/**
 * 组装窗口期临时接管 ST 内置的 `{{lastUserMessage}}` 宏:
 * 79 个主流预设里有 34 个会在 `chatHistory` 之后通过 `{{lastUserMessage}}` 重申“本轮最新输入”
 * (包裹标签五花八门:<user_input>/<inputs>/<UserInput>/<Last_inputs>/<latest_human_message>/<dreamer_input> 等)。
 * 若不接管,它会直接读取主聊天窗口的上一句玩家对话(比如“继续写下一段”或旧场景台词),把副请求劫持回续写。
 *
 * 这里用 ST 原生宏机制把 `lastUserMessage` 在预设组装窗口内临时指向本轮生图指令(简洁任务摘要),
 * 并在 `CHAT_COMPLETION_PROMPT_READY` / finally 时立即还原原 handler,完全不依赖猜任何预设的标签名或措辞。
 */
const LAST_USER_MESSAGE_OVERRIDE_TEXT =
  '为上方已完结的「目标正文」提取插画分镜并直接输出 <thinking>...</thinking> + 唯一合法 JSON 对象（不要续写小说正文，忽略小说附加栏目）。';

interface SavedMacroHandler {
  entry: { handler?: (...args: unknown[]) => unknown };
  originalHandler: (...args: unknown[]) => unknown;
  wrappedHandler: (...args: unknown[]) => unknown;
}
let activeMacroOverrides = 0;
let savedLastUserMessageMacro: SavedMacroHandler | null = null;

function suspendLastUserMessageMacro(
  context: ReturnType<typeof getContext>,
  overrideText: string,
): () => void {
  const entry = context?.macros?.registry?.getMacro?.('lastUserMessage');
  if (!entry || typeof entry.handler !== 'function') return () => undefined;
  let released = false;

  if (activeMacroOverrides === 0) {
    const originalHandler = entry.handler;
    const wrappedHandler = () => overrideText;
    entry.handler = wrappedHandler;
    savedLastUserMessageMacro = { entry, originalHandler, wrappedHandler };
  }
  activeMacroOverrides += 1;

  return () => {
    if (released) return;
    released = true;
    activeMacroOverrides = Math.max(0, activeMacroOverrides - 1);
    if (activeMacroOverrides === 0 && savedLastUserMessageMacro) {
      const { entry: savedEntry, originalHandler, wrappedHandler } = savedLastUserMessageMacro;
      if (savedEntry.handler === wrappedHandler) {
        savedEntry.handler = originalHandler;
      }
      savedLastUserMessageMacro = null;
    }
  };
}

/**
 * 针对旧版 ST(无 macros.registry.getMacro)或未走宏观系统的预设条目兜底清空
 * 常见主聊旧输入占位标签(<user_input>/<inputs>/<writing_prompt>)。
 */
function stripStalePresetUserInputTags(text: string): string {
  let out = text;
  if (/<user_input>/i.test(out)) {
    out = out.replace(/<user_input>[\s\S]*?<\/user_input>/gi, '<user_input>\n</user_input>');
  }
  if (/<inputs>/i.test(out)) {
    out = out.replace(/<inputs>[\s\S]*?<\/inputs>/gi, '<inputs>\n</inputs>');
  }
  if (/<writing_prompt>/i.test(out)) {
    out = out.replace(/<writing_prompt>[\s\S]*?<\/writing_prompt>/gi, '<writing_prompt>\n</writing_prompt>');
  }
  return out;
}

/**
 * 使用 ST 当前/指定预设生成 tag;API 可跟随主界面,也可通过 custom_api 使用指派副渠道。
 *
 * 与 generateRaw 不同,酒馆助手 generate 会走当前预设、角色卡、世界书、破限和生成参数。
 * 为确保对任意 ST 预设通用(不做任何单预设关键词特化),完全顺应所有 ST 预设共有的 `chatHistory` 骨架:
 * 1. 预设组装窗口内:
 *    - 按白名单临时屏蔽主聊续写类 extension_prompts(仅放行世界书/角色卡/人设);
 *    - 临时接管 `{{lastUserMessage}}` 宏指向本轮生图任务,防止主聊上一句台词串台;
 *    组装完成后(CHAT_COMPLETION_PROMPT_READY)立即还原,绝不拖到网络等待期;
 * 2. user_input 只传纯文本请求标记(不让生图规范与目标正文经过 USER_INPUT 正则与宏管线);
 * 3. overrides.chat_history.prompts 仅放入带扫描标记的纯剧情文本供 TH 激活世界书关键词;
 * 4. 在 CHAT_COMPLETION_PROMPT_READY 中认领本次请求,就地把 `chatHistory` 槽位里的临时扫描消息与占位
 *    user_input 替换为完整的生图规范/只读剧情素材/任务指令,保留预设前后半段的原有位置、角色与末尾破限/卡CoT;
 *    若预设后半段本身较长,在其最后再附一条极短的 JSON 交付格式提醒(不动末尾非 system 的卡CoT 角色锁);
 * 5. 在 CHAT_COMPLETION_SETTINGS_READY 中清空预设的 assistant_prefill,并在无 tools 时设 tool_choice:'none'。
 */
/**
 * 解析所选 ST 预设里保存的 reasoning_effort:
 * - 'auto' / 空串 / 未定义 → 返回 ''(不发送该参数,交由模型/服务端默认);
 * - ST 预设常用 'min' 表示最低档,OpenAI 兼容接口通用词是 'minimal',这里顺手映射;
 * - 其余值(low/medium/high/max/none/off 等)原样返回。
 */
function readPresetReasoningEffort(
  helper: TavernHelperGenerateApi,
  selectedPreset: string,
  context: ReturnType<typeof getContext>,
): string {
  let raw = '';
  try {
    const presetEffort = helper.getPreset?.(selectedPreset)?.settings?.reasoning_effort;
    if (typeof presetEffort === 'string') raw = presetEffort.trim();
  } catch {
    // 旧版 TH 或预设读取失败时回退主界面当前预设设置
  }
  if (!raw && selectedPreset === 'in_use') {
    const fallback = context?.chatCompletionSettings?.reasoning_effort;
    if (typeof fallback === 'string') raw = fallback.trim();
  }
  if (!raw || raw.toLowerCase() === 'auto') return '';
  if (raw.toLowerCase() === 'min') return 'minimal';
  return raw;
}

export async function requestViaPreset(
  promptOrMessages: string | ChatMsg[],
  opts: RequestOptions & {
    presetName?: string;
    channel?: ApiChannel;
    worldInfoScanPrompts?: ChatMsg[];
  } = {},
): Promise<string> {
  const helper = getTavernHelperGenerate();
  if (!helper) {
    throw new ApiError('预设模式需要安装并启用「酒馆助手」，或请切回独立组装模式');
  }
  const namedPreset = opts.presetName !== undefined;
  const selectedPreset = opts.presetName?.trim() || 'in_use';
  if (namedPreset && selectedPreset === 'in_use') throw new ApiError('请先选择要用于生成 tag 的 ST 预设');
  const channel = opts.channel;
  if (channel && (!channel.url || !channel.model)) {
    throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');
  }

  const context = getContext();
  const customApi: Record<string, unknown> = { max_tokens: channel?.maxTokens ?? MAIN_API_RESPONSE_LENGTH };
  if (channel) {
    const excludes = new Set((channel.excludeParams ?? []).map(value => value.trim()).filter(Boolean));
    // 副渠道在预设模式下:
    // - 渠道自身填了具体思考强度(如 none/low/high/max) → 用渠道值覆盖;
    // - 渠道思考强度为 auto(空串) → 自动沿用所选 ST 预设里的 reasoning_effort(预设也是 auto 则不发)。
    const effectiveEffort =
      channel.reasoningEffort?.trim() || readPresetReasoningEffort(helper, selectedPreset, context);
    customApi.apiurl = normalizeUrl(channel.url);
    customApi.key = channel.key || '';
    customApi.source = effectiveEffort && !excludes.has('reasoning_effort') ? 'custom' : 'openai';
    if (!excludes.has('model')) customApi.model = channel.model;
    if (!excludes.has('temperature')) customApi.temperature = channel.temperature ?? 1;
    // TH 从预设构造请求;排除标准参数必须显式 unset,只省略会继续沿用预设里的值。
    for (const key of ['temperature', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k']) {
      if (excludes.has(key)) customApi[key] = 'unset';
    }
    if (customApi.source === 'custom') {
      if (effectiveEffort && !excludes.has('reasoning_effort')) {
        customApi.custom_include_body = { reasoning_effort: effectiveEffort };
      }
      if (excludes.size) customApi.custom_exclude_body = [...excludes];
    }
  }

  const generationId = `bbi-autotag-${randomUuid()}`;
  // 用纯文本令牌而非 HTML 注释:部分预设或用户正则会清掉 <!-- ... -->(或 USER_INPUT 正则直接改写 user_input),
  // 同时把扫描消息里的 wiScanMarker 一并作为并发认领锚点,即便 user_input 被正则全量替换也能精确命中本次请求。
  const requestMarker = `[BBI_REQ:${generationId}]`;
  const wiScanMarker = `[BBI_WI:${generationId}]`;
  const wiScanEndMarker = `[BBI_WI_END:${generationId}]`;
  const tailMessages = normalizePresetTailMessages(promptOrMessages);
  let presetName = selectedPreset === 'in_use' ? CURRENT_PRESET_CHANNEL : selectedPreset;
  if (selectedPreset === 'in_use') {
    try {
      presetName = helper.getLoadedPresetName?.().trim() || presetName;
    } catch {
      // 名称只是历史展示;旧版 TH 或查询失败不影响生成。
    }
  }
  // 预设模式的流式开关:有指派副渠道时严格遵从渠道设置里的 stream 勾选;
  // 跟随主 API 时沿用当前聊天补全预设的 stream_openai 开关。
  const shouldStream = channel
    ? Boolean(channel.stream)
    : Boolean(context?.chatCompletionSettings?.stream_openai);
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || '未标注',
      channelName: presetName,
      model: channel?.model ?? '',
      stream: shouldStream,
      messages: tailMessages,
    }),
  );
  const onAbort = () => helper.stopGenerationById?.(generationId);
  type RemovableEventSource = NonNullable<typeof context>['eventSource'] & {
    removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  };
  const eventSource = context?.eventSource as RemovableEventSource | undefined;
  const generationAfterCommandsEvent =
    context?.eventTypes.GENERATION_AFTER_COMMANDS ?? 'generation_after_commands';
  const promptReadyEvent = context?.eventTypes.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready';
  const afterDataEvent = context?.eventTypes.GENERATE_AFTER_DATA ?? 'generate_after_data';
  const settingsReadyEvent = context?.eventTypes.CHAT_COMPLETION_SETTINGS_READY ?? 'chat_completion_settings_ready';
  const markers = [requestMarker, wiScanMarker, wiScanEndMarker];
  const recordActualMessages = (messages: ChatMsg[]) => {
    if (historyId === null || !messages.length) return;
    safeHistory(() => patchLlmMessages(historyId, messages));
  };
  let releaseExtensionPromptShield: (() => void) | null = null;
  let releaseLastUserMessageMacro: (() => void) | null = null;
  const restoreAssemblyGuards = () => {
    releaseExtensionPromptShield?.();
    releaseExtensionPromptShield = null;
    releaseLastUserMessageMacro?.();
    releaseLastUserMessageMacro = null;
  };
  const onGenerationAfterCommands = () => {
    // 像 Horae 这类插件会在 GENERATION_AFTER_COMMANDS 现场往 extension_prompts 里注入一次性锚点;
    // 在组装期护盾仍开启时同步置空新落入的非白名单项,避免漏进本次副请求。
    if (presetExtensionPromptMaskDepth <= 0) return;
    const ext = context?.extensionPrompts;
    if (!ext || typeof ext !== 'object') return;
    for (const key of Object.keys(ext)) {
      maskSingleExtensionPrompt(ext, key);
    }
  };
  const hasMacroOverride = Boolean(context?.macros?.registry?.getMacro?.('lastUserMessage'));
  let promptRearranged = false;
  let capturedFromSettingsOrFetch = false;
  const onPromptReady = (eventData: unknown) => {
    if (
      rearrangePresetPromptInPlace(
        eventData,
        requestMarker,
        wiScanMarker,
        wiScanEndMarker,
        tailMessages,
        !hasMacroOverride,
      )
    ) {
      promptRearranged = true;
      // 预设消息已组装完成,立刻还原全局 extension_prompts 与宏,不把屏蔽期拖到整个网络等待期间。
      restoreAssemblyGuards();
      // 重排后立即同步一次真实提示词:即使后续 generate_after_data 未触发或被其他插件吞掉,历史也不会只剩初始占位。
      const snapshot = extractPresetMessagesFromList((eventData as { chat?: unknown })?.chat, markers);
      if (snapshot && !capturedFromSettingsOrFetch) recordActualMessages(snapshot);
    }
  };
  const onGenerateData = (data: unknown) => {
    // 兜底:若宿主/测试桩未触发 chat_completion_prompt_ready 而直接派发 generate_after_data,在此补做一次重排。
    if (!promptRearranged && data && typeof data === 'object') {
      const promptList = (data as { prompt?: unknown }).prompt;
      if (Array.isArray(promptList)) {
        promptRearranged = rearrangePresetPromptInPlace(
          { chat: promptList, dryRun: false },
          requestMarker,
          wiScanMarker,
          wiScanEndMarker,
          tailMessages,
          !hasMacroOverride,
        );
      }
    }
    const actual = extractActualPresetMessages(data, markers);
    if (!actual) return;
    restoreAssemblyGuards();
    if (capturedFromSettingsOrFetch) return;
    recordActualMessages(actual);
  };
  const onSettingsReady = (generateData: unknown) => {
    if (!generateData || typeof generateData !== 'object') return;
    const data = generateData as Record<string, unknown>;
    const actual = extractPresetMessagesFromList(data.messages, markers);
    if (!actual) return;
    restoreAssemblyGuards();
    // 清空预设自带的 assistant_prefill(如 "Keeper: " / "<blend>" 等起笔预填),避免模型起手被锁死在续写小说。
    if (typeof data.assistant_prefill === 'string' && data.assistant_prefill.length > 0) {
      data.assistant_prefill = '';
    }
    // 与独立模式 buildRequestBody 同口径:无 tools 时声明 tool_choice:'none',防第三方 fetch 拦截器劫持。
    const hasTools = Array.isArray(data.tools) && data.tools.length > 0;
    if (!hasTools && data.tool_choice === undefined) {
      data.tool_choice = 'none';
    }
    capturedFromSettingsOrFetch = true;
    recordActualMessages(actual);
  };

  // 世界书扫描消息既用于触发世界书关键词,也在 USER_INPUT 正则整段改写 user_input 时作为认领锚点:
  // overrides.chat_history 不经过 USER_INPUT/AI_OUTPUT 正则管线,即使外部没传扫描文本也放一条轻量占位,
  // 确保任何正则配置下都能精确命中并剔除,不会退回「只剩初始 2 条消息」的失配状态。
  const nonEmptyScanPrompts = (opts.worldInfoScanPrompts ?? []).filter(item => item.content.trim().length > 0);
  const scanPrompts: ChatMsg[] = nonEmptyScanPrompts.length
    ? nonEmptyScanPrompts.map(item => ({
        role: item.role,
        content: `${wiScanMarker}\n${item.content}\n${wiScanEndMarker}`,
      }))
    : [{ role: 'assistant', content: `${wiScanMarker}${wiScanEndMarker}` }];

  let rawResult: unknown;
  let rawApiResult: unknown;
  try {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    releaseExtensionPromptShield = suspendMainChatExtensionPrompts(context?.extensionPrompts);
    releaseLastUserMessageMacro = suspendLastUserMessageMacro(context, LAST_USER_MESSAGE_OVERRIDE_TEXT);
    eventSource?.on(generationAfterCommandsEvent, onGenerationAfterCommands);
    eventSource?.on(promptReadyEvent, onPromptReady);
    eventSource?.on(afterDataEvent, onGenerateData);
    eventSource?.on(settingsReadyEvent, onSettingsReady);
    registerRawApiCapture(generationId, {
      requestMarker,
      wiScanMarker,
      wiScanEndMarker,
      onMessages: messages => {
        restoreAssemblyGuards();
        capturedFromSettingsOrFetch = true;
        recordActualMessages(messages);
      },
    });
    const result = await helper.generate({
      generation_id: generationId,
      preset_name: selectedPreset,
      // user_input 只带请求标记,不让几千字规范和正文被 USER_INPUT 正则包进 <user_input> 或被 ST 宏误替换。
      user_input: requestMarker,
      should_stream: shouldStream,
      should_silence: true,
      // TH 默认只返回 content;推理模型可能把最终 JSON 全放在 reasoning,必须取回详情。
      should_return_reasoning: true,
      overrides: {
        // 屏蔽主聊作者注释,防止作者注里的剧情走向指令误导生图模型。
        chat_history: { prompts: scanPrompts, author_note: '' },
      },
      custom_api: customApi,
    });
    rawResult = result;
    rawApiResult = await readRawApiResponse(generationId);
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // 与独立请求的 extractContent 同口径:正文优先,正文空才回退 reasoning,绝不把两者混拼。
    const content = extractPresetResultContent(result);
    if (!content) {
      console.warn('[柏宝绘] 预设请求的正文与 reasoning 均为空', result);
      throw new ApiError('空回复');
    }
    opts.validate?.(content);
    if (historyId !== null) {
      safeHistory(() =>
        finishLlm(historyId, {
          response: content,
          promptTokens: null,
          completionTokens: null,
          tokensEstimated: false,
        }),
      );
    }
    return content;
  } catch (e) {
    // TH 若在响应到达后的清理/提取阶段抛错,这里仍能等到已克隆的原始响应。
    rawApiResult ??= await readRawApiResponse(generationId);
    if (historyId !== null) {
      const aborted = opts.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError');
      safeHistory(() =>
        failLlm(
          historyId,
          e instanceof Error ? e.message : String(e),
          aborted,
          formatRawPresetResult(rawApiResult !== undefined ? rawApiResult : rawResult),
        ),
      );
    }
    throw e;
  } finally {
    restoreAssemblyGuards();
    unregisterRawApiCapture(generationId);
    opts.signal?.removeEventListener('abort', onAbort);
    if (eventSource?.off) {
      eventSource.off(generationAfterCommandsEvent, onGenerationAfterCommands);
      eventSource.off(promptReadyEvent, onPromptReady);
      eventSource.off(afterDataEvent, onGenerateData);
      eventSource.off(settingsReadyEvent, onSettingsReady);
    } else {
      eventSource?.removeListener?.(generationAfterCommandsEvent, onGenerationAfterCommands);
      eventSource?.removeListener?.(promptReadyEvent, onPromptReady);
      eventSource?.removeListener?.(afterDataEvent, onGenerateData);
      eventSource?.removeListener?.(settingsReadyEvent, onSettingsReady);
    }
  }
}

/**
 * 规整预设模式追加到末尾的任务消息:保留原有分段(任务切面切换、后端规范、协议、思维链、
 * 剧情材料与最终 user 指令),不再强行拼成一条两万多字的巨型 system 消息——
 * 既避免单条超长被请求历史截断而看不见楼层原文,也让历史面板与实际提示词结构一一对应;
 * strict/merge 后处理场景由 ST 服务端转换器按需自动合并连续 system。
 */
function normalizePresetTailMessages(promptOrMessages: string | ChatMsg[]): ChatMsg[] {
  if (typeof promptOrMessages === 'string') {
    return [{ role: 'user', content: promptOrMessages }];
  }
  const nonEmpty = promptOrMessages.filter(msg => msg.content.trim().length > 0);
  if (nonEmpty.length === 0) return [{ role: 'user', content: '' }];
  return nonEmpty.map(msg => ({ role: msg.role, content: msg.content }));
}

/**
 * 在 CHAT_COMPLETION_PROMPT_READY(同步事件)中按 ST 预设通用骨架(`chatHistory` 槽位)就地替换:
 * 1. 仅认领含本次 requestMarker 或 wiScanMarker 的消息数组,绝不触碰主界面正常聊天或其他并发请求;
 * 2. 找到本次请求的 `chatHistory` + `user_input` 槽位(支持 `squash_system_messages` 把扫描块压进合并 system 的情况),
 *    就地替换为生图规范、只读剧情素材与任务指令;
 * 3. **完整保留预设在 `chatHistory` 前后原本的顺序、角色(system/user/assistant)、尾破限与卡 CoT 锁**,
 *    不做任何按特定预设关键词猜词搬家或改写——所有 79+ 预设一视同仁,破限结构与主聊天完全一致;
 * 4. 仅当预设在 `chatHistory` 之后还有后置条目时,在末尾紧邻交付点补一句极轻量的「输出格式提醒」
 *    (若预设故意以短小的 `user`/`assistant` 条目收尾——通常是卡原生 CoT 锁或角色确认——把提醒放在它紧前面,
 *    确保预设原本的收尾锁仍牢牢贴在最末尾)。
 */
const PRESET_FORMAT_REMINDER =
  '[Format Reminder] Follow the companion illustration protocol placed in the chatHistory slot above: do NOT continue prose or output novel widgets/sections; output only `<thinking>...</thinking>` immediately followed by the single valid JSON object (no markdown fences).';

function stripWiScanBlocks(text: string, startMarker: string, endMarker: string): string {
  if (!text.includes(startMarker)) return text;
  let out = text;
  for (;;) {
    const start = out.indexOf(startMarker);
    if (start === -1) break;
    const end = out.indexOf(endMarker, start + startMarker.length);
    if (end === -1) {
      out = out.slice(0, start) + out.slice(start + startMarker.length);
      break;
    }
    out = out.slice(0, start) + out.slice(end + endMarker.length);
  }
  return out;
}

function rearrangePresetPromptInPlace(
  eventData: unknown,
  requestMarker: string,
  wiScanMarker: string,
  wiScanEndMarker: string,
  tailMessages: ChatMsg[],
  fallbackStripStaleUserInput = false,
): boolean {
  if (!eventData || typeof eventData !== 'object') return false;
  const record = eventData as { chat?: unknown; dryRun?: unknown };
  if (record.dryRun === true || !Array.isArray(record.chat)) return false;
  const chat = record.chat as Array<Record<string, unknown>>;
  const hasRequestMarker = chat.some(item => textOf(item?.content).includes(requestMarker));
  const lastWiIndex = chat.reduce(
    (found, item, index) => (textOf(item?.content).includes(wiScanMarker) ? index : found),
    -1,
  );
  if (!hasRequestMarker && lastWiIndex === -1) return false;

  // 若 USER_INPUT 正则把占位 user_input 整段改写(导致 requestMarker 消失),
  // TH 的 handlePresetPath / processChatHistoryAndInject 总会把该条 user 消息紧接在
  // chat_history(即最后一条 wiScanMarker 消息)之后;顺手把这条被改写的占位 user 一并替换。
  let replacedUserPlaceholderIndex = -1;
  if (!hasRequestMarker && lastWiIndex !== -1) {
    for (let i = lastWiIndex + 1; i < chat.length; i++) {
      const candidate = chat[i];
      if (!candidate || typeof candidate !== 'object') continue;
      if (candidate.role === 'user') {
        replacedUserPlaceholderIndex = i;
        break;
      }
      if (candidate.role !== 'system') break;
    }
  }

  // 把整份预设按 chatHistory / user_input 槽位自然切为 beforeSlot + afterSlot 两段,
  // 不破坏预设前后的原有顺序与角色结构。
  const beforeSlot: Array<Record<string, unknown>> = [];
  const afterSlot: Array<Record<string, unknown>> = [];
  let slotReached = false;

  for (let i = 0; i < chat.length; i++) {
    const item = chat[i];
    if (!item || typeof item !== 'object') continue;
    const raw = textOf(item.content);
    const hasReq = raw.includes(requestMarker);
    const hasWi = raw.includes(wiScanMarker);
    const isSlotPlaceholder = hasReq || hasWi || i === replacedUserPlaceholderIndex;

    if (isSlotPlaceholder) {
      slotReached = true;
      // 常规模式:占位 user_input / 世界书扫描消息各自独立成条,整条移除等待原地替换为生图任务。
      // 但若用户勾选了「压缩系统消息」把扫描消息压进了合并 system 块,按起止标记精确切分前后两半保留。
      if (item.role === 'system' && hasWi) {
        const startIdx = raw.indexOf(wiScanMarker);
        const lastEndIdx = raw.lastIndexOf(wiScanEndMarker);
        const beforePart = raw.slice(0, startIdx);
        const afterPart =
          lastEndIdx !== -1 ? raw.slice(lastEndIdx + wiScanEndMarker.length) : '';
        const cleanedBefore = (
          fallbackStripStaleUserInput
            ? stripStalePresetUserInputTags(stripPresetMarkerText(beforePart, requestMarker))
            : stripPresetMarkerText(beforePart, requestMarker)
        ).trim();
        const cleanedAfter = (
          fallbackStripStaleUserInput
            ? stripStalePresetUserInputTags(
                stripPresetMarkerText(stripWiScanBlocks(afterPart, wiScanMarker, wiScanEndMarker), requestMarker),
              )
            : stripPresetMarkerText(stripWiScanBlocks(afterPart, wiScanMarker, wiScanEndMarker), requestMarker)
        ).trim();
        if (cleanedBefore) beforeSlot.push({ ...item, content: cleanedBefore });
        if (cleanedAfter) afterSlot.push({ ...item, content: cleanedAfter });
      }
      continue;
    }

    const processed =
      fallbackStripStaleUserInput && typeof item.content === 'string'
        ? (() => {
            const cleaned = stripStalePresetUserInputTags(raw);
            return cleaned === raw ? item : { ...item, content: cleaned };
          })()
        : item;

    if (slotReached) afterSlot.push(processed);
    else beforeSlot.push(processed);
  }

  const slotMessages: Array<Record<string, unknown>> = tailMessages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  // 通用收口:当预设在 chatHistory 之后还附带了后置段落(如文风/栏位/破限/卡CoT)时,
  // 附一句极简格式提醒,防止长后置文风条目把模型拉回写小说。
  // 为不破坏预设自带的收尾非 system 角色锁(例如末尾短小的 user/assistant 卡 CoT 锁或角色确认),
  // 连续的末尾短非 system 条目(<= 600 字)保持原封不动留在最末尾,提醒贴在它们紧前面。
  let finalAfterSlot = afterSlot;
  if (afterSlot.length > 0) {
    let lockStart = afterSlot.length;
    while (lockStart > 0) {
      const candidate = afterSlot[lockStart - 1];
      const role = candidate.role;
      const len = textOf(candidate.content).trim().length;
      if ((role === 'user' || role === 'assistant') && len > 0 && len <= 600) {
        lockStart -= 1;
      } else {
        break;
      }
    }
    const reminderRole = lockStart < afterSlot.length ? 'system' : 'user';
    finalAfterSlot = [
      ...afterSlot.slice(0, lockStart),
      { role: reminderRole, content: PRESET_FORMAT_REMINDER },
      ...afterSlot.slice(lockStart),
    ];
  }

  const nextChat = [...beforeSlot, ...slotMessages, ...finalAfterSlot];
  // 将 requestMarker 附在整段消息数组最后一条上,供后续 generate_after_data / settings_ready / fetch 精确认领与剥离。
  if (nextChat.length > 0) {
    const last = nextChat[nextChat.length - 1];
    nextChat[nextChat.length - 1] = {
      ...last,
      content: `${requestMarker}\n${textOf(last.content)}`,
    };
  }
  chat.splice(0, chat.length, ...nextChat);
  return true;
}

/** 原始返回用于失败历史:字符串原样保留,详情对象格式化成可读 JSON。 */
function formatRawPresetResult(result: unknown): string {
  if (result === undefined) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

/** TH 在 should_return_reasoning=true 时返回 {content, reasoning?};独立字符串结果继续兼容。 */
function extractPresetResultContent(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (!result || typeof result !== 'object') return '';
  const data = result as { content?: unknown; reasoning?: unknown };
  return textOf(data.content).trim() || textOf(data.reasoning).trim();
}

/** 从消息数组提取带任意关联标记的真实提示词,并剥除内部标记。 */
function extractPresetMessagesFromList(list: unknown, markers: string[]): ChatMsg[] | null {
  if (!Array.isArray(list)) return null;
  const messages: ChatMsg[] = [];
  let matched = false;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    let content = textOf((item as { content?: unknown }).content);
    for (const marker of markers) {
      if (content.includes(marker)) {
        matched = true;
        content = stripPresetMarkerText(content, marker);
      }
    }
    messages.push({ role, content });
  }
  return matched ? messages : null;
}

/** 从 TH generate_after_data 中提取本次请求的真实提示词,并移除仅用于并发关联的标记。 */
function extractActualPresetMessages(data: unknown, markers: string[]): ChatMsg[] | null {
  const prompt = (data as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt === 'string') {
    if (!markers.some(marker => prompt.includes(marker))) return null;
    let content = prompt;
    for (const marker of markers) content = stripPresetMarkerText(content, marker);
    return [{ role: 'user', content }];
  }
  return extractPresetMessagesFromList(prompt, markers);
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(
      channel,
      [{ role: 'user', content: '回复"ok"两个字符即可。' }],
      primaryUrl,
      { source: '连通性测试' },
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `连通正常${changed ? `,已采用:${primaryUrl}` : ''},返回:${reply.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const reply = await requestCompletionAtUrl(
        channel,
        [{ role: 'user', content: '回复"ok"两个字符即可。' }],
        fallbackUrl,
        { source: '连通性测试(备用地址)' },
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `连通正常,已自动改用:${fallbackUrl},返回:${reply.slice(0, 40)}`,
      };
    } catch {
      // 备用地址也失败时保留首个错误,避免把模型名等真实问题掩盖成路径错误。
      return { ok: false, message: e.message };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url) throw new ApiError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, undefined, '拉取模型', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || '拉取模型失败');
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
