import { MANGA_TABLE } from '@/manga/table';
import type { FrameBox, MangaLayoutDef, MangaOrientation, MangaPanel } from '@/manga/table';

export type { FrameBox, MangaLayoutDef, MangaOrientation, MangaPanel };

/** Numbered instances retain the base role, but never alias another slot's coordinates. */
export function slotType(key: string): string { return key.replace(/_[1-9]\d*$/, ''); }

/** Use the actual frame outline, including slanted edges, for subject breakout. */
function crossingSubjects(panel: MangaPanel): string[] {
  const box=panel.slots.F;
  if (!box) return [];
  const [top,left,bottom,right]=box;
  const outline=panel.shapes?.F ?? [[left,top],[right,top],[right,bottom],[left,bottom]];
  return Object.entries(panel.slots).filter(([key,region])=>{
    if (!['S','L','R'].includes(slotType(key))) return false;
    const [y1,x1,y2,x2]=region;
    const points=panel.shapes?.[key] ?? [[x1,y1],[x2,y1],[x2,y2],[x1,y2]];
    return points.some(([x,y])=>outline.some(([ax,ay],i)=>{
      const [bx,by]=outline[(i+1)%outline.length];
      return (bx-ax)*(y-ay)-(by-ay)*(x-ax)<-.01;
    }));
  }).map(([key])=>key);
}

/**
 * 漫画 Layout 模式的持久化设置。
 *
 * 设计口径:坐标表不进提示词。模型只写「第几格 / 哪个槽位」这种符号引用,
 * 由插件在组装请求前查表补上整数框——与 MOSS-Image 官方 compile_prompt.py 的分工一致
 * (官方:model 不自己算坐标,工具负责换算)。关闭 enabled 时本模块全部不生效,
 * 插件走原本的生图配置。
 */
export interface MangaSettings {
  /** 漫画模式总开关。关闭后不注入坐标、不追加漫画协议。 */
  enabled: boolean;
  /** 最近多少次成功采纳的自动 tag 请求不得重复选版；0 关闭跨轮冷却。 */
  cooldownRounds: number;
  /** Planning geometry presentation; image mode requires a vision-capable API. */
  catalogMode?: 'text' | 'image';
  /** 版式选择说明:整段拼入提示词末尾，用来补充想要选择的版式。 */
  selectionNotes: string;
  /** 出框基准像素:按格数分档,2 格 ×1.25、3 格 ×1、4 格 ×0.8、5 格以上 ×0.6。 */
  bleed: number;
  /** 漫画模式专用规范:非空时取代「自动生成 tag」里的后端规范框。 */
  spec: string;
  /** 漫画模式专用思考清单:非空时取代常规思考清单。 */
  thinking: string;
  /** 被停用的版式 id(内置或自定义)。 */
  disabled: string[];
  /** 已删除的内置版式；保留记录以便恢复，不再进入可选清单。 */
  deleted: string[];
  /** 自定义版式;与内置同 id 时覆盖它的面板,新 id 则追加。 */
  custom: MangaCustomLayout[];
  /** 一次性补齐旧自定义版式的 BL/BR；之后尊重用户删除。 */
  textSlotsVersion?: number;
}

/** 设置页可管理的一条版式;两个方向可以各自缺省。 */
export interface MangaCustomLayout {
  id: string;
  label?: string;
  /** 选择引导：这套版式适合什么节拍，拼进提示词清单。 */
  usage?: string;
  readingOrder?: string;
  portrait?: MangaPanel[];
  landscape?: MangaPanel[];
  /** 自定义画布尺寸；同时保存横竖版时，另一方向交换宽高。缺省沿用内置画布。 */
  canvas?: { width: number; height: number };
}

export interface ResolvedLayout extends MangaLayoutDef {
  id: string;
  canvas: { width: number; height: number };
}

export function mangaDefaults(): MangaSettings {
  return { enabled: false, cooldownRounds: 3, catalogMode: 'text', disabled: [], deleted: [], selectionNotes: '', bleed: 72, spec: '', thinking: '', custom: [], textSlotsVersion:1 };
}

export function normalizeCooldownRounds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(30, Math.floor(value))) : 3;
}

/** Split only an existing bottom text region; never recreate other deleted slots. */
export function withBottomTextSlots(panel: MangaPanel): MangaPanel {
  const bottom = panel.slots.B;
  if (!bottom || bottom[3]-bottom[1]<2) return panel;
  const [top,left,end,right] = bottom;
  const middle = Math.floor((left+right)/2), gap = Math.min(12,Math.floor((right-left)/20));
  return { ...panel, slots:{ ...panel.slots,
    BL:panel.slots.BL ?? [top,left,end,middle-gap],
    BR:panel.slots.BR ?? [top,middle+gap,end,right],
  } };
}

const TEXT_REGIONS: Record<string,string> = {
  T:'upper', TL:'upper-left', TR:'upper-right', B:'lower',
  BL:'lower-left', BR:'lower-right', ML:'middle-left', MR:'middle-right',
};

/** 从画布宽高判断方向;缺尺寸时按竖屏处理(与插件 size 兜底一致)。 */
export function orientationOf(width?: number, height?: number): MangaOrientation {
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
    return width > height ? 'landscape' : 'portrait';
  }
  return 'portrait';
}

export function canvasOf(orientation: MangaOrientation): { width: number; height: number } {
  return MANGA_TABLE.canvases[orientation];
}

/** 内置版式 id 列表(按内置顺序)。 */
export function builtinIds(orientation: MangaOrientation): string[] {
  return Object.keys(MANGA_TABLE.layouts[orientation] ?? {});
}

export function layoutCanvas(entry: MangaCustomLayout | undefined, orientation: MangaOrientation): { width: number; height: number } {
  if (!entry?.[orientation]?.length || !entry.canvas) return canvasOf(orientation);
  const { width, height } = entry.canvas;
  return entry.portrait?.length && entry.landscape?.length && orientationOf(width, height) !== orientation
    ? { width: height, height: width } : { width, height };
}

