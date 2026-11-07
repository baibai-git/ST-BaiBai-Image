import type { ChatMsg } from '@/api/client';
import type { ImagePlan } from '@/autoTag/protocol';
import { buildMangaCatalog, normalizeCooldownRounds, orientationOf, planningLayouts, type MangaSettings, type ResolvedLayout } from '@/manga/layouts';
import type { ImageSize, Orientation } from '@/backends/size';
import type { STContext } from '@/st/context';
import { ATLAS_IMAGE_HEADER, buildLayoutAtlases, layoutAtlasMessages, rasterizeLayoutAtlas } from '@/manga/atlas';

export const LAYOUT_HISTORY_KEY = 'baibai_layout_rounds';
const HEADER = '【本轮版式选择范围】';
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
  selectionNotes?: string;
  visual?: boolean;
  singleImageMode?: boolean;
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
    return planningLayouts(manga, orientationOf(size.width, size.height))
      .filter(layout => layout.canvas.width === size.width && layout.canvas.height === size.height);
  };
  const rounds = manga.singleImageMode ? 0 : normalizeCooldownRounds(manga.cooldownRounds);
  const selection: LayoutSelection = {
    layouts: { portrait: compatible('portrait'), landscape: compatible('landscape') },
    recent: rounds ? recentRounds(context).slice(-rounds) : [], released: 0, lockedSize, rounds, selectionNotes:manga.selectionNotes, visual:manga.catalogMode==='image', singleImageMode:manga.singleImageMode===true,
  };
  if (selection.singleImageMode && !Object.values(selection.layouts).some(layouts => layouts.length)) {
    throw new Error('单图模式没有与本轮方向、尺寸相符的启用全页单格版式；请先启用或调整对应版式。');
  }
  // No compatible uncooled layout: release only as much history as necessary to make a choice.
  if (!Object.values(layoutCandidates(selection)).some(layouts => layouts.length)) relaxLayoutSelection(selection);
  return selection;
}

export function setLayoutSelectionMessage(messages: ChatMsg[], selection: LayoutSelection): void {
  for (let i=messages.length-1;i>=0;i--) if (messages[i].content.startsWith(ATLAS_IMAGE_HEADER)) messages.splice(i,1);
  const candidates = layoutCandidates(selection);
  const canRelax = selection.released < selection.recent.length;
  const content = [HEADER, '<<<STB-KEEP>>>',
    ...(selection.visual ? [] : ['只从下面的可选 ID 中选择；每个 ID 的格位、大小和槽位见后面的空间目录。历史清单和协议示例不授予选择权限。']),
    selection.singleImageMode ? '单图模式：仅全页单格；同轮允许复用同一ID，不执行跨轮布局冷却。' : selection.visual ? `冷却窗口：${selection.rounds} 次已采纳规划。` : selection.rounds
      ? `最近 ${selection.rounds} 次已采纳规划结果使用过的 ID 暂不可选；同轮多页也必须使用不同 ID。`
      : '跨轮冷却已关闭；同轮多页仍必须使用不同 ID。',
    ...(['portrait', 'landscape'] as const).map(orientation => {
      const label = orientation === 'portrait' ? '竖版（portrait）' : '横版（landscape）';
      const entries = candidates[orientation];
      return entries.length ? `${label}：可选 ${entries.length} 套；ID：${entries.map(layout => layout.id).join('、')}` : `${label}：暂无可选版式，本轮不可选此方向。`;
    }),
    ...(selection.recent.slice(selection.released).flat().length
      ? [`暂不可选 ID：${[...new Set(selection.recent.slice(selection.released).flat())].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).join('、')}（最近 ${selection.rounds} 次已采纳规划结果用过）。`] : []),
    ...(selection.released ? [`已放宽最早 ${selection.released} 轮冷却记录，以上可选名单已更新。`] : []),
    ...(selection.visual ? [] : [buildMangaCatalog(candidates,selection.selectionNotes,false)]),
    selection.singleImageMode ? 'layout_fallback：禁止（单图不使用冷却放宽，合法全页ID可复用）。' : selection.visual ? `layout_fallback：${canRelax ? '允许' : '禁止（已无可解除的冷却记录）'}。` : canRelax
      ? '若有应绘制的事件，但本轮候选均无法满足原文时序、画布、槽位、文字容量或同轮去重，不删改剧情、不强塞内容，也不自行选禁用 ID。返回控制结果 {"images":[],"changes":[],"layout_fallback":"候选不适用的具体原因"}；宿主会从最早记录起逐步解除并重新请求。此结果不受最少图片数限制，不代表本轮最终结果。'
      : '本轮已无更多冷却记录可解除；不要输出 layout_fallback，按宿主图片数量与事实要求输出最终结果。',
    '<<<STB-/KEEP>>>',
  ].join('\n');
  const index = messages.findIndex(message => message.content.startsWith(HEADER) || message.content.startsWith('【本轮版式冷却白名单】'));
  const message: ChatMsg = { role: 'system', content }; // Dynamic: must reach DSH on every generate request.
  if (index < 0) messages.push(message); else messages[index] = message;
}

