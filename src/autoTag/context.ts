import type { STContext, STMessage, WorldInfoEntry } from '@/st/context';
import { getCheckWorldInfo, getCheckWorldInfoForBooks, getContext, getEjsTemplate } from '@/st/context';
import { isWorldInfoEntryExcluded, sortWorldInfoEntriesLikeST } from '@/autoTag/excludes';
import { stripCustomTags } from '@/autoTag/clean';
import { settings } from '@/state/settings';

/**
 * 独立请求的上下文装配:世界书 / 角色卡描述 / user 人设。
 * 逻辑与柏宝书(src/memory/engine.ts 的 fetchWorldInfo / fetchCharCard / fetchUserPersona)
 * 保持一致——柏宝书已在生产环境踩过坑,副 API 侧直接复用同款口径:
 *   - 世界书:checkWorldInfo 拿条目对象 → 逐条展宏(+ST-Prompt-Template 执行 EJS) → 独立 system 消息;
 *   - 角色卡:characters[characterId] 的 description/personality/scenario;
 *   - 人设:{{persona}} 宏。
 * 任一块取不到 → 返回空串,不影响主流程。
 */

/* ============ 扫描文本清洗(对齐柏宝书 clampToTimeTags 的核心行为) ============ */

const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;

/** 删柏宝书托管的尾部旁注块(bbs_items/bbs_vars,开/闭标签独占行配对)。 */
function stripManagedBlock(s: string, tag: string): string {
  const openRe = new RegExp(`^[ \\t]*<${tag}\\b[^>]*>[ \\t]*$`, 'm');
  const closeRe = new RegExp(`^[ \\t]*</${tag}>[ \\t]*$`, 'm');
  let out = s;
  let open: RegExpMatchArray | null;
  while ((open = out.match(openRe))) {
    const start = open.index ?? 0;
    const rest = out.slice(start + open[0].length);
    const close = rest.match(closeRe);
    if (!close) {
      // 落单开标签:只删标签本身,内容保留
      out = out.slice(0, start) + out.slice(start + open[0].length);
      continue;
    }
    const end = start + open[0].length + (close.index ?? 0) + close[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

function stripManagedTags(s: string): string {
  return stripManagedBlock(stripManagedBlock(s, 'bbs_items'), 'bbs_vars');
}

/**
 * 世界书扫描文本清洗:整块删噪声标签,再裁剪到 <bbs_start>…</bbs_end> 正文段。
 * 与柏宝书 clampToTimeTags 同口径(含其用户自定义标签配置,名单走共享存储)。
 */
function cleanScanText(mes: string): string {
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, '') // 思维链
    .replace(/<!--[\s\S]+?-->/g, '') // HTML 注释
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, ''); // 旧 horae 格式
  s = stripCustomTags(s, settings.excludes.customStripTags); // 用户自定义标签(与柏宝书同名单)
  s = stripManagedTags(s);

  // 最后一个 <bbs_start> 的位置:全局扫一遍取末次
  const startRe = /<bbs_start\b/gi;
  let lastStart = -1;
  for (let m = startRe.exec(s); m; m = startRe.exec(s)) lastStart = m.index;
  if (lastStart >= 0) s = s.slice(lastStart);
  // 第一个 </bbs_end>(在已裁过前缀的串里找)
  const endMatch = s.match(/<\/bbs_end>/i);
  if (endMatch && endMatch.index !== undefined) {
    s = s.slice(0, endMatch.index + endMatch[0].length);
  }
  // 规范空白
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============ 世界书 ============ */

class WorldInfoStyleConflictError extends Error {}

/** Only explicitly named style switches are promoted; ordinary lore remains reference material. */
function isStyleSwitch(entry: WorldInfoEntry): boolean {
  return /画风\s*[-－—].*[(（]开关[)）]/u.test(entry.comment ?? '');
}

/** 把去空后的分段去重、join。世界书激活各来源统一收口于此(与柏宝书一致)。 */
function joinWorldInfoChunks(chunks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const t = c?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join('\n\n').trim();
}

/**
 * 本轮待扫描文本:各楼正文清洗后,带人名前缀帮助关键词命中角色名。
 * 与柏宝书 buildScanText 同构。
 */
function buildScanText(chat: STMessage[], targets: number[], name1: string, name2: string): string[] {
  return targets
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      return `${who}: ${cleanScanText(m.mes)}`;
    })
    .filter(Boolean);
}

