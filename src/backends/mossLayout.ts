/**
 * MOSS-Image 漫画页的 layout:AI 写的结构化分镜 → MOSS 文本编码器直接吃的 prompt 字符串。
 *
 * 存与发分两种形态:
 * - 存(正文 <layout> 子标签):bbox 是 0–1000 归一化的 [y0, x0, y1, x1],与画布尺寸无关——
 *   改尺寸、锁横竖都不用改写正文(promptHash 吃 tag 原文,改写会让老图无辜变 stale)。
 * - 发(buildMossPrompt):按实际宽高换算成「画布中心为原点」的像素坐标,输出与 ComfyUI
 *   原生节点 MOSSImageLayoutPrompt(comfy_extras/nodes_moss_image.py)逐字节一致的紧凑 JSON。
 *   插件自己做这一步,工作流里就不需要那个节点——它的元素输入来自 GUI 画框,API 调用接不上。
 *
 * 本模块是纯函数,刻意不 import settings / comfyui / charTags 的运行时(同 comfyTemplates.ts)。
 */

import { FORBIDDEN_SUBTAG } from '@/st/imageTagRegex';
import type { CharTagEntry } from '@/state/charTags';

export type ComicItemLabel = 'character' | 'object' | 'text';

export const COMIC_ITEM_LABELS: readonly ComicItemLabel[] = ['character', 'object', 'text'];

/** [y0, x0, y1, x1],0–1000 整数,y0<y1、x0<x1。 */
export type ComicBBox = [number, number, number, number];

export interface ComicItem {
  label: ComicItemLabel;
  /**
   * 角色库里的名字(仅 character,可空)。只给插件用:写入时据此把库中固定外貌拼进 caption、
   * 卡片上据此显示是谁;发给 MOSS 时丢掉——名字进了 prompt,模型会把它画成手写名牌。
   */
  name?: string;
  caption: string;
  /** 画面里要渲染出来的文字(仅 text:对白、拟声词、招牌)。 */
  text?: string;
  bbox: ComicBBox;
}

export interface ComicLayout {
  /** 整页描述:画风、光线、时间、同一角色声明。items 为空时它就是纯文本 prompt。 */
  summary: string;
  items: ComicItem[];
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
}

function clean(value: unknown, where: string): string {
  const text = oneLine(value);
  if (text && FORBIDDEN_SUBTAG.test(text)) throw new Error(`${where} 不得包含 bbi_image 系标签`);
  return text;
}

function parseBBox(value: unknown, where: string): ComicBBox {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`${where}.bbox 必须是 4 个数 [y0, x0, y1, x1]`);
  const nums = value.map(v => (typeof v === 'number' ? v : Number(v)));
  if (nums.some(n => !Number.isFinite(n))) throw new Error(`${where}.bbox 含非数字`);
  const [a, b, c, d] = nums.map(n => Math.min(1000, Math.max(0, Math.round(n))));
  // 起止写反不算错(模型偶尔按 x 在前或倒序写),排好序;塌成一条线才是真坏
  const y0 = Math.min(a, c);
  const y1 = Math.max(a, c);
  const x0 = Math.min(b, d);
  const x1 = Math.max(b, d);
  if (y0 === y1 || x0 === x1) throw new Error(`${where}.bbox 面积为 0`);
  return [y0, x0, y1, x1];
}

/**
 * 校验并规整一页 layout;不合法抛带中文原因的 Error。
 *
 * AI 输出(protocol.parseComicPlan)与正文回读(imageTagRegex.parseImageTagContent)共用这一份:
 * 读写两侧口径一致,写进正文的东西一定读得回来。**不设格数上限**——一页画几格由 AI 按内容定。
 */
