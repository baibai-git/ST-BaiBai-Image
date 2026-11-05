import { describe, expect, it } from 'vitest';
import { deformCorner, editablePanel, fitRect, panelFromRect, panelRect, quadPoints, saveEditedPanel, setSlotRect, slotRect, snapRect } from './editor';
import { applyMangaFrames, buildMangaSpec, mangaDefaults, normalizeManga, parseCustomLayout, panelLayerGuides } from './layouts';

describe('快捷版式坐标与保存', () => {
  it('框用途保存、重载及归一化后进入 LLM 清单，不直接进入生图 JSON',()=>{
    const canvas={width:1024,height:1024};
    const panel=editablePanel({x:100,y:100,width:600,height:600},canvas);
    panel.slotNotes={F:'建立场景与人物关系',S:'人物半身反应',TL:'左侧人物第一句',REMOVED:'已删除字区'};
    const saved=saveEditedPanel(panel,canvas,'one');
    expect(saved.slotNotes).toEqual({F:'建立场景与人物关系',S:'人物半身反应',TL:'左侧人物第一句'});
    const loaded=editablePanel(panelRect(saved,canvas),canvas,saved);
    loaded.slotNotes!.S='修改后的用途';
    expect(saved.slotNotes!.S).toBe('人物半身反应');
    expect(saveEditedPanel(editablePanel(panelRect(saved,canvas),canvas,saved),canvas,'one')).toEqual(saved);
    const layout=parseCustomLayout(JSON.stringify({id:'purposes',canvas,portrait:[saved]}));
    const settings=normalizeManga({...mangaDefaults(),enabled:true,custom:[layout]});
    expect(settings.custom[0].portrait?.[0].slotNotes).toEqual(saved.slotNotes);
    const spec=buildMangaSpec(settings);
    expect(spec).toContain('框用途 {"F":"建立场景与人物关系","S":"人物半身反应","TL":"左侧人物第一句"}');
    expect(spec).toContain('不把说明当作台词');
    const compiled=applyMangaFrames(JSON.stringify({layout:'purposes',items:[{panel:1,slot:'S',label:'character',caption:'An adult traveler holding a book.'}]}),settings,canvas);
    expect(compiled).not.toContain('人物半身反应');
    expect(compiled).not.toContain('slotNotes');
    const legacy=editablePanel({x:0,y:0,width:100,height:100},canvas);
    expect(saveEditedPanel(legacy,canvas,'old').slotNotes).toBeUndefined();
  });

  it('框用途只保留有效槽位的非空文本，规范化大小写并过滤无效数据',()=>{
    const settings=normalizeManga({...mangaDefaults(),custom:[{id:'notes',portrait:[{position:'one',slots:{F:[-100,-100,100,100],S:[-80,-80,80,80]},slotNotes:{' f ':'  整格用途  ',s:'主体用途',MISSING:'不存在',T:3,blank:''}}]}]});
    expect(settings.custom[0].portrait?.[0].slotNotes).toEqual({F:'整格用途',S:'主体用途'});
  });

  it('层级往返保存，遮挡说明注入提示词且不改变 items 读序',()=>{
    const canvas={width:1024,height:1024};
    const rear=editablePanel({x:100,y:100,width:600,height:600},canvas); rear.layer=1;
    const front=editablePanel({x:400,y:400,width:300,height:300},canvas); front.layer=0;
    const panels=[saveEditedPanel(rear,canvas,'main'),saveEditedPanel(front,canvas,'inset')];
    const layout=parseCustomLayout(JSON.stringify({id:'layers',canvas,portrait:panels}));
    expect(layout.portrait?.map(p=>p.layer)).toEqual([1,0]);
    expect(editablePanel(panelRect(panels[0],canvas),canvas,panels[0]).layer).toBe(1);
    const settings={...mangaDefaults(),enabled:true,custom:[layout]};
    expect(normalizeManga(settings).custom[0].portrait?.map(p=>p.layer)).toEqual([1,0]);
    const output=JSON.parse(applyMangaFrames(JSON.stringify({layout:'layers',items:[{panel:1,slot:'F',caption:'First.'},{panel:2,slot:'F',caption:'Second.'}]}),settings,canvas));
    expect(output.items[0].caption).toContain('First.');
    expect(output.items[1].caption).toContain('Second.');
    expect(output.summary.caption).toContain('panel 1 is in front of panel 2');
    expect(output.items[0].caption).toContain('Content of panel 1:');
    expect(output.items[1].caption).toContain('Content of panel 2:');
    expect(output.items[0].caption).not.toContain('is in front of');
    expect(output.items[0].layer).toBeUndefined();
    expect(buildMangaSpec(settings)).toContain('back to front: panel 2 → panel 1');
    expect(panelLayerGuides([{position:'a',layer:1,slots:{F:[0,0,100,100]}},{position:'b',layer:0,slots:{F:[100,0,200,100]}}])).toEqual([]);
    expect(()=>parseCustomLayout(JSON.stringify({id:'bad',canvas,portrait:[{...panels[0],layer:1.5}]}))).toThrow(/层级/);
  });
  it('角点形变保存四边形，边框缩放保持轮廓比例，生图使用外接框和轮廓参考', () => {
    const canvas = { width:1024,height:1024 };
    const panel = editablePanel({x:100,y:100,width:600,height:600},canvas);
    const corners = quadPoints(panel,'T');
    corners[2][1] += 100;
    expect(deformCorner(panel,'T',corners,canvas)).toBe(true);
    const shaped = saveEditedPanel(panel,canvas,'one');
    expect(shaped.shapes?.T).toHaveLength(4);
    const loaded = editablePanel(panelRect(shaped,canvas),canvas,shaped);
    expect(saveEditedPanel(loaded,canvas,'one')).toEqual(shaped);
    setSlotRect(loaded,'T',{x:100,y:100,width:400,height:200});
    expect(quadPoints(loaded,'T')[0]).toEqual([100,100]);
    const saved=saveEditedPanel(loaded,canvas,'one');
    const settings={...mangaDefaults(),enabled:true,custom:[parseCustomLayout(JSON.stringify({id:'quad',canvas,portrait:[saved]}))]};
    const output=JSON.parse(applyMangaFrames(JSON.stringify({layout:'quad',items:[{panel:1,slot:'T',caption:'A text bubble.'}]}),settings,canvas));
    expect(output.items[0].bbox).toEqual(saved.slots.T);
    expect(output.items[0].caption).toContain('slanted quadrilateral contour');
    expect(output.items[0].caption).toContain('A text bubble.');
    expect(() => parseCustomLayout(JSON.stringify({id:'bad',canvas,portrait:[{...saved,shapes:{T:[[0,0],[10,10],[0,10],[10,0]]}}]}))).toThrow(/角点/);
  });

  it('拒绝角点交叉，不破坏原槽位，外框也能变成凸四边形', () => {
    const canvas={width:1024,height:1024};
    const panel=editablePanel({x:100,y:100,width:600,height:600},canvas);
    const before=JSON.stringify(panel);
    expect(deformCorner(panel,'F',[[100,100],[700,700],[700,100],[100,700]],canvas)).toBe(false);
    expect(JSON.stringify(panel)).toBe(before);
    expect(deformCorner(panel,'F',[[100,100],[700,100],[700,700],[100,500]],canvas)).toBe(true);
    expect(saveEditedPanel(panel,canvas,'one').shapes?.F).toEqual([[-412,-412],[188,-412],[188,188],[-412,-12]]);
  });
  it('单独编辑/删除槽位后随父框移动缩放，保存和重载不会恢复已删槽位', () => {
    const canvas = { width: 1024, height: 1024 };
    const panel = editablePanel({ x: 100, y: 200, width: 600, height: 400 }, canvas);
    setSlotRect(panel, 'T', { x: 140, y: 220, width: 300, height: 80 });
    delete panel.slots.S;
    Object.assign(panel, { x: 200, y: 250, width: 300, height: 600 });
    expect(slotRect(panel,'T')).toEqual({ x: 220, y: 280, width: 150, height: 120 });
    const saved = saveEditedPanel(panel, canvas, 'panel-1');
    expect(saved.slots.T).toEqual([-232,-292,-112,-142]);
    expect(saved.slots.S).toBeUndefined();
    const loaded = editablePanel(panelRect(saved,canvas),canvas,saved);
    expect(loaded.slots.S).toBeUndefined();
    expect(saveEditedPanel(loaded,canvas,'panel-1')).toEqual(saved);
    const settings = { ...mangaDefaults(), enabled:true, custom:[parseCustomLayout(JSON.stringify({id:'slots',canvas,portrait:[saved]}))] };
    const tag = (slot:string) => JSON.stringify({layout:'slots',items:[{panel:1,slot}]});
    expect(JSON.parse(applyMangaFrames(tag('T'),settings,canvas)).items[0].bbox).toEqual(saved.slots.T);
    expect(() => applyMangaFrames(tag('S'),settings,canvas)).toThrow(/没有 S 槽位/);
  });

  it('自定义非默认槽位可保留，删除全部内框仍保留 F，复制不应共享槽位对象', () => {
    const canvas = { width: 1024, height: 1024 };
    const source = { position:'one', slots:{F:[-400,-400,400,400],ML:[-300,-390,0,-200]} };
    const panel = editablePanel(panelRect(source,canvas),canvas,source);
    expect(Object.keys(panel.slots)).toEqual(['ML']);
    const copy = JSON.parse(JSON.stringify(panel));
    delete copy.slots.ML;
    expect(panel.slots.ML).toBeDefined();
    expect(saveEditedPanel(copy,canvas,'one').slots).toEqual({F:source.slots.F});
  });
  it('自定义正方形画布从鼠标框生成槽位，保存/读回后按真实尺寸编译 X', () => {
    const canvas = { width: 1024, height: 1024 };
    const rect = { x: 100, y: 200, width: 600, height: 400 };
    const panel = panelFromRect(rect, canvas, 'panel-1');
    expect(panelRect(panel, canvas)).toEqual(rect);
    const custom = parseCustomLayout(JSON.stringify({ id: 'square', canvas, portrait: [panel] }));
    const settings = normalizeManga({ ...mangaDefaults(), enabled: true, custom: [custom] });
    const tag = JSON.stringify({ layout: 'square', items: [{ panel: 1, slot: 'F' }, { panel: 1, slot: 'X' }] });
    const compiled = JSON.parse(applyMangaFrames(tag, settings, canvas));
    expect(compiled.items[0].bbox).toEqual([-312, -412, 88, 188]);
    expect(compiled.items[1].bbox).toEqual([-402, -502, 178, 278]);
    expect(buildMangaSpec(settings)).toContain('square｜1 格｜画布 1024×1024');
    expect(() => applyMangaFrames(tag, settings, { width: 1088, height: 1920 })).toThrow(/1024×1024/);
  });

  it('任意横画布的槽位均有正面积，越界移动缩放被限制', () => {
    const canvas = { width: 1600, height: 900 };
    const rect = fitRect({ x: -10, y: 899, width: 2400, height: 1 }, canvas);
    expect(rect).toEqual({ x: 0, y: 876, width: 1600, height: 24 });
    const panel = panelFromRect(rect, canvas, 'panel-1');
    const custom = parseCustomLayout(JSON.stringify({ id: 'wide', canvas, landscape: [panel] }));
    expect(custom.canvas).toEqual(canvas);
    expect(Object.keys(panel.slots)).toEqual(['F','C','S','T','B','TL','TR','BL','BR','ML','MR','L','R','O']);
    expect(() => parseCustomLayout(JSON.stringify({ ...custom, canvas: { width: 1599, height: 900 } }))).toThrow(/偶数/);
    expect(() => parseCustomLayout(JSON.stringify({ ...custom, canvas: { width: 900, height: 1600 } }))).toThrow(/方向/);
  });

  it('按邻格边缘吸附，同时保持框内尺寸和最小分格', () => {
    const canvas = { width: 1024, height: 1024 };
    const rect = snapRect({ x: 202, y: 101, width: 200, height: 300 }, canvas, [{ x: 400, y: 100, width: 200, height: 300 }], 6);
    expect(rect.x).toBe(200);
    expect(rect.y).toBe(100);
    expect(rect.width).toBe(200);
    expect(snapRect({ x: 0, y: 0, width: 21, height: 20 }, canvas, [], 6, true).width).toBeGreaterThanOrEqual(24);
  });
});