// ST 内部:WI 实际预算 = world_info_budget(默认25%) × maxContext,超出即截断条目(蓝灯也不例外)。
// 摘要场景要「激活的一条都不漏」,故传一个极大的 maxContext,让预算大到不可能溢出。
const HUGE_WI_CONTEXT = 1_000_000_000;

/**
 * 渲染世界书条目内容,让副 API 拿到「执行后」的成品而非原文:
 *   ① substituteParams 展开 {{宏}};
 *   ② 若装了 ST-Prompt-Template(提示词模板)且文本含 <% %>,调其执行器跑 EJS。
 * 复刻柏宝书 renderWorldInfoContent 的顺序(先宏后 EJS)。
 */
async function renderWorldInfoContent(
  content: string,
  entry: WorldInfoEntry | undefined,
  floor: number | undefined,
): Promise<string> {
  const ctx = getContext();
  // ① 展宏(substituteParams 不存在时保持原文)
  let text = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(content) : content;
  // ② 无 EJS 标签则无需调模板插件(省去 prepareContext/sandbox 开销)
  if (!text.includes('<%')) return text;
  const ejs = getEjsTemplate();
  if (!ejs) return text; // 未装 ST-Prompt-Template:只做了展宏
  try {
    // 第二参 end=floor:让 getvar 以「截止该楼」的变量快照求值;undefined 时接口默认取最新楼
    const env = await ejs.prepareContext({ world_info: entry }, floor);
    const out = await ejs.evalTemplate(text, env);
    if (typeof out === 'string') text = out;
  } catch (e) {
    console.log('[柏宝绘] 世界书 EJS 渲染失败(退回未执行文本):', e);
  }
  return text;
}

/**
 * 降级路径:走 ST 暴露的 getWorldInfoPrompt(只拿拼好的字符串)。
 * 仅当 checkWorldInfo 取不到时使用——拿不到条目对象,无法逐条渲染,但至少请求照常带世界书,不崩。
 * 蓝灯/相关条目可能落在 before、after、depth(@深度)、作者注 任一位置,全部提取。
 */
async function fetchWorldInfoViaPrompt(
  scanText: string[],
  refFloor: number | undefined,
): Promise<string> {
  const fn = getContext()?.getWorldInfoPrompt;
  if (typeof fn !== 'function') return '';
  const res = await fn(scanText, HUGE_WI_CONTEXT, true);
  if (!res) return '';
  const chunks: string[] = [];
  if (typeof res.worldInfoBefore === 'string') chunks.push(res.worldInfoBefore);
  if (typeof res.worldInfoAfter === 'string') chunks.push(res.worldInfoAfter);
  for (const d of res.worldInfoDepth ?? []) {
    for (const e of d?.entries ?? []) if (typeof e === 'string') chunks.push(e);
  }
  for (const e of res.anBefore ?? []) if (typeof e === 'string') chunks.push(e);
  for (const e of res.anAfter ?? []) if (typeof e === 'string') chunks.push(e);
  // 逐块渲染(展宏 + EJS);此路径拿不到条目对象,EJS 仅带当前状态上下文(无 world_info),但仍按 refFloor 取变量
  const rendered = await Promise.all(chunks.map(c => renderWorldInfoContent(c, undefined, refFloor)));
  return joinWorldInfoChunks(rendered);
}

