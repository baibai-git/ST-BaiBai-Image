import { parseCustomLayout, resolveLayouts, orderMangaLayouts, type MangaCustomLayout, type MangaSettings } from './layouts';

import { readLayoutFile, writeLayoutFile, LAYOUT_FORMAT, portableLayout } from './portable';
const FORMAT=LAYOUT_FORMAT;
interface SavedLayout extends MangaCustomLayout { enabled?: boolean }
interface LayoutFile { format: typeof FORMAT; version: 1; layouts: SavedLayout[]; deleted: string[]; order?: string[] }

/** Snapshot the geometry actually used, including disabled entries and built-in fallbacks. */
function snapshots(manga:MangaSettings): SavedLayout[] {
  const byId=new Map<string,SavedLayout>();
  const probe={...manga,disabled:[]};
  for (const orientation of ['portrait','landscape'] as const) {
    for (const layout of resolveLayouts(probe,orientation)) {
      const saved=byId.get(layout.id) ?? {
        id:layout.id,label:layout.label,usage:layout.usage,readingOrder:layout.readingOrder,
        canvas:layout.canvas,enabled:!manga.disabled.includes(layout.id),
        ...(layout.description!==undefined ? {description:layout.description} : {}),
        ...(layout.promptCaption!==undefined ? {promptCaption:layout.promptCaption} : {}),
        ...(layout.promptMode!==undefined ? {promptMode:layout.promptMode} : {}),
        ...(layout.useBboxCorners!==undefined ? {useBboxCorners:layout.useBboxCorners} : {}),
        ...(layout.omitFullPageFrame!==undefined ? {omitFullPageFrame:layout.omitFullPageFrame} : {}),
        ...(layout.omitSmallFrames!==undefined ? {omitSmallFrames:layout.omitSmallFrames} : {}),
      };
      saved[orientation]=layout.panels;
      byId.set(layout.id,saved);
    }
  }
  return orderMangaLayouts([...byId.values()],manga.order);
}

/** Layout-only files deliberately exclude prompt rules, accounts, API keys and chat state. */
export function exportMangaLayouts(manga:MangaSettings, id?:string, legacy=false): string {
  const layouts=snapshots(manga);
  if (id!==undefined) {
    const layout=layouts.find(item=>item.id===id);
    if (!layout) throw new Error(`版式「${id}」不存在或已删除。`);
    return JSON.stringify(legacy ? layout : portableLayout(layout),null,2);
  }
  return writeLayoutFile(layouts,{deleted:[...manga.deleted],order:layouts.map(layout=>layout.id),legacy});
}

/** Validate every entry before returning a new state; never partially apply a damaged file. */
export function importMangaLayouts(manga:MangaSettings, text:string): {
  custom:MangaCustomLayout[]; disabled:string[]; deleted:string[]; order:string[];
  count:number; replaced:number; hidden:number;
} {
  let raw:unknown;
  try { raw=JSON.parse(text.replace(/^\uFEFF/,'')); }
  catch (issue) { throw new Error(`JSON 解析失败：${issue instanceof Error ? issue.message : String(issue)}`); }
  const root=raw && typeof raw==='object' && !Array.isArray(raw) ? raw as Record<string,unknown> : undefined;
  const file=readLayoutFile(raw), entries=file.layouts;
  const order=root?.order===undefined ? undefined : file.order;
  const deletedIds=file.deleted;
  if(!entries.length && !root?.format) throw new Error('需要非空版式数组。');
  const incoming=new Map<string,{layout:MangaCustomLayout; enabled?:boolean}>();
  entries.forEach((entry,index)=>{
    try {
      if (!entry || typeof entry!=='object' || Array.isArray(entry)) throw new Error('版式必须是对象。');
      const state=(entry as {enabled?:unknown}).enabled;
      if (state!==undefined && typeof state!=='boolean') throw new Error('启用状态 enabled 需要布尔值。');
      const layout=parseCustomLayout(JSON.stringify(entry));
      if (incoming.has(layout.id)) throw new Error(`文件中有重复版式 ID「${layout.id}」。`);
      if (deletedIds.includes(layout.id)) throw new Error(`版式「${layout.id}」同时出现在版式和已删除清单中。`);
      incoming.set(layout.id,{layout,...(state!==undefined ? {enabled:state as boolean} : {})});
    } catch (issue) { throw new Error(`第 ${index+1} 套版式：${issue instanceof Error ? issue.message : String(issue)}`); }
  });
  const custom=new Map(manga.custom.map(layout=>[layout.id,layout]));
  const visible=new Set(snapshots(manga).map(layout=>layout.id));
  const disabled=new Set(manga.disabled), deleted=new Set([...manga.deleted,...deletedIds]);
  let replaced=0;
  for (const [id,{layout,enabled}] of incoming) {
    if (visible.has(id) || custom.has(id)) replaced++;
    custom.set(id,layout); deleted.delete(id);
    if (enabled===false) disabled.add(id);
    else if (enabled===true) disabled.delete(id);
  }
  return {custom:[...custom.values()],disabled:[...disabled],deleted:[...deleted],order:order ? [...new Set((order as string[]).map(id=>id.trim())),...(manga.order ?? []).filter(id=>!order.includes(id))] : [...(manga.order ?? [])],
    count:incoming.size,replaced,hidden:deletedIds.filter(id=>visible.has(id)).length};
}
