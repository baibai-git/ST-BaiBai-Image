/** Portable file protocol shared by BaiBai and the standalone ComfyUI node. */
export const LAYOUT_FORMAT = 'moss-manga-layouts';
export const LEGACY_LAYOUT_FORMAT = 'bbi-manga-layouts';
export const LAYOUT_VERSION = 1;
export type LayoutRecord = Record<string, any>;

export function readLayoutFile(value: unknown): {layouts:LayoutRecord[]; deleted:string[]; order:string[]} {
  const root=value && typeof value==='object' && !Array.isArray(value) ? value as LayoutRecord : undefined;
  if(root?.format!==undefined && ![LAYOUT_FORMAT,LEGACY_LAYOUT_FORMAT].includes(root.format)) throw new Error('不支持的版式文件格式。');
  if(root?.format!==undefined && root.version!==LAYOUT_VERSION) throw new Error('不支持的版式文件版本，请更新插件。');
  const layouts=Array.isArray(value) ? value : root?.layouts!==undefined ? root.layouts : [value];
  if(!Array.isArray(layouts)) throw new Error('需要版式对象或版式数组。');
  if(layouts.some(entry=>!entry || typeof entry!=='object' || Array.isArray(entry))) throw new Error('版式必须是对象。');
  const list=(key:string)=>{
    const ids=root?.[key]===undefined ? [] : root[key];
    if(!Array.isArray(ids) || ids.some(id=>typeof id!=='string' || !id.trim())) throw new Error(`${key==='order'?'版式顺序':key} 需要非空 ID 字符串数组。`);
    return [...new Set(ids.map(id=>id.trim()))] as string[];
  };
  return {layouts,deleted:list('deleted'),order:list('order')};
}

// JSON object key order is not geometry; panel arrays still retain reading order.
function comparable(value:any):any {
  if(Array.isArray(value))return value.map(comparable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,comparable(value[key])]));
  return value;
}
/** Keep both legacy orientations and distinct prose fields; do not renumber panels or slots. */
export function portableLayout(value: LayoutRecord): LayoutRecord {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('版式必须是对象。');
  const result={...value};
  const supplied=result.canvas;
  const direction=supplied ? (supplied.width>supplied.height ? 'landscape' : 'portrait') : result.portrait ? 'portrait' : 'landscape';
  const canvas=supplied ?? (direction==='portrait' ? {width:1088,height:1920} : {width:1920,height:1088});
  const panels=result.panels ?? result[direction];
  if(!canvas || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)) throw new Error('版式需要有效画布。');
  if(!Array.isArray(panels) || !panels.length) throw new Error('版式缺少分格。');
  if(result.panels && result[direction] && JSON.stringify(comparable(result.panels))!==JSON.stringify(comparable(result[direction]))) throw new Error('panels 与同方向分格不一致，请明确保留哪一份。');
  return {...result,canvas:{...canvas},panels};
}

export function directionalLayout(value: LayoutRecord): LayoutRecord {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('版式必须是对象。');
  if(value.panels===undefined) return {...value};
  if(!value.canvas) throw new Error('panels 格式需要 canvas.width 与 canvas.height。');
  const result=portableLayout(value), direction=result.canvas.width>result.canvas.height ? 'landscape' : 'portrait';
  result[direction]=result.panels;delete result.panels;
  return result;
}

export function writeLayoutFile(layouts: LayoutRecord[], options:{deleted?:string[];order?:string[];legacy?:boolean}={}): string {
  return JSON.stringify({format:options.legacy ? LEGACY_LAYOUT_FORMAT : LAYOUT_FORMAT,version:LAYOUT_VERSION,
    layouts:options.legacy ? layouts.map(directionalLayout) : layouts.map(portableLayout),deleted:options.deleted ?? [],order:options.order ?? layouts.map(item=>item.id)},null,2);
}
