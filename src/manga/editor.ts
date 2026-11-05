import type { MangaPanel } from '@/manga/layouts';
import { validQuad } from '@/manga/layouts';

export interface CanvasSize { width: number; height: number }
export interface PanelRect { x: number; y: number; width: number; height: number }
/** 槽位按父格比例保存，移动/缩放外框时随父格变动。F 由外框生成，不能单独删除。 */
export interface EditablePanel extends PanelRect { slots: Record<string, PanelRect>; corners: Record<string, number[][]>; layer?: number; position?: string; slotNotes?: Record<string, string> }
export const MIN_PANEL = 24;
export const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export function fitRect(rect: PanelRect, canvas: CanvasSize, minimum = MIN_PANEL): PanelRect {
  const width = clamp(Math.round(rect.width), minimum, canvas.width);
  const height = clamp(Math.round(rect.height), minimum, canvas.height);
  return { x: clamp(Math.round(rect.x), 0, canvas.width - width), y: clamp(Math.round(rect.y), 0, canvas.height - height), width, height };
}

export function panelRect(panel: MangaPanel, canvas: CanvasSize): PanelRect {
  const [y1, x1, y2, x2] = panel.slots.F ?? panel.slots.C ?? Object.values(panel.slots)[0];
  return fitRect({ x: x1 + canvas.width / 2, y: y1 + canvas.height / 2, width: x2 - x1, height: y2 - y1 }, canvas);
}

export function editablePanel(rect: PanelRect, canvas: CanvasSize, source?: MangaPanel): EditablePanel {
  const result: EditablePanel = { ...rect, slots: {}, corners: {} };
  if (source?.layer !== undefined) result.layer = source.layer;
  if (source?.position) result.position = source.position;
  for (const [key, [y1, x1, y2, x2]] of Object.entries((source ?? panelFromRect(rect, canvas, '')).slots)) {
    if (key === 'F' || key === 'X') continue;
    setSlotRect(result, key, { x: x1 + canvas.width / 2, y: y1 + canvas.height / 2, width: x2 - x1, height: y2 - y1 });
  }
  for (const [key, points] of Object.entries(source?.shapes ?? {})) {
    if (key !== 'F' && !result.slots[key]) continue;
    const bounds = key === 'F' ? result : slotRect(result,key);
    result.corners[key] = points.map(([x,y]) => [(x + canvas.width/2 - bounds.x)/bounds.width, (y + canvas.height/2 - bounds.y)/bounds.height]);
  }
  if (source?.slotNotes) result.slotNotes = { ...source.slotNotes };
  return result;
}

export function quadPoints(panel: EditablePanel, key: string): number[][] {
  const rect = key === 'F' ? panel : slotRect(panel,key);
  return (panel.corners[key] ?? [[0,0],[1,0],[1,1],[0,1]]).map(([x,y]) => [rect.x+x*rect.width,rect.y+y*rect.height]);
}

export function deformCorner(panel: EditablePanel, key: string, points: number[][], canvas: CanvasSize): boolean {
  const clipped = points.map(([x,y]) => [clamp(Math.round(x),0,canvas.width),clamp(Math.round(y),0,canvas.height)]);
  if (!validQuad(clipped)) return false;
  const x = Math.min(...clipped.map(p=>p[0])), y = Math.min(...clipped.map(p=>p[1]));
  const rect = { x, y, width:Math.max(...clipped.map(p=>p[0]))-x, height:Math.max(...clipped.map(p=>p[1]))-y };
  if (rect.width < (key==='F' ? MIN_PANEL : 1) || rect.height < (key==='F' ? MIN_PANEL : 1)) return false;
  if (key==='F') Object.assign(panel,rect); else setSlotRect(panel,key,rect);
  panel.corners[key] = clipped.map(([px,py]) => [(px-x)/rect.width,(py-y)/rect.height]);
  return true;
}

export function slotRect(panel: EditablePanel, key: string): PanelRect {
  const slot = panel.slots[key];
  return { x: Math.round(panel.x + slot.x * panel.width), y: Math.round(panel.y + slot.y * panel.height), width: Math.max(1, Math.round(slot.width * panel.width)), height: Math.max(1, Math.round(slot.height * panel.height)) };
}

export function setSlotRect(panel: EditablePanel, key: string, rect: PanelRect): void {
  panel.slots[key] = { x: (rect.x - panel.x) / panel.width, y: (rect.y - panel.y) / panel.height, width: rect.width / panel.width, height: rect.height / panel.height };
}

