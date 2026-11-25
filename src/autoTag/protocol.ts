import { normalizeOrientation, type Orientation } from '@/backends/size';
import type { TargetSegment } from '@/autoTag/clean';
import { FORBIDDEN_SUBTAG, serializeImageTag } from '@/st/imageTagRegex';
import {
  CHAR_TAG_FIELDS,
  type CharTagField,
  type CharTagHistoryField,
} from '@/state/charTags';

export interface ImageCharacterPrompt {
  name: string;
  tag: string;
  nl: string;
}

export interface ImageInsertion {
  /** 模型选择的目标正文位置 ID。 */
  position: string;
  /** 位置 ID 对应的原始物理行(0-based，仅插件内部使用)。 */
  sourceLine: number;
  /** 正向提示词，漫画 Layout 存为 JSON 字符串。 */
  tag: string;
  /** 可选的自然语言部分。 */
  nl: string;
  /** 本画面动态负面 tag(可空;仅在 ComfyUI 工作流使用 %negative_prompt% 时要求模型输出)。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 画幅方向:模型只判横/竖,具体像素由用户在后端面板配置。漏给/乱给一律降级竖屏。 */
  size: Orientation;
  /** 漫画模式下区分显式画幅和解析器默认值。 */
  sizeProvided?: boolean;
}

export interface ImagePlan {
  images: ImageInsertion[];
  /** Internal control response: request the next oldest layout cooldown tier. Never persisted as an image. */
  layoutFallback?: string;
  /** AI 报告的角色库变更(建档/字段更新);调用方负责落库。 */
  changes: CharChange[];
}

/** AI 输出的单条角色变更(宽松形状;解析后字段全部合法才保留)。 */
export interface CharChange {
  name: string;
  /** 'new' = 建档;其余为字段名/整串/自然语言。 */
  field: CharTagHistoryField;
  value: string;
  /** 自然语言外貌句(new 建档时可附带)。 */
  nl?: string;
  reason: string;
  /**
   * 永久变化开始生效的位置。建档(new)不受此约束——角色的固定外貌是本楼全程
   * 成立的事实,不是「从某处开始」的变化,这里只作记录与排序用。
   */
  position: string;
  /** position 对应的原始物理行(0-based,仅插件内部使用)。 */
  sourceLine: number;
}

const HISTORY_FIELDS: ReadonlySet<string> = new Set([
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
  'new',
  'raw',
  'nl',
]);

interface SourceLine {
  text: string;
  eol: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

function parsePlanRoot(json: string, commas: number[]): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('AI 返回的外层 JSON 语法错误；请检查括号、逗号及字符串转义'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 返回的 JSON 最外层必须是对象');
  const root = value as Record<string, unknown>;
  if (!commas.length) return root;

  // JSON.parse 保留同名键的最后一个值。逐个读取顶层成员，保住前面的页和角色变更。
  const images: unknown[][] = [], changes: unknown[][] = [];
  let start = 1;
  for (const end of [...commas, json.length - 1]) {
    const member = JSON.parse('{' + json.slice(start, end) + '}');
    start = end + 1;
    if ('images' in member) {
      if (!Array.isArray(member.images)) throw new Error('AI 返回的 JSON 缺少有效的 images 数组');
      images.push(member.images);
    }
    if (Array.isArray(member.changes)) changes.push(member.changes);
  }
  if (images.length > 1) root.images = images.flat();
  if (changes.length) root.changes = changes.flat();
  return root;
}

function parsePlanObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  // Scan only outer objects: a broken response must never fall back to a valid child page.
  const roots: Record<string, unknown>[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  let commas: number[] = [];
  for (let index = 0; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (start < 0) {
      if (char === '{' || char === '[') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === ',' && depth === 1 && cleaned[start] === '{') commas.push(index - start);
    else if ((char === '}' || char === ']') && --depth === 0) {
      roots.push(parsePlanRoot(cleaned.slice(start, index + 1), commas));
      start = -1;
      commas = [];
    }
  }
  if (start >= 0) throw new Error('AI 返回的外层 JSON 未闭合或不完整；所有页须放在同一个顶层 images 数组中');
  if (!roots.length) throw new Error('AI 没有返回可解析的 JSON 对象');
  if (roots.length === 1) return roots[0];
  if (roots.some(root => !Array.isArray(root.images))) throw new Error('每个外层 JSON 对象都需要 images 数组');
  if (roots.some(root => 'layout_fallback' in root)) throw new Error('layout_fallback 必须单独返回，不能与其他外层对象合并');
  return {
    images: roots.flatMap(root => root.images as unknown[]),
    changes: roots.flatMap(root => Array.isArray(root.changes) ? root.changes : []),
  };
}

/** tag / nl / negative 内容里不允许出现的子标签字面量（口径见 st/imageTagRegex.ts）。 */

function sanitizeContent(value: unknown, field: string, index: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (text && FORBIDDEN_SUBTAG.test(text)) {
    throw new Error(`images[${index}].${field} 不得包含 bbi_image/tag/nl/negative/size 标签`);
  }
  return text;
}

function sanitizeCharacters(value: unknown, imageIndex: number): ImageCharacterPrompt[] {
  if (!Array.isArray(value)) return [];
  const characters: ImageCharacterPrompt[] = [];
  for (let index = 0; index < value.length && characters.length < 32; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    try {
      const name = sanitizeContent(item.name, `characters[${index}].name`, imageIndex);
      const tag = sanitizeContent(item.tag ?? item.prompt, `characters[${index}].tag`, imageIndex);
      const nl = sanitizeContent(item.nl, `characters[${index}].nl`, imageIndex);
      if (name && tag) characters.push({ name, tag, nl });
    } catch {
      // A malformed character prompt must not discard an otherwise valid image plan.
    }
  }
  return characters;
}

function sanitizePosition(value: unknown, index: number): string {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!position) throw new Error(`images[${index}].position 不能为空`);
  if (!/^P\d+$/.test(position)) throw new Error(`images[${index}].position 必须是目标正文中的 P编号`);
  return position;
}

