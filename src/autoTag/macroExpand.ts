import type { ChatMsg } from '@/api/client';

/**
 * Tavern-Helper 变量宏的本地展开。
 *
 * **为什么需要它**:TH 的 macro-like(见其 src/function/macro_like.ts)只在 ST 自己的
 * 生成链路里展开 —— 它监听 GENERATE_AFTER_DATA / CHAT_COMPLETION_SETTINGS_READY
 * (Tavern-Helper/src/panel/render/macro_like.ts 的 useMacroLike)。柏宝绘是**自己直连**
 * `/api/backends/chat-completions/generate`,绕过了那条链路,于是世界书里写的
 * `{{format_message_variable::stat_data}}` 会以宏原文进入提示词,模型看到的是一串花括号。
 *
 * **只在装了 Tavern-Helper 时生效**,两处依赖都取自它:
 * - 变量表走 `TavernHelper.getVariables`(与 TH 自己展开时同源,不重复实现存储位置);
 * - YAML 序列化走 TH 挂到 `globalThis.YAML` 的 `yaml` 库(与 TH 同版本、同参数)。
 * 任一不可用 → 整体不展开、宏原样保留,对未装 TH 的用户零影响。
 *
 * 与 TH 的口径差异(刻意为之):
 * - TH 的 format_* 正则不带 g、且靠递归处理同一行:一次只能展开**第一行**命中的宏。
 *   这里按全局扫描,多行多处宏都会展开;
 * - 路径解析不到时保留宏原文(TH 会输出 `null` / `undefined`),便于在请求历史里
 *   直接看出是哪个宏写错了。
 */

type VariableScope = 'message' | 'chat' | 'character' | 'preset' | 'global';

interface VariableOption {
    type: VariableScope;
    message_id?: number | 'latest';
}

/** TH 公开接口的一部分:只声明展开需要的那些。 */
interface TavernHelperApi {
    getVariables?: (option: VariableOption) => Record<string, unknown>;
}

interface YamlApi {
    stringify: (value: unknown, options?: Record<string, unknown>) => string;
}

/** {{format_<作用域>_variable[_quoted]::<路径>}} —— 非字符串值按 YAML 输出。 */
const FORMAT_MACRO = /\{\{format_(message|chat|character|preset|global)_variable(_quoted)?::(.*?)\}\}/g;
/** {{get_<作用域>_variable::<路径>}} —— 原值输出(非字符串走 JSON)。 */
const GET_MACRO = /\{\{get_(message|chat|character|preset|global)_variable::(.*?)\}\}/g;

export interface MacroExpandOptions {
    /**
     * `message` 作用域优先采用的楼层(自动 tag 的目标楼)。
     * 缺省 = TH 默认口径:最后一个带变量的楼层。
     */
    messageId?: number;
}

function getTavernHelper(): TavernHelperApi | null {
    const th = (globalThis as { TavernHelper?: Partial<TavernHelperApi> }).TavernHelper;
    return typeof th?.getVariables === 'function' ? (th as TavernHelperApi) : null;
}

function getYaml(): YamlApi | null {
    const yaml = (globalThis as { YAML?: Partial<YamlApi> }).YAML;
    return typeof yaml?.stringify === 'function' ? (yaml as YamlApi) : null;
}

function isFilled(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * 与 TH 的 getWithout$ 一致:递归剔除 `$` 开头的元数据键。
 * MVU 的 `$meta` / `$internal` 就藏在这一层,带进提示词只会干扰模型。
 */
function omitMetadataKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => omitMetadataKeys(item));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (key.startsWith('$')) continue;
            out[key] = omitMetadataKeys(item);
        }
        return out;
    }
    return value;
}

/**
 * lodash 风格的路径取值:`a.b`、`a[0].b`、`a["b.c"]`(带引号的键可以含点)。
 * 解析不到返回 undefined(调用方据此保留宏原文)。
 */
const PATH_TOKEN = /\[\s*(?:'([^']*)'|"([^"]*)"|(\d+))\s*\]|([^.[\]]+)/g;