export function resizeMangaPanels(panels: MangaPanel[], source: { width: number; height: number }, target: { width: number; height: number }): MangaPanel[] {
  const sx = target.width / source.width, sy = target.height / source.height;
  return panels.map(panel => ({ ...panel,
    slots: Object.fromEntries(Object.entries(panel.slots).map(([key, box]) => [key, box.map((value,index) => Math.round(value * (index % 2 ? sx : sy)))])),
    ...(panel.shapes ? { shapes: Object.fromEntries(Object.entries(panel.shapes).map(([key, points]) => [key, points.map(([x,y]) => [Math.round(x*sx), Math.round(y*sy)])])) } : {}),
  }));
}

/** Resize the current list atomically; deleted entries and enable flags stay untouched. */
export function resizeMangaCanvases(manga: MangaSettings, width: number, height: number): MangaCustomLayout[] {
  const canvas = normalizeCanvas({ width, height });
  if (!canvas) throw new Error('画布宽高须为 64～8192 的偶数。');
  const portrait = { width: Math.min(width,height), height: Math.max(width,height) };
  const updates = new Map(manga.custom.map(entry => [entry.id, entry]));
  const changed = new Set<string>();
  const probe = { ...manga, disabled: [] };
  // Resolve both directions before replacing any entries so every scale uses the original canvas.
  for (const orientation of ['portrait', 'landscape'] as const) {
    const target = orientation === 'portrait' ? portrait : { width: portrait.height, height: portrait.width };
    for (const layout of resolveLayouts(probe, orientation)) {
      const entry = updates.get(layout.id);
      changed.add(layout.id);
      updates.set(layout.id, { ...entry, id: layout.id, label: layout.label, usage: layout.usage, readingOrder: layout.readingOrder,
        canvas: orientation === 'landscape' && entry?.portrait?.length ? portrait : target,
        [orientation]: resizeMangaPanels(layout.panels, layout.canvas, target),
      });
    }
  }
  return [...updates.values()].map(entry => changed.has(entry.id) ? parseCustomLayout(JSON.stringify(entry)) : entry);
}

/**
 * 合并内置与自定义,按内置顺序优先,自定义新 id 追加在后。
 * 停用的 id 不出现——提示词清单与坐标注入用的是同一份结果,不会出现「模型能选但查不到框」。
 */
export function resolveLayouts(manga: MangaSettings, orientation: MangaOrientation): ResolvedLayout[] {
  const base = MANGA_TABLE.layouts[orientation] ?? {};
  const pending = new Map<string, MangaCustomLayout>();
  for (const entry of manga.custom) pending.set(entry.id, entry);

  const out: ResolvedLayout[] = [];
  for (const [id, def] of Object.entries(base)) {
    const override = pending.get(id);
    pending.delete(id);
    out.push({
      id,
      canvas: layoutCanvas(override, orientation),
      label: override?.label?.trim() || def.label,
      usage: override?.usage?.trim() || def.usage,
      readingOrder: override?.readingOrder?.trim() || def.readingOrder,
      panels: override?.[orientation]?.length ? override[orientation]! : def.panels.map(withBottomTextSlots),
    });
  }
  for (const entry of pending.values()) {
    const panels = entry[orientation];
    if (!panels?.length) continue;
    out.push({
      id: entry.id,
      canvas: layoutCanvas(entry, orientation),
      label: entry.label?.trim() || entry.id,
      usage: entry.usage?.trim(),
      readingOrder: entry.readingOrder?.trim() || '',
      panels,
    });
  }
  const disabled = new Set([...manga.disabled, ...(manga.deleted ?? [])]);
  return out.filter(layout => !disabled.has(layout.id));
}

export function resolveLayout(
  manga: MangaSettings,
  orientation: MangaOrientation,
  id: string,
): ResolvedLayout | null {
  return resolveLayouts(manga, orientation).find(layout => layout.id === id) ?? null;
}

function panelRefIndex(layout: ResolvedLayout, ref: unknown): MangaPanel | null {
  if (typeof ref === 'number' && Number.isInteger(ref)) {
    return layout.panels[ref - 1] ?? null;
  }
  const text = typeof ref === 'string' ? ref.trim() : '';
  if (!text) return null;
  if (/^\d+$/.test(text)) return layout.panels[Number(text) - 1] ?? null;
  const lower = text.toLowerCase();
  const exact = layout.panels.find(panel => panel.position.toLowerCase() === lower);
  if (exact) return exact;
  const generic = /^panel-(\d+)$/.exec(lower);
  if (generic) return layout.panels[Number(generic[1])-1] ?? null;
  // Older visual saves replaced built-in position names with sequential panel-N IDs.
  const builtin = MANGA_TABLE.layouts[orientationOf(layout.canvas.width,layout.canvas.height)]?.[layout.id];
  if (builtin?.panels.length === layout.panels.length && layout.panels.every((panel,i)=>panel.position===`panel-${i+1}`)) {
    const index = builtin.panels.findIndex(panel=>panel.position.toLowerCase()===lower);
    return layout.panels[index] ?? null;
  }
  return null;
}

/**
 * 把 tag 里的符号框换成整数框。
 *
 * - 关闭漫画模式时原样返回；开启时要求有效的版式与 panel/slot 引用。
 * - 版式不存在、格号超界、槽位在该格不存在时抛错:宁可让这次生成失败,
 *   也不要把符号框原样送去出图——那会得到一张完全错位的图,且没有任何地方会提示。
 */