/**
 * 解析模型给出的画面计划。普通 ComfyUI 允许用 nl 作为主提示词。
 * size 一律容忍:归一不出就当竖屏——为它抛错会白白吃掉 runner 的重试次数。
 * 图片超过上限时本地硬截断;少于用户明确设置的下限则抛错,交给 runner 重试。
 * changes 全程宽容:单条坏就丢弃,绝不连累 images——角色档案漏一条只是这个角色本轮
 * 没锚定,为它作废整次输出会连图一起没有,那是更坏的结果。
 */
export function parseImagePlan(
  raw: string,
  segments: TargetSegment[],
  minImages: number,
  maxImages: number,
  allowNegative = true,
  allowLayoutFallback = false,
  promptFormat: 'tag' | 'tag-or-nl' | 'manga' = 'tag',
): ImagePlan {
  const parsed = parsePlanObject(raw);
  if (!Array.isArray(parsed.images)) throw new Error('AI 返回的 JSON 缺少 images 数组');
  if (parsed.layout_fallback !== undefined) {
    if (!allowLayoutFallback || typeof parsed.layout_fallback !== 'string' || !parsed.layout_fallback.trim() || parsed.images.length) {
      throw new Error('layout_fallback 仅可在允许放宽冷却时以非空原因和空 images 请求');
    }
    return { images: [], changes: [], layoutFallback: parsed.layout_fallback.trim() };
  }
  const normalizedMax = Math.max(1, Math.floor(Number(maxImages)) || 1);
  const normalizedMin = Math.min(
    normalizedMax,
    Math.max(0, Math.floor(Number(minImages)) || 0),
  );
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = [];
  for (let index = 0; index < parsed.images.length; index += 1) {
    const item = parsed.images[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`images[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    if ('images' in entry || 'changes' in entry) {
      throw new Error(`images[${index}] 嵌套了 images 或 changes；每项只能是一页，所有页平铺在顶层 images，changes 只放最外层`);
    }
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`images[${index}].position=${position} 不在目标正文可选位置中`);
    }
    // 兼容模型按旧协议/习惯返回 prompt 键的情况
    const rawTag = entry.tag ?? entry.prompt;
    const tag = sanitizeContent(promptFormat === 'manga' && rawTag && typeof rawTag === 'object' && !Array.isArray(rawTag)
      ? JSON.stringify(rawTag) : rawTag, 'tag', index);
    const nl = sanitizeContent(entry.nl, 'nl', index);
    const allowNlOnly = promptFormat === 'tag-or-nl';
    if (!tag && !(allowNlOnly && nl)) {
      const fields = allowNlOnly ? 'tag 和 nl 至少填写一项' : 'tag 不能为空';
      throw new Error(`images[${index}].${fields}`);
    }
    const negative = allowNegative ? sanitizeContent(entry.negative ?? entry.negative_prompt, 'negative', index) : '';
    const characters = sanitizeCharacters(entry.characters, index);
    // 兼容模型按习惯返回 orientation / aspect 键
    const rawSize = entry.size ?? entry.orientation ?? entry.aspect;
    const size = normalizeOrientation(rawSize);
    // The main prompt is used for both new and saved images. Store a lone nl there once.
    images.push({ position, sourceLine, tag: tag || nl, nl: tag ? nl : '', negative, characters, size,
      ...(promptFormat === 'manga' ? { sizeProvided: typeof rawSize === 'string' && !!rawSize.trim() } : {}) });
  }

  const limitedImages = images.slice(0, normalizedMax);
  if (limitedImages.length < normalizedMin) {
    throw new Error(
      `AI 返回了 ${limitedImages.length} 张图片，少于设置的最少图片数 ${normalizedMin}`,
    );
  }

  return {
    images: limitedImages,
    changes: parseChanges(parsed.changes, positions),
  };
}

/**
 * 解析变化生效位置。建档(new)缺位置不是错——它本就全楼生效;
 * 解析不出时回落到首个位置,只用于排序。
 */
function parsePosition(
  value: unknown,
  positions: Map<string, number>,
): { position: string; sourceLine: number } | null {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^P\d+$/.test(position)) return null;
  const sourceLine = positions.get(position);
  if (sourceLine === undefined) return null;
  return { position, sourceLine };
}

function firstPosition(positions: Map<string, number>): { position: string; sourceLine: number } {
  for (const [position, sourceLine] of positions) return { position, sourceLine };
  return { position: '', sourceLine: 0 };
}

/** 建档字段:hair 与 eyes 是二次元身份锚点,缺任一条则该条建档不可用(调用方丢弃)。 */
function parseNewFields(raw: Record<string, unknown>): string | null {
  const fields: Partial<Record<CharTagField, string>> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
    if (text) fields[field] = text;
  }
  if (!fields.hair || !fields.eyes) return null;
  return JSON.stringify(fields);
}

function parseChanges(raw: unknown, positions: Map<string, number>): CharChange[] {
  if (!Array.isArray(raw)) return [];
  const out: CharChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const fieldRaw = typeof o.field === 'string' ? o.field.trim() : '';
    if (!name || !HISTORY_FIELDS.has(fieldRaw)) continue;
    const field = fieldRaw as CharTagHistoryField;
    const parsedPosition = parsePosition(o.position ?? o.at, positions);
    // 建档全楼生效,位置只作记录,缺失就回落首位;永久变化必须知道从哪生效,位置坏 = 丢弃
    if (!parsedPosition && field !== 'new') continue;
    const { position, sourceLine } = parsedPosition ?? firstPosition(positions);
    let value = typeof o.value === 'string' ? o.value.trim() : '';
    const fields =
      o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)
        ? (o.fields as Record<string, unknown>)
        : null;
    if (field === 'new') {
      const parsedFields = fields ? parseNewFields(fields) : null;
      if (!parsedFields) continue;
      value = parsedFields;
    }
    const nl = typeof o.nl === 'string' ? o.nl.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!value && !nl) continue;
    out.push({ name, field, value, nl: nl || undefined, reason, position, sourceLine });
  }
  return out;
}

/** 保持原文及原换行符不变，只在模型选择的位置 ID 对应源码行之后插入 tag。 */
export function injectImageTags(source: string, images: ImageInsertion[]): string {
  if (!images.length) return source;
  const lines = sourceLines(source);
  const byLine = new Map<number, ImageInsertion[]>();
  for (const image of images) {
    if (!Number.isInteger(image.sourceLine) || image.sourceLine < 0 || image.sourceLine >= lines.length) {
      throw new Error(`位置 ${image.position} 对应的原始物理行已失效`);
    }
    const line = image.sourceLine;
    const list = byLine.get(line) ?? [];
    list.push(image);
    byLine.set(line, list);
  }

  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output += line.text;
    const inserted = byLine.get(index) ?? [];
    const insertedEol = line.eol || fallbackEol;
    // 序列化口径见 st/imageTagRegex.ts 的 serializeImageTag（与手动编辑弹窗共用同一份，
    // 两处漂移会让「解析出的字段」与「落进正文的原文」对不上，而 promptHash 吃的是原文）。
    for (const image of inserted) {
      output += `${insertedEol}${serializeImageTag(image)}`;
    }
    output += line.eol;
  }
  return output;
}