/** Atlas covers the entire compatible catalog; cooldown changes only the text whitelist. */
export async function prepareLayoutSelectionMessage(messages: ChatMsg[], selection: LayoutSelection): Promise<void> {
  setLayoutSelectionMessage(messages,selection);
  if (!selection.visual) return;
  const atlases=buildLayoutAtlases(selection.layouts);
  if (!atlases.length) return;
  const catalog=['【会话完整版式空间目录】覆盖全部启用且画布相容的版式，每张图4套；panel 编号就是 item.panel，F位置[左,上,宽,高]%相对整页；宽高比按实际尺寸、面积按轮廓计算且未扣遮挡，均不保证文字容量。图册不是本轮白名单，冷却限制另行下发。',
    '<<<STB-KEEP>>>',
    selection.singleImageMode
      ? '【会话版式选择规则】单图模式：只从本轮全页单格白名单选择，同轮可复用同一ID，不做跨轮布局冷却；每个images项独立成图，panel固定1。图册只提供几何，不授予额外槽位权限。'
      : '【会话版式选择规则】以下固定说明随图册保留，后续每轮仅更新选择范围与冷却状态。只从本轮可选 ID 中选择；格位、大小、槽位和用途参考本图册。图册含冷却 ID，不授予选择权限；同轮多页必须使用不同 ID。',
    selection.singleImageMode
      ? '单图不使用冷却放宽控制结果，不输出layout_fallback；按本轮数量和事实要求生成各自完整的单图，不因复用同一ID而更换画幅或删减图片。'
      : '本轮标注 layout_fallback 允许时，若所有候选均无法满足原文时序、画布、槽位、文字容量或同轮去重，不删改剧情、不强塞内容，也不自行选禁用 ID；返回控制结果 {"images":[],"changes":[],"layout_fallback":"候选不适用的具体原因"}，宿主会从最早记录起逐步解除并重新请求。此控制结果不受最少图片数限制，不代表本轮最终结果。本轮标注禁止时，不输出 layout_fallback，按宿主图片数量与事实要求输出最终结果。',
    ...buildMangaCatalog(selection.layouts,selection.selectionNotes,true).split('\n').slice(1),
    '<<<STB-/KEEP>>>'].join('\n');
  const revision=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([atlases.map(atlas=>atlas.svg),catalog]))))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const images: string[]=[];
  for (const atlas of atlases) images.push(await rasterizeLayoutAtlas(atlas.svg));
  // Conservative grouping for other APIs; DSH regroups using its live capabilities.
  messages.push(...layoutAtlasMessages(images,atlases.map(atlas=>`${atlas.orientation}，layout ID ${atlas.ids.join('、')}`),4,revision,catalog));
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
    if (!selection.singleImageMode && used.has(id)) throw new Error(`同轮多页不能重复使用版式 ${id}`);
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