export function applyMangaFrames(
  prompt: string,
  manga: MangaSettings,
  size: { width?: number; height?: number } | null,
): string {
  if (!manga.enabled) return prompt;
  const text = prompt.trim();
  if (!text.startsWith('{')) throw new Error('漫画 Layout:已开启版式功能，提示词必须是包含 layout 的 JSON；请重新生成提示词。');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('漫画 Layout:提示词 JSON 无法解析，请重新生成提示词。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('漫画 Layout:需要包含 layout 的 JSON 对象。');

  const root = parsed as Record<string, unknown>;
  const layoutId = typeof root.layout === 'string' ? root.layout.trim() : '';
  if (!layoutId) throw new Error('漫画 Layout:缺少 layout 版式 ID，不能绕过启用清单直接使用自定义 bbox；请重新生成提示词。');

  const orientation = orientationOf(size?.width, size?.height);
  const layout = resolveLayout(manga, orientation, layoutId);
  if (!layout) {
    throw new Error(
      `漫画 Layout:版式 ${layoutId} 不存在或已停用(${orientation} 方向)。请在设置页「漫画 Layout」里启用它，或恢复已删除的默认版式。`,
    );
  }
  const canvas = layout.canvas;
  if (size?.width !== canvas.width || size?.height !== canvas.height) {
    throw new Error(`漫画 Layout:版式 ${layoutId} 需要 ${canvas.width}×${canvas.height} 画布，请将工作流和预设尺寸设为相同值。`);
  }

  if (!Array.isArray(root.items) || !root.items.length) {
    throw new Error('漫画 Layout:items 必须是非空数组。');
  }
  const items = root.items;
  const usedSubjects = new Set<string>();
  const textUsage = new Map<MangaPanel, Map<string,number>>();
  const textGroups = new Map<string,{ box:FrameBox; items:Record<string,unknown>[]; shaped:boolean }>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string,unknown>, panel=panelRefIndex(layout,item.panel);
    const slot=typeof item.slot==='string' ? item.slot.trim().toUpperCase() : '';
    if (panel && ['TL','TR'].includes(slot) && panel.slots[slot]) {
      const counts=textUsage.get(panel) ?? new Map<string,number>();
      counts.set(slot,(counts.get(slot) ?? 0)+1); textUsage.set(panel,counts);
    }
  }
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new Error('漫画 Layout:每个 item 必须是对象。');
    }
    const item = rawItem as Record<string, unknown>;
    const slot = typeof item.slot === 'string' ? item.slot.trim().toUpperCase() : '';
    if (slot) {
      const panel = panelRefIndex(layout, item.panel);
      if (!panel) {
        throw new Error(
          `漫画 Layout:版式 ${layout.id} 没有第 ${String(item.panel)} 格(共 ${layout.panels.length} 格；可用 ${layout.panels.map((panel,i)=>`${i+1}=${panel.position}`).join(', ')}；也可用数字格号)。`,
        );
      }
      let resolvedSlot=slot;
      if (slot==='T' && !panel.slots.T) {
        const counts=textUsage.get(panel) ?? new Map<string,number>();
        const alternatives=['TL','TR'].filter(key=>panel.slots[key]).sort((a,b)=>(counts.get(a) ?? 0)-(counts.get(b) ?? 0));
        if (alternatives.length) {
          resolvedSlot=alternatives[0]; counts.set(resolvedSlot,(counts.get(resolvedSlot) ?? 0)+1); textUsage.set(panel,counts);
        }
      }
      const box = resolvedSlot === 'X' && panel.slots.F ? breakoutBox(panel, layout.panels.length, manga.bleed, canvas) : panel.slots[resolvedSlot];
      if (!box) {
        throw new Error(
          `漫画 Layout:版式 ${layout.id} 的 ${panel.position} 格没有 ${slot} 槽位(可用 ${slotLine(panel)})。`,
        );
      }
      item.bbox = box;
      if (item.label==='character' && ['S','L','R'].includes(slotType(resolvedSlot))) usedSubjects.add(`${layout.panels.indexOf(panel)}:${resolvedSlot}`);
      // Keep panel membership after removing symbolic fields. Inner boxes are
      // content regions, not additional comic frames.
      const caption = typeof item.caption === 'string' ? item.caption.replace(/^\s*panel\s+\d+\s*[,;:]\s*/i,'') : '';
      item.caption = `Content of panel ${layout.panels.indexOf(panel)+1}: ${caption}`.trim();
      if (item.label==='text' && typeof item.text==='string' && item.text.trim() && TEXT_REGIONS[slotType(resolvedSlot)]) {
        item.caption += ` Placement: ${TEXT_REGIONS[slotType(resolvedSlot)]} text region.`;
        const key=`${layout.panels.indexOf(panel)}:${resolvedSlot}`;
        const group=textGroups.get(key) ?? {box,items:[],shaped:!!panel.shapes?.[resolvedSlot]};
        group.items.push(item); textGroups.set(key,group);
      }
      const shape = panel.shapes?.[resolvedSlot];
      if (shape && resolvedSlot !== 'F') {
        const corners = shape.map(([x,y]) => `(${x},${y})`).join(', ');
        item.caption = `${typeof item.caption === 'string' ? item.caption : ''} Composition guide: this region has a slanted quadrilateral contour with clockwise corners ${corners}, in centered pixel coordinates. Preserve the illustrated contents without warping them; this is a composition guide, not lettering.`.trim();
      }
    } else {
      throw new Error('漫画 Layout:版式功能开启时每个 item 都需要 panel/slot 引用，不能使用自定义 bbox 绕过槽位。');
    }
    delete item.slot;
    delete item.panel;
  }
  // Repeated text in one rectangular region gets separate vertical boxes in
  // utterance order. No items are invented for unused regions or silent people.
  for (const {box,items:group,shaped} of textGroups.values()) {
    if (group.length<2) continue;
    if (shaped) throw new Error('漫画 Layout:同一非矩形字区有多条文字，请分别使用独立字区，或换版式／拆格。');
    const [top,left,bottom,right]=box, count=group.length;
    const gap=Math.min(8,Math.floor((bottom-top)/(count*4)));
    const height=(bottom-top-gap*(count-1))/count;
    if (height<1) throw new Error('漫画 Layout:字区容量不足，请改用独立字区、换版式或拆格。');
    group.forEach((item,index)=>{
      const start=Math.round(top+index*(height+gap)), end=Math.round(top+index*(height+gap)+height);
      item.bbox=[start,left,end,right];
      item.caption += ` Text ${index+1} of ${count} in this region, read from top to bottom.`;
    });
  }
  delete root.layout;
  const summary = root.summary && typeof root.summary==='object' && !Array.isArray(root.summary) ? root.summary as Record<string,unknown> : {};
  // One authoritative page guide, before style prose; never repeat pairwise
  // occlusion or outer-frame coordinates in each character/text caption.
  const hasText = items.some(item => item.label === 'text' && typeof item.text === 'string' && item.text.trim());
  summary.caption = `${pageFrameGuide(layout, hasText, usedSubjects)} ${typeof summary.caption==='string' ? summary.caption : ''}`.trim();
  root.summary=summary;
  root.bbox_coord_space = 'abs_centralized';
  root.bbox_format = 'yxyx';
  return JSON.stringify(root);
}