function resolvePath(root: unknown, path: string): unknown {
    if (!path) return undefined;
    let current: unknown = root;
    let matched = false;
    PATH_TOKEN.lastIndex = 0;
    for (let token = PATH_TOKEN.exec(path); token; token = PATH_TOKEN.exec(path)) {
        matched = true;
        // token[1..3] 是括号里的引号键/下标,token[4] 是普通键
        const key = token[1] ?? token[2] ?? token[3] ?? token[4];
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return matched ? current : undefined;
}

/**
 * 读某一作用域的变量表。
 *
 * `message` 作用域优先用调用方给的楼层(目标楼);该楼还没有变量
 * (MVU 尚未写回 / 该楼不是剧情楼)时退回 TH 自己的默认口径
 * —— 最后一个带变量的楼层,与 TH 在主生成链路里展开的结果一致。
 */
function readVariables(
    th: TavernHelperApi,
    type: VariableScope,
    messageId: number | undefined,
    cache: Map<string, Record<string, unknown> | null>,
): Record<string, unknown> | null {
    const key = type === 'message' ? `message:${messageId ?? 'latest'}` : type;
    if (cache.has(key)) return cache.get(key) ?? null;

    let result: Record<string, unknown> | null = null;
    try {
        if (type === 'message') {
            result =
                messageId === undefined
                    ? th.getVariables!({ type })
                    : th.getVariables!({ type, message_id: messageId });
            if (messageId !== undefined && !isFilled(result)) result = th.getVariables!({ type });
        } else {
            result = th.getVariables!({ type });
        }
    } catch {
        // 楼层越界 / TH 尚未就绪:当作取不到,宏原样保留
        result = null;
    }

    const value = isFilled(result) ? result : null;
    cache.set(key, value);
    return value;
}

/**
 * 按 TH 的参数序列化:字符串值一律原样(`_quoted` 变体在 TH 里也只影响
 * 集合内部的字符串),其余走 YAML。
 */
function stringifyValue(value: unknown, quoted: boolean, yaml: YamlApi | null): string {
    if (typeof value === 'string') return value;
    const cleaned = omitMetadataKeys(value);
    if (!yaml) return JSON.stringify(cleaned) ?? String(cleaned);
    return yaml
        .stringify(
            cleaned,
            quoted
                ? { blockQuote: 'literal', defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' }
                : { blockQuote: 'literal' },
        )
        .trimEnd();
}

/** 展开一段文本里的 TH 变量宏;未装 TH / 取不到变量时原样返回。 */
export function expandTavernMacros(text: string, options: MacroExpandOptions = {}): string {
    // `format_*_variable_quoted::` 不含 `variable::` 子串,这里按更宽的标记预筛
    if (!text || !text.includes('_variable')) return text;
    const th = getTavernHelper();
    if (!th) return text;
    const yaml = getYaml();
    // 一次展开内复用:世界书里同一个路径常被多个条目引用
    const cache = new Map<string, Record<string, unknown> | null>();

    let out = text.replace(
        FORMAT_MACRO,
        (
            whole: string,
            type: VariableScope,
            quoted: string | undefined,
            rawPath: string,
            offset: number,
            source: string,
        ) => {
            const variables = readVariables(th, type, options.messageId, cache);
            if (!variables) return whole;
            const value = resolvePath(variables, rawPath.trim());
            if (value === undefined) return whole;
            // 多行 YAML 的续行按宏所在列对齐 —— 与 TH 的缩进口径一致,否则 YAML 层级会错位
            const column = offset - (source.lastIndexOf('\n', offset - 1) + 1);
            return stringifyValue(value, Boolean(quoted), yaml).replaceAll('\n', `\n${' '.repeat(column)}`);
        },
    );

    out = out.replace(GET_MACRO, (whole: string, type: VariableScope, rawPath: string) => {
        const variables = readVariables(th, type, options.messageId, cache);
        if (!variables) return whole;
        const value = resolvePath(variables, rawPath.trim());
        if (value === undefined) return whole;
        if (typeof value === 'string') return value;
        const cleaned = omitMetadataKeys(value);
        return JSON.stringify(cleaned) ?? String(cleaned);
    });

    return out;
}

/**
 * 对一整组消息做展开(只动 content,不动 role)。
 * 未装 TH 时返回**原数组**;有改动时返回新数组与新消息对象,入参不被修改。
 */
export function expandMacroMessages(messages: ChatMsg[], options: MacroExpandOptions = {}): ChatMsg[] {
    if (!getTavernHelper()) return messages;
    let changed = false;
    const next = messages.map((message) => {
        const content = expandTavernMacros(message.content, options);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
    });
    return changed ? next : messages;
}
