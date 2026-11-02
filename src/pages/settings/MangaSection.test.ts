import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, ssrContextKey } from 'vue';
import { applyMangaFrames, mangaDefaults, normalizeManga, parseCustomLayout, resolveLayouts } from '@/manga/layouts';
vi.mock('@/pages/settings/MangaLayoutEditor.vue', () => ({ default: {} }));
vi.mock('@/state/settings', async () => {
  const { reactive } = await import('vue');
  const { mangaDefaults } = await import('@/manga/layouts');
  return { settings: reactive({ manga: mangaDefaults() }) };
});
import { settings } from '@/state/settings';
import Section from './MangaSection.vue';

function section() {
  let state: any;
  const renderer = createRenderer<any, any>({
    createElement:()=>({}), createText:()=>({}), createComment:()=>({}),
    setText:()=>{}, setElementText:()=>{}, patchProp:()=>{}, insert:()=>{}, remove:()=>{},
    parentNode:()=>null, nextSibling:()=>null,
  });
  const app = renderer.createApp(defineComponent({ setup() {
    state = (Section as any).setup({}, { expose:()=>{} });
    return ()=>null;
  } }));
  app.provide(ssrContextKey, {}); app.mount({});
  return { state, close:()=>app.unmount() };
}

describe('可视化编辑保存',()=>{
  beforeEach(()=>{ settings.manga=mangaDefaults(); });
  it('修改自定义 ID 原地改名，保留另一方向与停用状态',()=>{
    const portrait=[{position:'old',slots:{F:[-900,-500,900,500]}}];
    const landscape=[{position:'wide',slots:{F:[-500,-900,500,900]}}];
    settings.manga.custom=[{id:'original',usage:'保持用途',portrait,landscape}];
    settings.manga.disabled=['original'];
    const {state,close}=section();
    state.openQuick('original');
    state.saveQuick({id:'renamed',canvas:{width:1088,height:1920},portrait:[{position:'edited',slots:{F:[-800,-400,800,400]}}]});
    expect(settings.manga.custom.map(item=>item.id)).toEqual(['renamed']);
    expect(settings.manga.custom[0].landscape).toEqual(landscape);
    expect(settings.manga.custom[0].usage).toBe('保持用途');
    expect(settings.manga.disabled).toEqual(['renamed']);
    expect(state.quickOpen.value).toBe(false);
    expect(state.note.value).toContain('改名');
    close();
  });
  it('默认版式改名后隐藏旧 ID，保留另一方向，不把旧默认版式重新显示',()=>{
    const {state,close}=section();
    const count=state.rows.value.length;
    const other=resolveLayouts(settings.manga,'landscape').find(item=>item.id==='balanced_1')!.panels;
    state.openQuick('balanced_1');
    state.saveQuick({id:'renamed_builtin',canvas:{width:1088,height:1920},portrait:[{position:'edited',slots:{F:[-800,-400,800,400]}}]});
    expect(state.rows.value).toHaveLength(count);
    expect(state.rows.value.some((row:any)=>row.id==='balanced_1')).toBe(false);
    expect(settings.manga.deleted).toContain('balanced_1');
    expect(resolveLayouts(settings.manga,'landscape').find(item=>item.id==='renamed_builtin')?.panels).toEqual(other);
    close();
  });
  it('改为已存在的 ID 时保留原数据并报告冲突',()=>{
    settings.manga.custom=['original','occupied'].map(id=>({id,portrait:[{position:id,slots:{F:[-900,-500,900,500]}}]}));
    const before=JSON.stringify(settings.manga);
    const {state,close}=section();
    state.openQuick('original');
    state.saveQuick({id:'occupied',portrait:[{position:'new',slots:{F:[-800,-400,800,400]}}]});
    expect(JSON.stringify(settings.manga)).toBe(before);
    expect(state.quickOpen.value).toBe(true);
    expect(state.error.value).toContain('已存在');
    close();
  });
  it('JSON 编辑同样按原 ID 改名，不新增副本或覆盖同名版式',()=>{
    settings.manga.custom=['original','occupied'].map(id=>({id,portrait:[{position:id,slots:{F:[-900,-500,900,500]}}]}));
    settings.manga.disabled=['original'];
    const {state,close}=section();
    state.editing.value='original';
    const body={...settings.manga.custom[0],id:'occupied'};
    state.draft.value=JSON.stringify(body); state.save();
    expect(settings.manga.custom.map(item=>item.id)).toEqual(['original','occupied']);
    expect(state.error.value).toContain('已存在');
    state.draft.value=JSON.stringify({...body,id:'renamed'}); state.save();
    expect(settings.manga.custom.map(item=>item.id)).toEqual(['renamed','occupied']);
    expect(settings.manga.disabled).toEqual(['renamed']);
    expect(state.editing.value).toBe('');
    close();
  });
  it('更新同 ID 自定义版式并保留另一个方向，不新增副本',()=>{
    const portrait=[{position:'old',slots:{F:[-900,-500,900,500]}}];
    const landscape=[{position:'wide',slots:{F:[-500,-900,500,900]}}];
    settings.manga.custom=[{id:'mine',portrait,landscape}];
    const {state,close}=section();
    state.openQuick('mine');
    state.saveQuick({id:'mine',label:'修改后',canvas:{width:1088,height:1920},portrait:[{position:'new',slots:{F:[-800,-400,800,400],R:[-700,0,700,350]}}]});
    expect(settings.manga.custom).toHaveLength(1);
    expect(settings.manga.custom[0].portrait?.[0].position).toBe('new');
    expect(settings.manga.custom[0].landscape).toEqual(landscape);
    expect(settings.manga.custom[0].canvas).toBeUndefined();
    expect(state.quickOpen.value).toBe(false);
    close();
  });
  it('编辑默认版式时创建同 ID 覆盖，保留其横版',()=>{
    const {state,close}=section();
    state.openQuick('balanced_1');
    state.saveQuick({id:'balanced_1',canvas:{width:1088,height:1920},portrait:[{position:'edited',slots:{F:[-800,-400,800,400]}}]});
    expect(settings.manga.custom[0].id).toBe('balanced_1');
    expect(resolveLayouts(settings.manga,'landscape').find(item=>item.id==='balanced_1')?.panels).toHaveLength(1);
    close();
  });
  it('批量缩放启用和停用版式，保留跨格内框、形变、用途、层级和删除记录',()=>{
    const deleted={id:'balanced_2',usage:'已删除项的用途'};
    const orphan={id:'legacy_note',usage:'仅存说明'};
    settings.manga.deleted=['balanced_2'];
    settings.manga.disabled=['mine','balanced_1'];
    settings.manga.custom=[deleted,orphan,{id:'mine',label:'跨格',readingOrder:'先上后下',canvas:{width:1024,height:2048},portrait:[
      {position:'opening',layer:2,slots:{F:[-1024,-512,0,512],S:[-600,-400,800,400]},shapes:{S:[[-400,-600],[400,-580],[390,800],[-390,790]]},slotNotes:{F:'开场',S:'跨格主体'}},
      {position:'ending',layer:0,slots:{F:[0,-512,1024,512]}},
    ]}];
    const before=JSON.parse(JSON.stringify(settings.manga));
    const {state,close}=section(); state.resizeAllCanvases();
    expect(state.batchError.value).toBe('');
    expect(settings.manga.disabled).toEqual(before.disabled);
    expect(settings.manga.deleted).toEqual(before.deleted);
    expect(settings.manga.custom.find(entry=>entry.id==='balanced_2')).toEqual(deleted);
    expect(settings.manga.custom.find(entry=>entry.id==='legacy_note')).toEqual(orphan);
    for(const orientation of ['portrait','landscape'] as const){
      const layouts=resolveLayouts({...settings.manga,disabled:[]},orientation);
      expect(layouts.some(entry=>entry.id==='balanced_2')).toBe(false);
      expect(layouts.every(entry=>entry.canvas.width===(orientation==='portrait'?1664:2496) && entry.canvas.height===(orientation==='portrait'?2496:1664))).toBe(true);
    }
    const mine=settings.manga.custom.find(entry=>entry.id==='mine')!;
    expect(mine.portrait?.map(panel=>[panel.position,panel.layer])).toEqual([['opening',2],['ending',0]]);
    expect(mine.portrait?.[0].slots.S).toEqual([-731,-650,975,650]);
    expect(mine.portrait?.[0].shapes?.S).toEqual([[-650,-731],[650,-707],[634,975],[-634,963]]);
    expect(mine.portrait?.[0].slotNotes).toEqual({F:'开场',S:'跨格主体'});
    expect(parseCustomLayout(JSON.stringify(mine))).toEqual(mine);
    const compiled=JSON.parse(applyMangaFrames(JSON.stringify({summary:{caption:'A color comic.'},layout:'mine',items:[{panel:1,slot:'S',label:'character',caption:'A traveler.'}]}),{...settings.manga,enabled:true,disabled:[]},{width:1664,height:2496}));
    expect(compiled.items[0].bbox).toEqual(mine.portrait?.[0].slots.S);
    expect(normalizeManga(JSON.parse(JSON.stringify(settings.manga)))).toEqual(settings.manga);
    state.undoResize();
    expect(settings.manga).toEqual(before);
    close();
  });
  it('宽高输入自动匹配横竖方向，连续调整按当前坐标缩放，方形可用于两个方向',()=>{
    const {state,close}=section();
    state.batchWidth.value=2496;state.batchHeight.value=1664;state.resizeAllCanvases();
    expect(state.batchError.value).toBe('');
    state.batchWidth.value=1088;state.batchHeight.value=1920;state.resizeAllCanvases();
    expect(state.batchError.value).toBe('');
    expect(resolveLayouts(settings.manga,'landscape').every(layout=>layout.canvas.width===1920 && layout.canvas.height===1088)).toBe(true);
    state.batchWidth.value=1024;state.batchHeight.value=1024;state.resizeAllCanvases();
    expect(state.batchError.value).toBe('');
    expect(resolveLayouts(settings.manga,'landscape').every(layout=>layout.canvas.width===1024 && layout.canvas.height===1024)).toBe(true);
    close();
  });
  it('无效尺寸整体保持原设置；后续编辑使批量撤销失效',()=>{
    const {state,close}=section();
    const original=JSON.stringify(settings.manga);
    state.batchWidth.value=1663;state.resizeAllCanvases();
    expect(state.batchError.value).toContain('偶数');
    expect(JSON.stringify(settings.manga)).toBe(original);
    state.batchWidth.value=1664;state.resizeAllCanvases();
    expect(state.canUndoResize.value).toBe(true);
    settings.manga.custom[0].usage='随后编辑的说明';
    const edited=JSON.stringify(settings.manga);
    expect(state.canUndoResize.value).toBe(false);
    state.undoResize();
    expect(JSON.stringify(settings.manga)).toBe(edited);
    close();
  });
  it('批量调整后单独编辑横版尺寸，配套竖版坐标同步缩放并能保存解析',()=>{
    const {state,close}=section();state.resizeAllCanvases();
    const previous=resolveLayouts(settings.manga,'portrait').find(layout=>layout.id==='balanced_1')!;
    state.openQuick('balanced_1');
    state.saveQuick({id:'balanced_1',canvas:{width:1920,height:1088},landscape:[{position:'wide',slots:{F:[-544,-960,544,960]}}]});
    const saved=settings.manga.custom.find(entry=>entry.id==='balanced_1')!;
    expect(parseCustomLayout(JSON.stringify(saved))).toEqual(saved);
    expect(resolveLayouts(settings.manga,'portrait').find(layout=>layout.id==='balanced_1')?.canvas).toEqual({width:1088,height:1920});
    expect(saved.portrait?.[0].slots.F).toEqual(previous.panels[0].slots.F.map((n,index)=>Math.round(n*(index%2?1088/1664:1920/2496))));
    close();
  });
});