function pageFrameGuide(layout: ResolvedLayout, hasText: boolean, usedSubjects: Set<string>): string {
  const frames = layout.panels.map((panel,index) => {
    const box = panel.slots.F ?? panel.slots.C;
    const shape = panel.shapes?.F;
    const crossing = crossingSubjects(panel).filter(key=>usedSubjects.has(`${index}:${key}`)).map(key=>`; ${key} is a continuous foreground subject region extending across the outer border, yxyx ${JSON.stringify(panel.slots[key])}; keep its subject continuous across the crossed borders`).join('');
    const contour = (shape ? `; clockwise corners xy ${JSON.stringify(shape)}` : '') + crossing;
    return `panel ${index+1}${box ? ` (${framePosition(box,layout.canvas)}), outer frame yxyx [${box.join(', ')}]` : ' (no outer frame specified)'}${contour}`;
  });
  const layering = panelLayerGuides(layout.panels);
  return [
    `Page frame guide: exactly ${layout.panels.length} distinct comic panels; preserve the specified frames without additional subdivisions.`,
    'All frame coordinates below are centered pixels.',
    `${frames.join('; ')}.`,
    ...(layering.length ? [`Stacking: ${layering.join('; ')}. Front frames occlude rear frames only in their overlap; the rear scene continues behind them. Overlays and inset panels do not split the rear frame into extra panels.`] : []),
    `Reading sequence: ${layout.panels.map((_,i)=>`panel ${i+1}`).join(' then ')}; stacking does not change this sequence.`,
    'Each item belongs to its named panel; its bbox is a content region, not another comic frame. Only explicitly described border overlaps may extend outside that panel. Panel references and layout instructions are not visible lettering.',
    ...(hasText ? ['Visible lettering follows the supplied text items and their assigned regions. Preserve each item’s exact wording and described container. Text placement can overlap secondary clothing while keeping faces, key hand gestures, contact points and important props clearly visible.'] : []),
  ].join(' ');
}

/** A short spatial description helps distinguish full-page frames from inserts. */
function framePosition([top,left,bottom,right]: FrameBox, canvas: ResolvedLayout['canvas']): string {
  const fullWidth = right-left >= canvas.width*0.85;
  const fullHeight = bottom-top >= canvas.height*0.85;
  if (fullWidth && fullHeight) return 'nearly full-page';
  const x = (left+right)/2, y = (top+bottom)/2;
  const horizontal = x < -canvas.width/6 ? 'left' : x > canvas.width/6 ? 'right' : 'center';
  const vertical = y < -canvas.height/6 ? 'upper' : y > canvas.height/6 ? 'lower' : 'middle';
  return fullHeight ? `full-height ${horizontal}` : fullWidth ? `full-width ${vertical}` : `${vertical}-${horizontal}`;
}

/** Positive-area intersection of convex frame outlines (separating axes). */
function framesOverlap(first: MangaPanel, second: MangaPanel): boolean {
  const polygons: number[][][] = [];
  for (const panel of [first, second]) {
    const box = panel.slots.F;
    if (!box) return false;
    const [top,left,bottom,right] = box;
    polygons.push(panel.shapes?.F ?? [[left,top],[right,top],[right,bottom],[left,bottom]]);
  }
  for (const points of polygons) for (let i=0;i<points.length;i++) {
    const [x,y]=points[i], [nextX,nextY]=points[(i+1)%points.length];
    const axisX=y-nextY, axisY=nextX-x;
    const [a,b]=polygons.map(polygon=>polygon.map(([px,py])=>px*axisX+py*axisY));
    if (Math.min(Math.max(...a),Math.max(...b))<=Math.max(Math.min(...a),Math.min(...b))) return false;
  }
  return true;
}

/** Pairwise overlap constraints; layer is plugin metadata, never an invented MOSS field. */
export function panelLayerGuides(panels: MangaPanel[], target?: MangaPanel): string[] {
  const ordered = panels.map((panel,index)=>({panel,index})).sort((a,b)=>(a.panel.layer ?? a.index)-(b.panel.layer ?? b.index) || a.index-b.index);
  const guides: string[] = [];
  for (let i=0;i<ordered.length;i++) for (let j=i+1;j<ordered.length;j++) {
    const back=ordered[i], front=ordered[j];
    if (target && target!==back.panel && target!==front.panel) continue;
    if (!framesOverlap(back.panel,front.panel)) continue;
    guides.push(`panel ${front.index+1} is in front of panel ${back.index+1}`);
  }
  return guides;
}

/** 出框像素按格数分档：格越少，邻格面积越大，可以越得更多。 */
export function bleedFor(base: number, panelCount: number): number {
  const b = Number.isFinite(base) && base > 0 ? base : 72;
  if (panelCount <= 2) return Math.round(b * 1.25);
  if (panelCount === 3) return Math.round(b);
  if (panelCount === 4) return Math.round(b * 0.8);
  return Math.round(b * 0.6);
}

/** X 槽不入表，按当前设置与格数现算，并裁到画布内。 */
function breakoutBox(panel: MangaPanel, panelCount: number, base: number, canvas: { width: number; height: number }): FrameBox {
  const bleed = bleedFor(base, panelCount);
  const [y1, x1, y2, x2] = panel.slots.F;
  return [
    Math.max(-canvas.height / 2, y1 - bleed),
    Math.max(-canvas.width / 2, x1 - bleed),
    Math.min(canvas.height / 2, y2 + bleed),
    Math.min(canvas.width / 2, x2 + bleed),
  ];
}

