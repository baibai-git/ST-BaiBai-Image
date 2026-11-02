import type { ChatMsg } from '@/api/client';
import type { ImagePlan } from '@/autoTag/protocol';
import { normalizeCooldownRounds, orientationOf, resolveLayouts, type MangaSettings, type ResolvedLayout } from '@/manga/layouts';
import type { ImageSize, Orientation } from '@/backends/size';
import type { STContext } from '@/st/context';

export const LAYOUT_HISTORY_KEY = 'baibai_layout_rounds';
const HEADER = '【本轮版式冷却白名单】';
const HISTORY_LIMIT = 30;

function recentRounds(context: Pick<STContext, 'chatMetadata'>): string[][] {
  const value = context.chatMetadata[LAYOUT_HISTORY_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(Array.isArray).slice(-HISTORY_LIMIT).map(round =>
    [...new Set(round.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim()))]);
}

export interface LayoutSelection {
  layouts: Record<Orientation, ResolvedLayout[]>;
  recent: string[][];
  released: number;
  lockedSize: Orientation | null;
  rounds: number;
}

export function layoutCandidates(selection: LayoutSelection): Record<Orientation, ResolvedLayout[]> {
  const blocked = new Set(selection.recent.slice(selection.released).flat());
  const keep = (layout: ResolvedLayout) => !blocked.has(layout.id);
  return { portrait: selection.layouts.portrait.filter(keep), landscape: selection.layouts.landscape.filter(keep) };
}

/** Release oldest rounds first; skip rounds whose IDs are still blocked by newer use. */
export function relaxLayoutSelection(selection: LayoutSelection): boolean {
  const count = new Set(Object.values(layoutCandidates(selection)).flat().map(layout => layout.id)).size;
  while (selection.released < selection.recent.length) {
    selection.released++;
    if (new Set(Object.values(layoutCandidates(selection)).flat().map(layout => layout.id)).size > count) return true;
  }
  return false;
}

export function createLayoutSelection(
  context: Pick<STContext, 'chatMetadata'>, manga: MangaSettings,
  sizes: Record<Orientation, ImageSize | null>, lockedSize: Orientation | null,
): LayoutSelection {
  const compatible = (orientation: Orientation) => {
    const size = sizes[orientation];
    if (!size || lockedSize && lockedSize !== orientation) return [];
    return resolveLayouts(manga, orientationOf(size.width, size.height))
      .filter(layout => layout.canvas.width === size.width && layout.canvas.height === size.height);
  };
  const rounds = normalizeCooldownRounds(manga.cooldownRounds);
  const selection: LayoutSelection = {
    layouts: { portrait: compatible('portrait'), landscape: compatible('landscape') },
    recent: rounds ? recentRounds(context).slice(-rounds) : [], released: 0, lockedSize, rounds,
  };
  // No compatible uncooled layout: release only as much history as necessary to make a choice.
  if (!Object.values(layoutCandidates(selection)).some(layouts => layouts.length)) relaxLayoutSelection(selection);
  return selection;
}

export function setLayoutSelectionMessage(messages: ChatMsg[], selection: LayoutSelection): void {
  const candidates = layoutCandidates(selection);
  const canRelax = selection.released < selection.recent.length;
  const content = [HEADER,
    '固定版式清单仅提供几何与槽位定义；本轮可选范围以此动态白名单为准，协议示例不授予选择权限。',
    selection.rounds
      ? `同一酒馆聊天最近 ${selection.rounds} 次成功采纳的自动 tag 请求使用过的 layout ID 暂停选择；同轮多页也必须使用不同 ID。失败、重试、放宽请求与固定规范同步不计次。`
      : '跨轮版式冷却已关闭，历史使用过的 ID 可选；同轮多页仍必须使用不同 ID。',
    `当前已从最早记录起解除 ${selection.released} 轮冷却；仍禁用的 ID：${[...new Set(selection.recent.slice(selection.released).flat())].join('、') || '无'}。`,
    ...(['portrait', 'landscape'] as const).map(orientation => `${orientation}: ${candidates[orientation].map(layout => layout.id).join('、') || '无可选版式'}`),
    canRelax
      ? '若有应绘制的事件，但本轮候选均无法满足原文时序、画布、槽位、文字容量或同轮去重，不删改剧情、不强塞内容，也不自行选禁用 ID。返回控制结果 {"images":[],"changes":[],"layout_fallback":"候选不适用的具体原因"}；宿主会从最早记录起逐步解除并重新请求。此结果不受最少图片数限制，不代表本轮最终结果。'
      : '本轮已无更多冷却记录可解除；不要输出 layout_fallback，按宿主图片数量与事实要求输出最终结果。',
  ].join('\n');
  const index = messages.findIndex(message => message.content.startsWith(HEADER));
  const message: ChatMsg = { role: 'system', content }; // Dynamic: must reach DSH on every generate request.
  if (index < 0) messages.push(message); else messages[index] = message;
}

export function validateLayoutSelection(plan: ImagePlan, selection: LayoutSelection): string[] {
  const candidates = layoutCandidates(selection);
  const used = new Set<string>();
  for (const image of plan.images) {
    const inner: unknown = JSON.parse(image.tag);
    const rawId = inner && typeof inner === 'object' && !Array.isArray(inner)
      ? (inner as { layout?: unknown }).layout : undefined;
    const id = typeof rawId === 'string' ? rawId.trim() : rawId;
    if (typeof id !== 'string' || !candidates[selection.lockedSize ?? image.size].some(layout => layout.id === id)) {
      throw new Error(`版式 ${String(id)} 不在本轮冷却白名单中，请按动态白名单重新选版`);
    }
    if (used.has(id)) throw new Error(`同轮多页不能重复使用版式 ${id}`);
    used.add(id);
  }
  return [...used];
}

/** Call only after the result was adopted, including a valid decision to draw no pages. */
export function recordLayoutRound(context: Pick<STContext, 'chatMetadata' | 'saveMetadataDebounced'>, ids: string[]): void {
  context.chatMetadata[LAYOUT_HISTORY_KEY] = [...recentRounds(context), [...new Set(ids)]].slice(-HISTORY_LIMIT);
  context.saveMetadataDebounced();
}

const turns = new Map<string, Promise<void>>();
/** Selection and adoption share a chat queue so concurrent floors cannot reuse stale history. */
export async function withLayoutTurn(chatId: string, task: () => Promise<void>): Promise<void> {
  const previous = turns.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  turns.set(chatId, current);
  await previous;
  try { await task(); }
  finally { release(); if (turns.get(chatId) === current) turns.delete(chatId); }
}
