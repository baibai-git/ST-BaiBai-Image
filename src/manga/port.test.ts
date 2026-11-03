import { describe, expect, it } from 'vitest';
import { applyMangaFrames, buildMangaSpec, mangaDefaults, normalizeManga, parseCustomLayout, resolveLayout } from './layouts';
import { editablePanel, panelRect, saveEditedPanel } from './editor';

const canvas={width:1024,height:1024};
const panels=[{
  position:'upper',layer:3,
  slots:{F:[-500,-500,-20,500],S:[-480,-400,350,200],S_2:[-470,230,-50,450],O:[-100,0,40,100],TL:[-450,-480,-350,-250],TL_2:[-330,-480,-230,-250]},
  shapes:{F:[[-500,-500],[500,-500],[500,-80],[-500,-20]]},
  slotNotes:{F:'开场',S:'同一人物连续跨格',S_2:'同一人物独立面部展示',O:'该人物的手'},
},{position:'lower',layer:0,slots:{F:[20,-500,500,500]}}];

function setup() {
  const custom=parseCustomLayout(JSON.stringify({id:'node_export',description:'共享画面描述',usage:'旧说明',canvas,panels}));
  const manga={...mangaDefaults(),enabled:true,custom:[custom]};
  return {custom,manga};
}

describe('ComfyUI 漫画能力迁移',()=>{
  it('平铺导入保留几何、层级、编号和描述；保存读回仍为同一坐标',()=>{
    const {custom,manga}=setup();
    expect(custom.usage).toBe('共享画面描述');
    expect(custom.portrait).toEqual(panels);
    const layout=resolveLayout(manga,'portrait','node_export')!;
    const saved=saveEditedPanel(editablePanel(panelRect(layout.panels[0],canvas),canvas,layout.panels[0]),canvas,'upper');
    expect(saved).toEqual(panels[0]);
    expect(normalizeManga(manga).custom[0]).toEqual(custom);
    expect(parseCustomLayout(JSON.stringify(custom))).toEqual(custom);
    const horizontal=parseCustomLayout(JSON.stringify({id:'wide',canvas:{width:1536,height:1024},panels}));
    expect(horizontal.landscape).toEqual(panels);
  });

  it('平铺格式缺少画布、重复方向、非法坐标或斜框都报错',()=>{
    expect(()=>parseCustomLayout(JSON.stringify({id:'x',panels}))).toThrow(/canvas/);
    expect(()=>parseCustomLayout(JSON.stringify({id:'x',canvas,panels,portrait:panels}))).toThrow(/不能同时/);
    expect(()=>parseCustomLayout(JSON.stringify({id:'x',canvas,panels:[{position:'p',slots:{F:[-900,0,10,100]}}]}))).toThrow(/超出画布/);
    expect(()=>parseCustomLayout(JSON.stringify({id:'x',canvas,panels:[{...panels[0],shapes:{F:[[0,0],[100,100],[0,100],[100,0]]}}]}))).toThrow(/四边形/);
  });

  it('实际S跨格按保存坐标编译；局部辅助不丢失，未引用主体不产生出框引导',()=>{
    const {manga}=setup();
    const items=[{panel:1,slot:'S',label:'character',caption:'One continuous traveler.'},{panel:1,slot:'O',label:'object',caption:'The same traveler’s gloved hand.'}];
    const input=JSON.stringify({layout:'node_export',items});
    const output=JSON.parse(applyMangaFrames(input,manga,canvas));
    expect(output.items).toHaveLength(2);
    expect(output.items[0].bbox).toEqual(panels[0].slots.S);
    expect(output.items[1].caption).toContain('same traveler’s gloved hand');
    expect(output.summary.caption).toContain('S is a continuous foreground subject region');
    expect(output.summary.caption).not.toContain('S_2 is a continuous');
    const silent=JSON.parse(applyMangaFrames(JSON.stringify({layout:'node_export',items:[{panel:2,slot:'F',label:'object',caption:'A quiet room.'}]}),manga,canvas));
    expect(silent.summary.caption).not.toContain('continuous foreground');
    expect(JSON.parse(input).items).toEqual(items);
  });

  it('斜框内部外接矩形包含主体，实际轮廓外的部分也识别为跨格',()=>{
    const {manga}=setup();
    manga.custom[0].portrait![0].slots.S=[-200,300,-30,450];
    const out=JSON.parse(applyMangaFrames(JSON.stringify({layout:'node_export',items:[{panel:1,slot:'S',label:'character',caption:'A traveler.'}]}),manga,canvas));
    expect(out.summary.caption).toContain('continuous foreground');
  });

  it('旧X仍用原扩框算法，新清单只列真实槽位并明确辅助框和多尺度身份',()=>{
    const {manga}=setup();
    const out=JSON.parse(applyMangaFrames(JSON.stringify({layout:'node_export',items:[{panel:1,slot:'X',label:'character',caption:'Legacy overlapping character.'}]}),manga,canvas));
    expect(out.items[0].bbox).toEqual([-512,-512,70,512]);
    const spec=buildMangaSpec(manga);
    expect(spec).toContain('复杂姿势');expect(spec).toContain('多尺度');
    const line=spec.split('\n').find(line=>line.startsWith('  1(upper):'))!;
    expect(line).toContain('；槽位 F S S_2 O TL TL_2');
    expect(spec).not.toMatch(/1\(upper\):[^\n]*\bX\b/);
    expect(spec).not.toContain('一格一个主体框');
  });

  it('编号字区保持独立，继承放置含义，只拆分同一个完整键中的多条台词',()=>{
    const {manga}=setup();
    const items=[{panel:1,slot:'TL',label:'text',text:'甲',caption:'First.'},{panel:1,slot:'TL_2',label:'text',text:'乙',caption:'Second.'},{panel:1,slot:'TL_2',label:'text',text:'丙',caption:'Third.'}];
    const out=JSON.parse(applyMangaFrames(JSON.stringify({layout:'node_export',items}),manga,canvas));
    expect(out.items[0].bbox).toEqual(panels[0].slots.TL);
    expect(out.items[1].caption).toContain('upper-left text region');
    expect(out.items[1].bbox[2]).toBeLessThan(out.items[2].bbox[0]);
    expect(out.items.map((item:any)=>item.text)).toEqual(['甲','乙','丙']);
    expect(()=>applyMangaFrames(JSON.stringify({layout:'node_export',items:[{...items[0],slot:'TL_3'}]}),manga,canvas)).toThrow(/没有 TL_3/);
  });
});