function slotLine(panel: MangaPanel): string {
  return Object.keys(panel.slots).filter(slot => slotType(slot) !== 'X').join(' ');
}

function regionOutline(panel: MangaPanel, slot: string): number[][] | undefined {
  const box = panel.slots[slot];
  if (!box) return;
  const [top,left,bottom,right] = box;
  return panel.shapes?.[slot] ?? [[left,top],[right,top],[right,bottom],[left,bottom]];
}

function outlineArea(points: number[][]): number {
  return Math.abs(points.reduce((sum,[x,y],i) => {
    const [nextX,nextY] = points[(i+1)%points.length];
    return sum + x*nextY-nextX*y;
  },0))/2;
}

function outlineBox(points: number[][]): FrameBox {
  return [Math.min(...points.map(p=>p[1])),Math.min(...points.map(p=>p[0])),
    Math.max(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0]))];
}

const rounded = (value: number): number => Math.round(value*10)/10;
function relativeBox(box: FrameBox, base: FrameBox): number[] {
  const [top,left,bottom,right]=box, [baseTop,baseLeft,baseBottom,baseRight]=base;
  return [(left-baseLeft)/(baseRight-baseLeft), (top-baseTop)/(baseBottom-baseTop),
    (right-left)/(baseRight-baseLeft), (bottom-top)/(baseBottom-baseTop)].map(value=>rounded(value*100));
}

function frameContains(outer: number[][], inner: number[][]): boolean {
  return inner.every(([x,y])=> {
    const crosses=outer.map(([ax,ay],i)=> {
      const [bx,by]=outer[(i+1)%outer.length];
      return (bx-ax)*(y-ay)-(by-ay)*(x-ax);
    });
    return crosses.every(value=>value>=-0.01) || crosses.every(value=>value<=0.01);
  });
}

/** Only exceptional regions need geometry in the LLM catalog; all legal keys are listed separately. */
function compactRegions(panel: MangaPanel, base: FrameBox): string[] {
  const anchors:Record<string,[number,number]>={T:[0.5,0],B:[0.5,1],TL:[0,0],TR:[1,0],BL:[0,1],BR:[1,1],ML:[0,0.5],MR:[1,0.5],L:[0,0.5],R:[1,0.5],O:[0.5,0.5]};
  const groups = new Map<string, {keys:string[]; bounds:FrameBox; points:number[][]; shaped:boolean}>();
  for (const key of Object.keys(panel.slots).filter(key => !['F','X'].includes(slotType(key)))) {
    const points = regionOutline(panel,key)!, bounds = outlineBox(points), shaped = !!panel.shapes?.[key];
    const [x,y,w,h] = relativeBox(bounds,base), cx = (x+w/2)/100, cy = (y+h/2)/100;
    const anchor = anchors[key];
    // Display-only heuristics: these thresholds never classify panel size or change compiler geometry.
    const conventional = anchor
      ? Math.abs(cx-anchor[0]) <= (anchor[0]===0.5 ? 0.16 : 0.34) && Math.abs(cy-anchor[1]) <= (anchor[1]===0.5 ? 0.16 : 0.34)
      : key==='C' ? w>=85 && h>=85 && Math.abs(cx-0.5)<=0.1 && Math.abs(cy-0.5)<=0.1
      : key==='S' && w>=60 && h>=50 && Math.abs(cx-0.5)<=0.15 && Math.abs(cy-0.5)<=0.2;
    const standard = !shaped && !!panel.slots.F && frameContains(regionOutline(panel,'F')!,points) && conventional;
    if (standard) continue;
    const identity = JSON.stringify([bounds, shaped ? points : null]);
    const group = groups.get(identity);
    if (group) group.keys.push(key);
    else groups.set(identity,{keys:[key],bounds,points,shaped});
  }
  return [...groups.values()].map(({keys,bounds,points,shaped}) =>
    `${keys.join('/')}[${relativeBox(bounds,base)}]${shaped ? `斜框面积${rounded(outlineArea(points)/((bounds[3]-bounds[1])*(bounds[2]-bounds[0]))*100)}%` : ''}`);
}