/**
 * 按本轮待扫描文本激活世界书条目(关键词触发 + constant 蓝灯),返回设定文本。
 * 优先走 checkWorldInfo:返回**条目对象**,可逐条渲染成品(展宏 + EJS),
 * 并据此按「整本排除」+「条目名规则」(共享存储名单,与柏宝书同口径)过滤掉不需要的条目。
 * checkWorldInfo 取不到(旧版/路径变动)→ 降级到 getWorldInfoPrompt(不过滤,但至少带书,不崩)。
 * 无激活条目 / 角色卡无世界书 / 出错 → 返回空串(不影响主流程)。
 */
export async function fetchWorldInfo(
  chat: STMessage[],
  targets: number[],
  name1: string,
  name2: string,
): Promise<string> {
  const scanText = buildScanText(chat, targets, name1, name2);
  if (!scanText.length) return '';
  // 变量时点代表楼:取本批**最后一个 target 楼**。EJS 里 getvar 据此读该楼的历史变量快照。
  const refFloor = targets.length ? targets[targets.length - 1] : undefined;
  try {
    const dedicated = settings.worldBooks;
    let res;
    if (dedicated.enabled) {
      if (!dedicated.names.length) return '';
      const check = await getCheckWorldInfoForBooks();
      if (!check) throw new Error('专用世界书扫描接口不可用，请安装配套兼容补丁并刷新酒馆。');
      res = await check(scanText, HUGE_WI_CONTEXT, true, [...dedicated.names]);
    } else {
      const check = await getCheckWorldInfo();
      if (!check) return fetchWorldInfoViaPrompt(scanText, refFloor);
      res = await check(scanText, HUGE_WI_CONTEXT, true);
    }
    const activated = res?.allActivatedEntries;
    if (!activated) return '';
    // allActivatedEntries 可能是 Set<entry> 或 Map<key,entry>,统一取 values;
    // 再排成 ST 主提示词同款顺序(扫描命中序不含排序,与柏宝书同口径),
    // 然后按共享排除名单过滤(整本/条目名),最后逐条渲染(展宏 + 执行 EJS)。
    const entries = sortWorldInfoEntriesLikeST(
      activated instanceof Map ? [...activated.values()] : [...activated],
    );
    const rendered = await Promise.all(
      entries
        .filter(e => e && !isWorldInfoEntryExcluded(e, settings.excludes))
        .map(async entry => ({
          entry,
          text: (await renderWorldInfoContent(typeof entry.content === 'string' ? entry.content : '', entry, refFloor)).trim(),
        })),
    );
    const styles = rendered.filter(({ entry, text }) => text && isStyleSwitch(entry));
    if (styles.length > 1) {
      throw new WorldInfoStyleConflictError(`多个画风开关同时激活：${styles.map(({ entry }) => entry.comment).join('、')}。请只启用一个；混合画风请使用单个混合画风条目。`);
    }
    const chunks = rendered.map(({ entry, text }) =>
      text && isStyleSwitch(entry) ? `【本轮已激活画风开关：${entry.comment}】\n${text}` : text,
    );
    return joinWorldInfoChunks(chunks);
  } catch (e) {
    // 独立模式不能偷偷回落到酒馆书单或无书生成，让调用方报告失败。
    if (e instanceof WorldInfoStyleConflictError || settings.worldBooks.enabled) throw e;
    console.log('[柏宝绘] 世界书激活失败(降级为不带设定):', e);
    return '';
  }
}

/* ============ 角色卡描述 + user 人设(与柏宝书 fetchCharCard / fetchUserPersona 一致) ============ */

/**
 * 取当前角色卡的人设字段(description / personality / scenario)。
 * 有些卡把人设写在角色描述而非世界书里,tag 生成也需据此理解角色长相与言行。
 *   - 三个字段都尝试,空的自动跳过;
 *   - 字段里可能含 {{char}}/{{user}} 宏,用 substituteParams 展开;
 *   - 群聊(characterId 为空)暂不带——多成员合并逻辑复杂,与柏宝书一致。
 * 取不到角色 / 全空 → 返回空串(降级,不影响主流程)。
 */