export function saveEditedPanel(panel: EditablePanel, canvas: CanvasSize, position: string): MangaPanel {
  const box = (r: PanelRect): number[] => {
    const x1 = clamp(Math.round(r.x), 0, canvas.width - 1), y1 = clamp(Math.round(r.y), 0, canvas.height - 1);
    return [y1 - canvas.height / 2, x1 - canvas.width / 2, clamp(Math.round(r.y + r.height), y1 + 1, canvas.height) - canvas.height / 2, clamp(Math.round(r.x + r.width), x1 + 1, canvas.width) - canvas.width / 2];
  };
  const shapes = Object.fromEntries(Object.keys(panel.corners).filter(key => key === 'F' || panel.slots[key]).map(key => [key,quadPoints(panel,key).map(([x,y])=>[clamp(Math.round(x),0,canvas.width)-canvas.width/2,clamp(Math.round(y),0,canvas.height)-canvas.height/2])]));
  const slotNotes = Object.fromEntries(Object.entries(panel.slotNotes ?? {}).filter(([key,note]) => (key === 'F' || panel.slots[key]) && note.trim()).map(([key,note]) => [key,note.trim()]));
  return { position, ...(panel.layer !== undefined ? { layer:panel.layer } : {}), slots: { F: box(panel), ...Object.fromEntries(Object.keys(panel.slots).map(key => [key, box(slotRect(panel, key))])) }, ...(Object.keys(shapes).length ? { shapes } : {}), ...(Object.keys(slotNotes).length ? { slotNotes } : {}) };
}

/** 自动槽位只是框内的候选区域，不划分人物或约束真实文字尺寸。 */
export function panelFromRect(raw: PanelRect, canvas: CanvasSize, position: string): MangaPanel {
  const rect = fitRect(raw, canvas);
  const box = (left: number, top: number, right: number, bottom: number): number[] => [
    Math.round(rect.y + rect.height * top - canvas.height / 2),
    Math.round(rect.x + rect.width * left - canvas.width / 2),
    Math.round(rect.y + rect.height * bottom - canvas.height / 2),
    Math.round(rect.x + rect.width * right - canvas.width / 2),
  ];
  const slots = {
    F: box(0, 0, 1, 1), C: box(.04, .04, .96, .96), S: box(.04, .28, .96, .96),
    T: box(.06, .04, .94, .25), B: box(.06, .75, .94, .96),
    TL: box(.04, .04, .46, .3), TR: box(.54, .04, .96, .3),
    BL: box(.06, .75, .46, .96), BR: box(.54, .75, .94, .96),
    ML: box(.04, .34, .46, .68), MR: box(.54, .34, .96, .68),
    L: box(.04, .06, .48, .94), R: box(.52, .06, .96, .94),
    O: box(.3, .35, .7, .65),
  };
  return { position, slots };
}

/** 在画布、网格与其它格的边缘/中心之间找最近吸附点，阈值由显示缩放换算。 */
export function snapRect(rect: PanelRect, canvas: CanvasSize, others: PanelRect[], threshold: number, resize = false, minimum = MIN_PANEL): PanelRect {
  const axis = (start: number, length: number, limit: number, points: number[]): [number, number] => {
    if (resize) {
      const edge = start + length;
      const targets = [...points, Math.round(edge / 8) * 8];
      const nearest = targets.reduce((best, p) => Math.abs(p - edge) < Math.abs(best - edge) ? p : best, edge + threshold + 1);
      return [start, Math.abs(nearest - edge) <= threshold ? nearest - start : length];
    }
    let delta = 0, distance = threshold + 1;
    for (const edge of [start, start + length / 2, start + length]) {
      for (const p of [...points, Math.round(edge / 8) * 8]) {
        if (Math.abs(p - edge) < distance) { distance = Math.abs(p - edge); delta = p - edge; }
      }
    }
    return [clamp(start + (distance <= threshold ? delta : 0), 0, limit - length), length];
  };
  const [x, width] = axis(rect.x, rect.width, canvas.width, [0, canvas.width / 2, canvas.width, ...others.flatMap(p => [p.x, p.x + p.width / 2, p.x + p.width])]);
  const [y, height] = axis(rect.y, rect.height, canvas.height, [0, canvas.height / 2, canvas.height, ...others.flatMap(p => [p.y, p.y + p.height / 2, p.y + p.height])]);
  return fitRect({ x, y, width, height }, canvas, minimum);
}