/** Compact planning geometry only; never changes panel order, saved regions or compiled boxes. */
export function buildMangaCatalog(layouts: Record<MangaOrientation, ResolvedLayout[]>, notes='', visual=false): string {
  const lines=visual ? [
    '【本轮候选版式空间目录】几何见本轮示意图；每张图4套，按ID对应；P1等于item.panel=1，槽位标签按本格合法键引用。',
    '图片只表示已保存的框位和叠放，不是角色、动作或文字内容。各槽位是可选区域，不要求填满；形状不授权新增slot或改动边界。文字清单负责精确代号与用途，实际坐标由插件编译。',
  ] : [
    '【本轮候选版式空间目录】本轮目录优先于历史清单；位置代号只是标识，不表示读序或大小。',
    'F位置[左,上,宽,高]%相对整页，原点为左上；宽高比按实际尺寸计算，面积按实际轮廓计算且未扣遮挡，面积排名不等于叙事主次，也不设大小格阈值。',
    '槽位只列本格合法键；常规范围省略，不代表无限空间。特殊区域[左,上,宽,高]%相对F外接框：保留编号、偏置或狭窄主体、非标准位置、斜框与出框范围；无F时相对整页。斜框另列实际面积/外接框面积。斜杠连接仅表示范围相同，输出仍选单个合法键。百分比不是输出坐标或文字容量保证。',
  ];
  for (const orientation of ['portrait','landscape'] as const) {
    const entries=layouts[orientation];
    if (!entries.length) continue;
    lines.push(`${orientation}(${[...new Set(entries.map(layout=>`${layout.canvas.width}×${layout.canvas.height}`))].join(' / ')}):`);
    for (const layout of entries) {
      const parts=[layout.id,`${layout.panels.length} 格`,`画布 ${layout.canvas.width}×${layout.canvas.height}`];
      if (layout.usage) parts.push(layout.usage);
      const readingOrder = layout.readingOrder?.replace(/panel-\d+\b/g, name => {
        const index = layout.panels.findIndex(panel => panel.position === name);
        return index < 0 ? name : String(index+1);
      });
      lines.push(`- ${parts.join('｜')}${readingOrder ? `｜读序 ${readingOrder}` : ''}`);
      if (!visual) lines.push(`  格位概览：${layout.panels.map((panel,index)=>`${index+1}=${panel.slots.F ? framePosition(outlineBox(regionOutline(panel,'F')!),layout.canvas).replace('nearly full-page','近乎整页').replace('full-height','通高').replace('full-width','通栏').replace('upper','上方').replace('lower','下方').replace('middle','中部').replace('center','居中').replace('left','左侧').replace('right','右侧') : '边界未知'}`).join('，')}`);
      if (layout.panels.some(panel=>panel.layer!==undefined) && panelLayerGuides(layout.panels).length) {
        const order=layout.panels.map((panel,index)=>({panel,index})).sort((a,b)=>(a.panel.layer ?? a.index)-(b.panel.layer ?? b.index) || a.index-b.index);
        lines.push(`  Panel stacking, back to front: ${order.map(({index})=>`panel ${index+1}`).join(' → ')}; apply occlusion only where frames overlap, preserving reading order.`);
      }
      const {width,height}=layout.canvas, page=[-height/2,-width/2,height/2,width/2];
      const outlines=layout.panels.map(panel=>regionOutline(panel,'F'));
      const areas=outlines.map(points=>points ? outlineArea(points) : 0);
      layout.panels.forEach((panel,index)=> {
        const outline=outlines[index], box=outline ? outlineBox(outline) : page;
        const [top,left,bottom,right]=box;
        const geometry=outline
          ? `F 位置[${relativeBox(box,page)}]% 宽高比${Math.round((right-left)/(bottom-top)*100)/100} 面积${rounded(areas[index]/(width*height)*100)}% 排名${areas.filter(area=>area>areas[index]).length+1}/${layout.panels.length}${panel.shapes?.F ? `；斜四边形轮廓[${outline.map(([x,y])=>`${rounded((x-left)/(right-left)*100)},${rounded((y-top)/(bottom-top)*100)}`).join(';')}]%相对F外接框` : ''}`
          : 'F未配置，整格边界未知；以下内框相对整页';
        const regions=compactRegions(panel,box);
        const crossing=crossingSubjects(panel);
        const notes=Object.entries(panel.slotNotes ?? {}).filter(([key])=>slotType(key)!=='X');
        lines.push(`  ${index+1}${/^panel-\d+$/.test(panel.position) ? '' : `(${panel.position})`}:${visual ? '' : `${geometry}；`}槽位 ${slotLine(panel)}${!visual && regions.length ? `；特殊区域 ${regions.join(' ')}` : ''}${crossing.length ? `；跨格主体 ${crossing.join(' ')}` : ''}${notes.length ? `；框用途 ${JSON.stringify(Object.fromEntries(notes))}` : ''}`);
      });
      for (const guide of panelLayerGuides(layout.panels)) lines.push(`  重叠层级：${guide}（仅在轮廓重叠处遮挡，不改变读序）。`);
      outlines.forEach((outer,i)=>outlines.forEach((inner,j)=> {
        if (outer && inner && areas[i]>areas[j] && frameContains(outer,inner)) {
          lines.push(`  几何包含：panel ${j+1} 位于 panel ${i+1} 轮廓内；是否同刻嵌入仍按用途与原文判断。`);
        }
      }));
    }
  }
  if (notes.trim()) lines.push(notes.trim());
  return lines.join('\n');
}
/**
 * 生成拼进后端规范的漫画协议段。
 *
 * 版式清单从当前设置现算:新增版式、停用版式都立即反映到下一次请求,
 * 不需要改这份文本,也不需要重载插件。
 */