export function fetchCharCard(context: STContext): string {
  if (!context || context.groupId) return ''; // 群聊暂不带
  const idx = context.characterId;
  if (idx === undefined || idx === null || idx === '') return '';
  const ch = context.characters?.[Number(idx)] as Record<string, unknown> | undefined;
  if (!ch) return '';
  const sub = typeof context.substituteParams === 'function' ? context.substituteParams : (s: string) => s;
  const fields: Array<[string, string]> = [
    ['描述', String(ch.description ?? '')],
    ['性格', String(ch.personality ?? '')],
    ['情景', String(ch.scenario ?? '')],
  ];
  const parts: string[] = [];
  for (const [label, raw] of fields) {
    const t = sub(raw).trim();
    if (t) parts.push(`【${label}】\n${t}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * 取当前用户人设(persona / 用户设定)。
 * 走 ST 稳定宏 {{persona}}(= power_user.persona_description),substituteParams 展开即得;
 * 不去翻 power_user 全局,保持「只通过 context 接触宿主」。
 * tag 生成需要知道主角是谁(外貌/身份),否则画面里的主角只能靠猜。
 * 未设置 persona / 取不到 → 空串(降级,不影响主流程)。
 */
export function fetchUserPersona(context: STContext): string {
  if (!context || typeof context.substituteParams !== 'function') return '';
  return context.substituteParams('{{persona}}').trim();
}

/* ============ 系统消息包装(与柏宝书 prompts.ts 的 build*System 文案一致) ============ */

/** 世界设定与场景描写参考；按正文选用，不把条目示例当成已发生剧情。 */
export function buildWorldInfoSystem(worldInfo: string): string {
  return `【世界设定与场景描写参考(世界书激活条目)】
以下条目可用于理解世界与角色，并按适用条件补充当前场景的材质、光影、环境和描写方式；只采用与目标正文及人物连续性相符的内容。
条目中的示例、假设与写法说明不代表本轮已经发生的事件，不据此新增人物、动作或对白，也不把说明当成画面文字。
原文明确事实、宿主输出协议、当前版式清单及规范中的格式、连续性与物理约束优先；将适用参考落实为对应画面描述，不整段复述世界书。
画风来源单独核对：本轮明确指定的画风优先，其次是下方标记的「本轮已激活画风开关」，没有时使用规范的默认画风。已激活画风开关替换默认媒介；漫画 Layout 只约束分格、排版与字段，不强制二维。只有画风条目负责媒介、线条、上色和材质表现，普通世界书仍按参考资料处理。
Layout 模式把选定画风落实到 summary.caption，并使人物、背景与材质描述相容；常规模式放在对应的画风描述位置。条目要求英文句子开头时，指画风描述的位置，不在宿主 JSON 外追加文本，也不覆盖事实、格式、槽位与物理约束。

${worldInfo.trim()}`;
}

/** 把角色卡描述包成独立 system 消息(有些卡人设写在角色描述而非世界书里,tag 生成也需据此理解角色)。 */
export function buildCharCardSystem(charCard: string): string {
  return `【角色设定(角色卡设定,只读参考)】
以下是当前角色的人物设定,用于帮助你理解角色的外貌与言行;它不是本轮发生的事,不要写进输出。

${charCard.trim()}`;
}

/** 把用户人设(persona)包成独立 system 消息(用于理解「主角是谁」)。 */
export function buildPersonaSystem(persona: string): string {
  return `【主角设定(用户操控的主角本人设定,只读参考)】
以下是主角(即对话里的"用户/User"一方)本人的人物设定,用于帮助你理解主角的身份与外貌;它不是本轮发生的事,不要写进输出。

${persona.trim()}`;
}