export function validateComicLayout(raw: unknown, where = 'layout'): ComicLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} 必须是对象`);
  const source = raw as Record<string, unknown>;
  // 容忍 MOSS 原生形态 {"summary":{"caption":…}}:模型照着笔记写的也认
  const summaryRaw =
    source.summary && typeof source.summary === 'object' && !Array.isArray(source.summary)
      ? (source.summary as Record<string, unknown>).caption
      : source.summary;
  const summary = clean(summaryRaw, `${where}.summary`);
  if (!summary) throw new Error(`${where}.summary 不能为空`);
  const itemsRaw = source.items ?? [];
  if (!Array.isArray(itemsRaw)) throw new Error(`${where}.items 必须是数组`);
  const items: ComicItem[] = itemsRaw.map((value, index) => {
    const at = `${where}.items[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} 必须是对象`);
    const o = value as Record<string, unknown>;
    const label = oneLine(o.label).toLowerCase();
    if (!(COMIC_ITEM_LABELS as readonly string[]).includes(label)) {
      throw new Error(`${at}.label 只能是 character / object / text`);
    }
    const bbox = parseBBox(o.bbox, at);
    if (label === 'text') {
      const text = clean(o.text, `${at}.text`);
      if (!text) throw new Error(`${at}.text 不能为空`);
      return { label, caption: clean(o.caption, `${at}.caption`) || 'speech bubble', text, bbox };
    }
    const caption = clean(o.caption, `${at}.caption`);
    if (!caption) throw new Error(`${at}.caption 不能为空`);
    const name = label === 'character' ? clean(o.name, `${at}.name`) : '';
    return name
      ? { label: label as ComicItemLabel, name, caption, bbox }
      : { label: label as ComicItemLabel, caption, bbox };
  });
  return { summary, items };
}

/** 存进正文的紧凑 JSON(键序固定,读回再写出字节不变)。 */
export function serializeComicLayout(layout: ComicLayout): string {
  return JSON.stringify({
    summary: layout.summary,
    items: layout.items.map(item => ({
      label: item.label,
      ...(item.name ? { name: item.name } : {}),
      caption: item.caption,
      ...(item.label === 'text' ? { text: item.text ?? '' } : {}),
      bbox: item.bbox,
    })),
  });
}

/** Python round(x, 9):消掉 y*h/1000 的浮点尾差,免得 floor/ceil 在整数边界上差一格。 */
function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** 0–1000 归一化 → 画布中心为原点的像素边界(公式照搬 nodes_moss_image.py)。 */
export function toAbsCentralized(bbox: ComicBBox, width: number, height: number): ComicBBox {
  const [y0, x0, y1, x1] = bbox;
  const halfH = Math.floor(height / 2);
  const halfW = Math.floor(width / 2);
  return [
    Math.floor(round9((y0 * height) / 1000)) - halfH,
    Math.floor(round9((x0 * width) / 1000)) - halfW,
    Math.ceil(round9((y1 * height) / 1000)) - halfH,
    Math.ceil(round9((x1 * width) / 1000)) - halfW,
  ];
}

/**
 * 拼出发给 MOSS 的 prompt。prefix 是方案的固定正面(画风/质量),拼在 summary 前面。
 * 没有 items = 纯文本模式,直接返回整页描述(与原生节点「不给元素就原样返回」一致)。
 */
export function buildMossPrompt(layout: ComicLayout, width: number, height: number, prefix = ''): string {
  const caption = [prefix, layout.summary].map(part => part.trim()).filter(Boolean).join(', ');
  if (!layout.items.length) return caption;
  return JSON.stringify({
    summary: { caption },
    items: layout.items.map(item => ({
      label: item.label,
      caption: item.caption,
      ...(item.label === 'text' ? { text: item.text ?? '' } : {}),
      bbox: toAbsCentralized(item.bbox, width, height),
    })),
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  });
}

/**
 * 角色库条目 → 写进 caption 的固定外貌。字段拼成带主语的名词短语(`a girl with …, wearing …`),
 * 再由 bakeAppearance 接上 AI 写的动作,整条读成一句话。
 * 字段优先、nl 只兜底:插画时期建的档 nl 常是中文概述(「眼眸明亮」,没有瞳色),比字段含糊;
 * 而且永久变化(染发、换装)只改对应字段,nl 不跟着改——优先 nl 会把旧外貌烤进新漫画。
 * 不用逗号 tag 流:MOSS 的编码器是语言模型,读的是句子。实测 `1girl, 黑发…, leans over…`
 * 这种写法一页四个框就开始串人——两人都以 1girl 开头,动作找不到主语,黑发角色的台词格
 * 被画成了另一个人(MOSS 笔记 §12.3 的句子写法正是为此)。
 * fandom 不要:同人身份 tag 是给 danbooru 系模型认人的,MOSS 不认,只会多一段噪音;
 * 括号转义的反斜杠也去掉——MOSS 没有权重语法,反斜杠会原样当字符喂进去。
 */
export function comicAppearance(
  entry: Pick<CharTagEntry, 'raw' | 'nl'> & { fields: Partial<CharTagEntry['fields']> },
): string {
  const fields = entry.fields;
  const pick = (field: keyof CharTagEntry['fields']) => (fields[field] ?? '').trim();
  const sexParts = pick('sex').split(',').map(part => part.trim()).filter(Boolean);
  const subject = subjectNoun(sexParts[0] ?? '');
  const traits = [
    ...(subject ? sexParts.slice(1) : sexParts),
    ...(['hair', 'eyes', 'skin', 'body', 'extra'] as const).map(pick),
  ].filter(Boolean);
  const outfit = pick('outfit');
  if (!traits.length && !outfit) {
    // 句末标点去掉:后面还要接「, 动作」,留着就成了 `…。, leans` / `…eyes., leans`
    const nl = entry.nl.trim().replace(/[。.!！]+$/, '');
    if (nl) return nl;
    // 字段、nl 都空 = 只有整串 raw 的老条目,原样用(拆不出字段)
    return (entry.raw.trim() || subject || '').replace(/\\([()])/g, '$1');
  }
  const look = `${subject ?? 'a person'}${traits.length ? ` with ${traits.join(', ')}` : ''}${outfit ? `, wearing ${outfit}` : ''}`;
  return look.replace(/\\([()])/g, '$1');
}

/** sex 字段的首个 tag → 句子主语;认不出返回 null(原词留作特征,主语用 a person)。 */
function subjectNoun(sex: string): string | null {
  const word = sex.toLowerCase().replace(/^1/, '');
  if (word === 'girl') return 'a girl';
  if (word === 'boy') return 'a boy';
  if (word === 'female' || word === 'woman') return 'a woman';
  if (word === 'male' || word === 'man') return 'a man';
  return null;
}

/** 把固定外貌拼到 character caption 前面;caption 里已经原样带着这段就不重复。 */
export function bakeAppearance(caption: string, appearance: string): string {
  const look = appearance.trim();
  if (!look || caption.includes(look)) return caption;
  return `${look}, ${caption}`;
}