export function buildMangaSpec(manga: MangaSettings, includeCatalog=true): string {
  const lines: string[] = [];
  lines.push('【版式清单与挑选】这一节由插件按当前启用的版式生成，未启用的版式不会出现；坐标由插件按画布查表注入，你不用写。');
  lines.push('- tag 内层 JSON 顶层增加 layout（从对应方向的启用清单选 id）；每个 items 项填写 panel（从 1 起的格号或位置代号）与 slot，不写 bbox。插件发送前删除 layout/panel/slot 并填入原生坐标。示例版式若已停用，必须替换成清单中的启用版式。');
  lines.push('- 每套版式的画布以该行标注尺寸为准，只选择与实际生成尺寸一致的版式。自定义画布不会自动改变 ComfyUI 工作流或预设尺寸。');
  lines.push('- 读取格式:版式 id｜格数｜画布｜用途｜读序；各格以整数格号标识；有语义的位置名括注，内框键即合法槽位，并列实际位置与空间比例。以本轮动态候选目录为准，历史清单不授予权限。');
  lines.push('- 挑法:先按所选事件的时序、信息量、互动关系与文字容量比较版式,再确定格数;不默认选择最少格。内容适合多格推进时选足够的独立格,内容简单时允许少格,不为凑格补编剧情。分配事件与对白严格沿该行给出的读序。');
  lines.push('- 槽位:F 格框 C 完整内区 S 实际主体区域 L/R 左右人物 O 道具音效 T/TL/TR 顶部字区 B 底部字区 BL/BR 左下/右下字区 ML/MR 侧边字区 E 允许小部分越线进格间留白。清单里没列出的槽位在该格不存在,填了会让这次生成失败。');
  lines.push('- 同类内框可有编号，如 S、S_2、O、O_2、TL、TL_2；每个完整键对应独立区域，编号不表示读序、人物数量或自动新增人物。仅使用该格清单中已有的完整键。');
  lines.push('- 连续人物以一个主体框统领；复杂姿势可用已有辅助框定位手、脚、袖口等局部，局部描述写明所属角色、部位与连接方向，保留覆盖该部位的服装，避免在局部框重复完整外貌或生成另一个人。');
  lines.push('- 同一角色若有有意安排的巨大脸部特写与小比例身体等多尺度展示，分别绑定已有区域并写明同一身份的两处独立呈现，不将两处画成一具连体身体；普通局部辅助则保持与主体连续。');
  lines.push('- 用途与框内说明中的具体人物、地点、道具和动作属于参考示范,不是必须匹配的剧情条件。选版主要比较格形、时序、主次关系与容量,示范内容按原文替换;仍须遵守独立格与同刻嵌入格的区别。');
  lines.push('- 框用途是用户提供的内容分配说明：F 描述整格用途，其余键只作用于对应内框。结合原文与该说明选择内容，不把说明当作台词、旁白或可见印字，不新增槽位、坐标、剧情事件或参与者。空说明沿用槽位默认用途。');
  lines.push('- 字区按实际发言、说话人位置与读序选择 T/TL/TR/B/BL/BR/ML/MR；只有左侧人物说话时仅用左侧所需字区，右侧同理，不为沉默者、空位或配额创建 text 项与空气泡。字区可覆盖次要身体或衣物，不遮脸、关键手势、接触点或重要道具。');
  lines.push('- 每一格只能引用其清单中实际存在的槽位，删除的槽位不可使用。没有 T 时应从现有 TL/TR 选择上方字区，不要假定每格都有 T；没有任何字区时不要生成 text 项。');
  lines.push('- 左侧两泡优先 TL→BL，右侧两泡优先 TR→BR；更多台词可使用该侧现有 ML/MR 等字区，先规划实际读序，不机械按左右交替。BL/BR 是独立字区，仅在清单列出时使用，不与整块 B 混用覆盖同一区域。');
  lines.push('- O 给道具或音效。E 是有限越线(约 8px,只为贴边):越线时 caption 写明所属格与 limited border overlap into the gutter。');
  lines.push('- 跨格主体使用实际 S（或对应的 L/R、编号主体框），出框范围由已保存的区域决定。caption 写明所属格、跨越边界、连续身体与前后遮挡；描述不能改变槽位坐标，区域不足时调整版式。旧 X 仅保留历史编译兼容，新输出按当前清单选择实际槽位。');
  lines.push('- 嵌入格只呈现所属主格同一时刻的反应或局部,caption 写明 simultaneous inset;后续动作必须放进后续独立格,主格主体用收窄后的 C 或 S 避开嵌入框。');
  lines.push('- 相邻格避免无叙事理由的同机位、同景别与同人物占比。');
  if (includeCatalog) lines.push(buildMangaCatalog({portrait:resolveLayouts(manga,'portrait'),landscape:resolveLayouts(manga,'landscape')},manga.selectionNotes));
  return lines.join('\n');
}

