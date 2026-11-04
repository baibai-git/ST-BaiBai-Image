import { describe, expect, it } from 'vitest';
import { exportMangaLayouts, importMangaLayouts } from './library';
import { applyMangaFrames, mangaDefaults, normalizeManga, parseCustomLayout, resolveLayouts, type MangaSettings } from './layouts';

function source():MangaSettings {
  return {...mangaDefaults(),enabled:true,disabled:['mine','balanced_1'],deleted:['balanced_2'],spec:'PRIVATE_SPEC',thinking:'PRIVATE_CHECK',selectionNotes:'PRIVATE_NOTES',custom:[
    {id:'mine',label:'斜框与跨格',usage:'手部与场景',readingOrder:'先上后下',canvas:{width:1024,height:1536},portrait:[
      {position:'opening',layer:2,slots:{F:[-768,-512,-10,512],S:[-700,-480,700,400],S_2:[-600,-400,-100,100]},shapes:{F:[[-512,-768],[512,-768],[512,-80],[-512,-10]]},slotNotes:{F:'开场',S:'同一个人物跨格',S_2:'局部'}},
      {position:'ending',layer:0,slots:{F:[10,-512,768,512]}},
    ]},
    {id:'wide',canvas:{width:1536,height:1024},landscape:[{position:'one',slots:{F:[-512,-768,512,768]}}]},
    {id:'balanced_1',usage:'用户修改的默认版式用途'},
  ]};
}
function effective(manga:MangaSettings) {
  return {portrait:resolveLayouts({...manga,disabled:[]},'portrait'),landscape:resolveLayouts({...manga,disabled:[]},'landscape')};
}

describe('layout file transfer',()=>{
  it('round-trips the actual visible library, disabled entries and deleted defaults without private rules',()=>{
    const original=source(), before=JSON.stringify(original), text=exportMangaLayouts(original);
    expect(text).not.toContain('PRIVATE_');
    const file=JSON.parse(text);
    expect(file.layouts.find((entry:any)=>entry.id==='mine').enabled).toBe(false);
    expect(file.layouts.some((entry:any)=>entry.id==='balanced_2')).toBe(false);
    expect(file.deleted).toEqual(['balanced_2']);
    const result=importMangaLayouts(mangaDefaults(),text);
    const restored=normalizeManga({...mangaDefaults(),...result});
    expect(effective(restored)).toEqual(effective(original));
    expect([...restored.disabled].sort()).toEqual([...original.disabled].sort());
    expect(restored.deleted).toEqual(original.deleted);
    expect(JSON.stringify(original)).toBe(before);
    expect(result.count).toBe(file.layouts.length);
  });
  it('exports an independent single layout with full geometry and imports it back for compilation',()=>{
    const original=source(), text=exportMangaLayouts(original,'mine'), file=JSON.parse(text);
    expect(file.canvas).toEqual({width:1024,height:1536});
    expect(file.portrait).toEqual(original.custom[0].portrait);
    expect(file.enabled).toBe(false);
    expect(parseCustomLayout(text)).toEqual(original.custom[0]);
    const imported={...mangaDefaults(),...importMangaLayouts(mangaDefaults(),text),enabled:true,disabled:[]};
    const input=JSON.stringify({layout:'mine',items:[{panel:1,slot:'S_2',label:'object',caption:'A gloved hand.'}]});
    expect(JSON.parse(applyMangaFrames(input,imported,file.canvas)).items[0].bbox).toEqual(file.portrait[0].slots.S_2);
    expect(()=>exportMangaLayouts(original,'balanced_2')).toThrow(/不存在/);
    const builtin=JSON.parse(exportMangaLayouts(original,'balanced_1'));
    expect(builtin.portrait.length).toBeGreaterThan(0); expect(builtin.landscape.length).toBeGreaterThan(0);
    expect(builtin.usage).toBe('用户修改的默认版式用途');
  });
  it('merges same IDs atomically, preserves unrelated settings and respects explicit or absent enable flags',()=>{
    const original=source(), before=JSON.stringify(original);
    const replacement={id:'mine',portrait:[{position:'new',slots:{F:[-500,-500,500,500]}}]};
    let result=importMangaLayouts(original,JSON.stringify(replacement));
    expect(result.replaced).toBe(1); expect(result.disabled).toContain('mine');
    expect(result.custom.find(item=>item.id==='wide')).toEqual(original.custom[1]);
    result=importMangaLayouts(original,JSON.stringify({...replacement,enabled:true}));
    expect(result.disabled).not.toContain('mine'); expect(result.disabled).toContain('balanced_1');
    const deleted={...replacement,id:'balanced_2'};
    expect(importMangaLayouts(original,JSON.stringify(deleted)).deleted).not.toContain('balanced_2');
    expect(JSON.stringify(original)).toBe(before);
  });
  it('accepts raw arrays, flat ComfyUI entries and UTF-8 BOM; keeps numbered regions and shapes',()=>{
    const flat={id:'flat',description:'统一说明',canvas:{width:1024,height:1536},panels:source().custom[0].portrait};
    const result=importMangaLayouts(mangaDefaults(),'\uFEFF'+JSON.stringify({layouts:[flat]}));
    expect(result.custom[0].usage).toBe('统一说明');
    expect(result.custom[0].portrait).toEqual(flat.panels);
    expect(importMangaLayouts(mangaDefaults(),JSON.stringify([flat])).count).toBe(1);
  });
  it('rejects a damaged batch, duplicate IDs, invalid flags or future versions without applying any entries',()=>{
    const manga=source(), before=JSON.stringify(manga), good=JSON.parse(exportMangaLayouts(manga,'mine'));
    for (const raw of [null,{},[],{layouts:[good,{id:'broken'}]},{layouts:[good,good]}, {...good,enabled:'false'},
      {format:'bbi-manga-layouts',version:2,layouts:[good]}, {format:'unknown',layouts:[good]},
      {format:'bbi-manga-layouts',version:1,layouts:[good],deleted:['mine']},
      {format:'bbi-manga-layouts',version:1,layouts:[good],deleted:[null]},
    ]) expect(()=>importMangaLayouts(manga,JSON.stringify(raw))).toThrow();
    expect(()=>importMangaLayouts(manga,'{"layouts":[')).toThrow(/JSON/);
    expect(JSON.stringify(manga)).toBe(before);
  });
  it('allows a truly empty exported library and preserves deletion flags when restored',()=>{
    const manga={...mangaDefaults(),deleted:resolveLayouts(mangaDefaults(),'portrait').map(item=>item.id)};
    const text=exportMangaLayouts(manga), result=importMangaLayouts(mangaDefaults(),text);
    expect(JSON.parse(text).layouts).toEqual([]);
    expect(effective({...mangaDefaults(),...result})).toEqual({portrait:[],landscape:[]});
  });
});