/** 设置页校验用:把一段 JSON 解析成自定义版式,失败时抛带定位的错误。 */
export function parseCustomLayout(text: string): MangaCustomLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败:${error instanceof Error ? error.message : String(error)}`);
  }
  parsed = customSource(parsed);
  const entry = normalizeCustom(parsed);
  if (!entry) {
    throw new Error('需要形如 {"id":"my_layout","label":"…","portrait":[{"position":"…","slots":{"F":[y1,x1,y2,x2]}}]}');
  }
  if (!entry.portrait?.length && !entry.landscape?.length) {
    throw new Error('portrait 与 landscape 至少要有一个方向的面板');
  }
  const source = parsed as Record<string, unknown>;
  if (source.canvas !== undefined && !normalizeCanvas(source.canvas)) throw new Error('画布宽高必须是 64～8192 的偶数。');
  for (const orientation of ['portrait', 'landscape'] as const) {
    if (source[orientation] === undefined) continue;
    const panels = source[orientation];
    const canvas = layoutCanvas(entry, orientation);
    if (entry.canvas && canvas.width !== canvas.height && orientationOf(canvas.width, canvas.height) !== orientation) throw new Error('面板方向与自定义画布宽高不符。');
    const positions = new Set<string>();
    if (!Array.isArray(panels) || !panels.length) throw new Error(`${orientation}:需要非空面板数组。`);
    for (const rawPanel of panels) {
      const panel = rawPanel as MangaPanel | null;
      const position = typeof panel?.position === 'string' ? panel.position.trim().toLowerCase() : '';
      if (!position || positions.has(position)) throw new Error(`${orientation}:面板位置不能为空或重复。`);
      positions.add(position);
      if (panel?.layer !== undefined && !Number.isSafeInteger(panel.layer)) throw new Error(`${orientation}/${position}:层级必须为安全整数。`);
      if (!panel?.slots || typeof panel.slots !== 'object' || !Object.keys(panel.slots).length) {
        throw new Error(`${orientation}/${position}:需要槽位坐标。`);
      }
      for (const [slot, rawBox] of Object.entries(panel.slots)) {
        const box = normalizeBox(rawBox);
        if (!slot.trim() || !box || box[0] < -canvas.height / 2 || box[2] > canvas.height / 2 ||
            box[1] < -canvas.width / 2 || box[3] > canvas.width / 2) {
          throw new Error(`${orientation}/${position}/${slot}:坐标无效或超出画布。`);
        }
      }
      for (const [slot, shape] of Object.entries(panel.shapes ?? {})) {
        if (!panel.slots[slot] || !validQuad(shape) || shape.some(([x,y]) => Math.abs(x) > canvas.width/2 || Math.abs(y) > canvas.height/2)) {
          throw new Error(`${orientation}/${position}/${slot}:四边形角点无效、交叉或超出画布。`);
        }
      }
    }
  }
  return entry;
}

function normalizeBox(raw: unknown): FrameBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map(value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN));
  if (nums.some(value => !Number.isSafeInteger(value))) return null;
  const [y1, x1, y2, x2] = nums as [number, number, number, number];
  if (y1 >= y2 || x1 >= x2) return null;
  return [y1, x1, y2, x2];
}

function normalizePanels(raw: unknown): MangaPanel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MangaPanel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const panel = item as Partial<MangaPanel>;
    const position = typeof panel.position === 'string' ? panel.position.trim() : '';
    const slotsRaw = panel.slots && typeof panel.slots === 'object' ? (panel.slots as Record<string, unknown>) : null;
    if (!position || !slotsRaw) continue;
    const slots: Record<string, FrameBox> = {};
    for (const [key, value] of Object.entries(slotsRaw)) {
      const box = normalizeBox(value);
      if (box) slots[key.trim().toUpperCase()] = box;
    }
    const shapes: Record<string, number[][]> = {};
    if (panel.shapes && typeof panel.shapes === 'object') {
      for (const [key, value] of Object.entries(panel.shapes)) {
        const slot = key.trim().toUpperCase();
        if (slots[slot] && validQuad(value)) shapes[slot] = value.map(p => p.map(Math.round));
      }
    }
    const slotNotes: Record<string,string> = {};
    if (panel.slotNotes && typeof panel.slotNotes === 'object' && !Array.isArray(panel.slotNotes)) {
      for (const [key,value] of Object.entries(panel.slotNotes)) {
        const slot = key.trim().toUpperCase();
        if (slots[slot] && typeof value === 'string' && value.trim()) slotNotes[slot] = value.trim();
      }
    }
    if (Object.keys(slots).length) out.push({ position, slots, ...(Number.isSafeInteger(panel.layer) ? { layer:panel.layer } : {}), ...(Object.keys(shapes).length ? { shapes } : {}), ...(Object.keys(slotNotes).length ? { slotNotes } : {}) });
  }
  return out.length ? out : undefined;
}

/** Flat ComfyUI exports use the same centered yxyx geometry; adapt only the envelope. */
function customSource(raw: unknown): unknown {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return raw;
  const entry={...raw} as Record<string,unknown>;
  if (entry.panels!==undefined) {
    if (entry.portrait!==undefined || entry.landscape!==undefined) throw new Error('panels 与 portrait/landscape 不能同时提供，请保留一种版式格式。');
    const canvas=normalizeCanvas(entry.canvas);
    if (!canvas) throw new Error('ComfyUI panels 格式需要有效的 canvas.width 与 canvas.height。');
    if (!Array.isArray(entry.panels) || !entry.panels.length) throw new Error('panels:需要非空面板数组。');
    entry[orientationOf(canvas.width,canvas.height)]=entry.panels;
    delete entry.panels;
  }
  if (typeof entry.description==='string') entry.usage=entry.description;
  return entry;
}

function normalizeCustom(raw: unknown): MangaCustomLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let source: unknown;
  try { source=customSource(raw); } catch { return null; }
  const entry = source as Partial<MangaCustomLayout>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;
  const portrait = normalizePanels(entry.portrait);
  const landscape = normalizePanels(entry.landscape);
  const label = typeof entry.label === 'string' ? entry.label.trim() : undefined;
  const usage = typeof entry.usage === 'string' ? entry.usage.trim() : undefined;
  const readingOrder = typeof entry.readingOrder === 'string' ? entry.readingOrder.trim() : undefined;
  // 只改用途或名称、不动坐标的覆盖条目也合法：panels 会回落到内置表
  if (!portrait && !landscape && !label && !usage && !readingOrder) return null;
  const canvas = normalizeCanvas(entry.canvas);
  return { id, label, usage, readingOrder, portrait, landscape, ...(canvas ? { canvas } : {}) };
}

export function normalizeCanvas(raw: unknown): { width: number; height: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { width, height } = raw as { width: number; height: number };
  return [width, height].every(v => Number.isInteger(v) && v >= 64 && v <= 8192 && v % 2 === 0) ? { width, height } : null;
}

/** 顶点按轮廓顺序排列，拒绝交叉、翻转与退化的四边形。 */
export function validQuad(raw: unknown): raw is number[][] {
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => typeof v !== 'number' || !Number.isFinite(v)))) return false;
  return raw.every((p,i) => {
    const q = raw[(i+1)%4], r = raw[(i+2)%4];
    return (q[0]-p[0])*(r[1]-q[1]) - (q[1]-p[1])*(r[0]-q[0]) > .01;
  });
}

/** 从 extension_settings 里读回的 manga 段做一次结构兜底。 */
export function normalizeManga(raw: unknown): MangaSettings {
  const fallback = mangaDefaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const stored = raw as Partial<MangaSettings>;
  const disabled = Array.isArray(stored.disabled)
    ? stored.disabled.filter((value): value is string => typeof value === 'string' && !!value.trim())
    : [];
  const custom: MangaCustomLayout[] = [];
  if (Array.isArray(stored.custom)) {
    for (const item of stored.custom) {
      const entry = normalizeCustom(item);
      if (entry) {
        if (!stored.textSlotsVersion) {
          for (const direction of ['portrait','landscape'] as const) {
            if (entry[direction]) entry[direction]=entry[direction]!.map(withBottomTextSlots);
          }
        }
        custom.push(entry);
      }
    }
  }
  return {
    enabled: stored.enabled === true,
    cooldownRounds: normalizeCooldownRounds(stored.cooldownRounds),
    catalogMode: stored.catalogMode === 'image' ? 'image' : 'text',
    disabled,
    deleted: Array.isArray(stored.deleted) ? [...new Set(stored.deleted.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(id => builtinIds('portrait').includes(id) || builtinIds('landscape').includes(id)))] : [],
    selectionNotes: typeof stored.selectionNotes === 'string' ? stored.selectionNotes : '',
    bleed: typeof stored.bleed === 'number' && Number.isFinite(stored.bleed) && stored.bleed > 0 ? Math.round(stored.bleed) : 72,
    spec: typeof stored.spec === 'string' ? stored.spec : '',
    thinking: typeof stored.thinking === 'string' ? stored.thinking : '',
    custom,
    textSlotsVersion:1,
  };
}
