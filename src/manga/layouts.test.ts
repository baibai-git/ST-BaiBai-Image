import { describe, expect, it } from 'vitest';
import overlapCases from './frame-overlap-cases.json';
import {
  applyMangaFrames,
  buildMangaSpec,
  mangaDefaults,
  normalizeManga,
  panelLayerGuides,
  parseCustomLayout,
  resolveLayouts,
  type MangaSettings,
  type MangaPanel,
} from '@/manga/layouts';

const PORTRAIT = { width: 1088, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1088 };

function settingsWith(patch: Partial<MangaSettings> = {}): MangaSettings {
  return { ...mangaDefaults(), enabled: true, ...patch };
}

describe('applyMangaFrames', () => {
  it('实际四边形判断遮挡，边界接触与斜框外接矩形误交叠不生成关系',()=>{
    for (const sample of overlapCases) {
      const panels=sample.panels.map((panel,i)=>({...panel,position:`panel-${i+1}`,layer:i})) as MangaPanel[];
      const expected=sample.overlap ? ['panel 2 is in front of panel 1'] : [];
      const before=JSON.stringify(panels);
      expect(panelLayerGuides(panels),sample.name).toEqual(expected);
      expect(panelLayerGuides(panels,panels[0]),sample.name).toEqual(expected);
      expect(panelLayerGuides(panels,panels[1]),sample.name).toEqual(expected);
      expect(panelLayerGuides(panels,{position:'other',slots:{}}),sample.name).toEqual([]);
      expect(JSON.stringify(panels)).toBe(before);
    }
  });

  it('BL/BR 使用独立坐标，不再共同回落到 B，没有字区时拒绝',()=>{
    for (const slot of ['BL','BR']) {
      const manga=settingsWith();
      const layout=resolveLayouts(manga,'portrait').find(l=>l.id==='main_then_strip')!;
      const out=JSON.parse(applyMangaFrames(JSON.stringify({layout:'main_then_strip',items:[{panel:'panel-2',slot,caption:'Dialogue.'}]}),manga,PORTRAIT));
      expect(out.items[0].bbox).toEqual(layout.panels[1].slots[slot]);
      expect(out.items[0].bbox).not.toEqual(layout.panels[1].slots.B);
      expect(layout.panels[1].slots.BL[3]).toBeLessThan(layout.panels[1].slots.BR[1]);
      expect(out.items[0].caption).toContain('Dialogue.');
    }
    const manga=settingsWith({custom:[{id:'no_bottom',portrait:[{position:'single',slots:{F:[-900,-500,900,500],T:[-800,-400,-700,400]}}]}]});
    expect(()=>applyMangaFrames(JSON.stringify({layout:'no_bottom',items:[{panel:1,slot:'BL'}]}),manga,PORTRAIT)).toThrow(/没有 BL 槽位/);
  });
  it('同侧多泡划分独立上下框，不为沉默的另一侧添加文字或改变原文',()=>{
    const manga=settingsWith();
    const input={layout:'balanced_1',items:[
      {panel:1,slot:'R',label:'character',caption:'A listener on the right.'},
      {panel:1,slot:'TL',label:'text',text:'第一句。',caption:'Spoken by the person on the left.'},
      {panel:1,slot:'TL',label:'text',text:'第二句。',caption:'Spoken by the same person on the left.'},
      {panel:1,slot:'BL',label:'text',text:'第三句。',caption:'Spoken by the same person on the left.'},
    ]};
    const original=JSON.stringify(input);
    const out=JSON.parse(applyMangaFrames(original,manga,PORTRAIT));
    expect(out.items).toHaveLength(4);
    expect(out.items.filter((i:any)=>i.label==='text').map((i:any)=>i.text)).toEqual(['第一句。','第二句。','第三句。']);
    expect(out.items[1].bbox[2]).toBeLessThan(out.items[2].bbox[0]);
    expect(out.items.slice(1).every((i:any)=>i.bbox[3]<0)).toBe(true);
    expect(out.items[1].caption).toContain('upper-left text region');
    expect(out.items[3].caption).toContain('lower-left text region');
    expect(out.summary.caption).toContain('supplied text items');
    expect(out.summary.caption).toContain('keeping faces');
    expect(JSON.stringify(input)).toBe(original);
  });
  it('纯画面输入保留字区几何但编译结果省略文字与气泡引导',()=>{
    const manga=settingsWith();
    const input={layout:'balanced_1',summary:{caption:'A color comic showing a quiet room.'},items:[
      {panel:1,slot:'C',label:'object',caption:'A wooden table beside a window.'},
      {panel:1,slot:'S',label:'character',caption:'An adult traveler reading a book.'},
    ]};
    const before=JSON.stringify(manga);
    const out=JSON.parse(applyMangaFrames(JSON.stringify(input),manga,PORTRAIT));
    expect(out.items).toHaveLength(2);
    expect(out.items.some((item:any)=>item.label==='text')).toBe(false);
    expect(out.summary.caption).not.toMatch(/speech bubbles?|supplied dialogue|silent people|supplied text items|text placement/i);
    expect(out.summary.caption).toContain('exactly 1 distinct comic panels');
    expect(JSON.stringify(manga)).toBe(before);
  });
  it('仅拟声输入保留原字样和字区，采用通用文字引导而非对白气泡引导',()=>{
    const input={layout:'balanced_1',summary:{caption:'A color comic.',meta:['handwritten_speech_bubble_94255']},items:[
      {panel:1,slot:'C',label:'object',caption:'Two coins landing on a table.'},
      {panel:1,slot:'O',label:'text',text:'チャリン',caption:'Japanese handwritten sound effect beside the coins.'},
    ]};
    const out=JSON.parse(applyMangaFrames(JSON.stringify(input),settingsWith(),PORTRAIT));
    expect(out.items[1].text).toBe('チャリン');
    expect(out.items[1].bbox).toHaveLength(4);
    expect(out.summary.meta).toEqual(input.summary.meta);
    expect(out.summary.caption).toContain('supplied text items');
    expect(out.summary.caption).not.toMatch(/speech bubbles?|supplied dialogue|silent people/i);
  });
  it('重复非矩形字区与无法划分的极窄字区明确报错，不生成重叠或无效框',()=>{
    const item={panel:1,slot:'T',label:'text',text:'一句话。',caption:'Dialogue.'};
    const tag=JSON.stringify({layout:'one',items:[item,item]});
    const panel={position:'p',slots:{F:[-400,-400,400,400],T:[-400,-400,-200,400]},shapes:{T:[[-400,-400],[400,-400],[400,-200],[-400,-200]]}};
    expect(()=>applyMangaFrames(tag,settingsWith({custom:[{id:'one',portrait:[panel]}]}),PORTRAIT)).toThrow(/非矩形字区/);
    expect(()=>applyMangaFrames(tag,settingsWith({custom:[{id:'one',portrait:[{position:'p',slots:{T:[0,0,1,10]}}]}]}),PORTRAIT)).toThrow(/容量不足/);
  });
  it('删除 T 后只使用现有顶部字区，避开明确引用的槽位，不重建已删除区域',()=>{
    const panel={position:'p',slots:{F:[-900,-500,900,500],TL:[-800,-400,-600,-50],TR:[-800,50,-600,400]}};
    const manga=settingsWith({custom:[{id:'without_t',portrait:[panel]}]});
    const tag=JSON.stringify({layout:'without_t',items:[{panel:1,slot:'T',caption:'A.'},{panel:1,slot:'TL',caption:'B.'}]});
    const output=JSON.parse(applyMangaFrames(tag,manga,PORTRAIT));
    expect(output.items[0].bbox).toEqual(panel.slots.TR);
    expect(output.items[1].bbox).toEqual(panel.slots.TL);
    expect(manga.custom[0].portrait?.[0].slots.T).toBeUndefined();
    const noText=settingsWith({custom:[{id:'without_t',portrait:[{position:'p',slots:{F:panel.slots.F}}]}]});
    expect(()=>applyMangaFrames(tag,noText,PORTRAIT)).toThrow(/没有 T 槽位/);
    expect(buildMangaSpec(manga)).toContain('删除的槽位不可使用');
  });
  it('兼容旧编辑器的顺序格名与内置名称，同时优先采用实际名称',()=>{
    const builtin=resolveLayouts(settingsWith(),'portrait').find(layout=>layout.id==='two_then_large')!;
    const panels=builtin.panels.map((panel,i)=>({...panel,position:`panel-${i+1}`}));
    const settings=settingsWith({custom:[{id:'two_then_large',portrait:panels}]});
    const compile=(panel:string,manga=settings)=>JSON.parse(applyMangaFrames(JSON.stringify({layout:'two_then_large',items:[{panel,slot:'F'}]}),manga,PORTRAIT));
    expect(compile('top-left').items[0].bbox).toEqual(panels[0].slots.F);
    expect(compile('top-right').items[0].bbox).toEqual(panels[1].slots.F);
    expect(compile('bottom-main').items[0].bbox).toEqual(panels[2].slots.F);
    expect(compile('panel-2',settingsWith()).items[0].bbox).toEqual(builtin.panels[1].slots.F);
    expect(()=>compile('unknown')).toThrow(/可用 1=panel-1/);
    expect(()=>compile('top-left',settingsWith({custom:[{id:'two_then_large',portrait:panels.slice(0,2)}]}))).toThrow(/没有第/);
  });
  it('拒绝尺寸不匹配及遗漏槽位，补全原生坐标声明', () => {
    const tag = JSON.stringify({ layout: 'balanced_1', items: [{ panel: 1, slot: 'C' }] });
    expect(() => applyMangaFrames(tag, settingsWith(), { width: 1080, height: 1920 })).toThrow(/画布/);
    expect(() => applyMangaFrames(tag, settingsWith(), null)).toThrow(/画布/);
    expect(() => applyMangaFrames(JSON.stringify({ layout: 'balanced_1', items: [{ panel: 1 }] }), settingsWith(), PORTRAIT)).toThrow(/槽位/);
    expect(JSON.parse(applyMangaFrames(tag, settingsWith(), PORTRAIT))).toMatchObject({
      bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
    });
  });

  it('自定义面板没有 F 时，X 提供明确错误而不是解构异常', () => {
    const custom = parseCustomLayout(JSON.stringify({ id: 'text_only', portrait: [{ position: 'single', slots: { T: [-10, -10, 10, 10] } }] }));
    expect(() => applyMangaFrames(JSON.stringify({ layout: 'text_only', items: [{ panel: 1, slot: 'X' }] }), settingsWith({ custom: [custom] }), PORTRAIT)).toThrow(/没有 X 槽位/);
  });
  it('漫画模式关闭时原样返回,即使是符号框', () => {
    const tag = JSON.stringify({ layout: 'balanced_1', items: [{ label: 'text', panel: 1, slot: 'T', text: 'x' }] });
    expect(applyMangaFrames(tag, mangaDefaults(), PORTRAIT)).toBe(tag);
  });

  it('把 panel/slot 换成内置整数框,并删掉符号键', () => {
    const tag = JSON.stringify({
      summary: { canvas: 'single', caption: 'page' },
      layout: 'balanced_1',
      items: [{ label: 'text', panel: 1, slot: 'T', text: '……你来了。', caption: 'bubble at top' }],
    });
    const out = JSON.parse(applyMangaFrames(tag, settingsWith(), PORTRAIT));
    expect(out.layout).toBeUndefined();
    expect(out.items[0].panel).toBeUndefined();
    expect(out.items[0].slot).toBeUndefined();
    expect(out.items[0].bbox).toEqual([-906, -486, -555, 486]);
    expect(out.items[0].text).toBe('……你来了。');
    expect(out.summary.canvas).toBe('single');
  });

  it('横竖两套画布取不同坐标表', () => {
    const tag = JSON.stringify({ layout: 'balanced_1', items: [{ label: 'character', panel: 1, slot: 'F' }] });
    const portrait = JSON.parse(applyMangaFrames(tag, settingsWith(), PORTRAIT));
    const landscape = JSON.parse(applyMangaFrames(tag, settingsWith(), LANDSCAPE));
    expect(portrait.items[0].bbox).toEqual([-924, -504, 924, 504]);
    expect(landscape.items[0].bbox).toEqual([-504, -924, 504, 924]);
  });

  it('按位置代号定位格,不必记格号', () => {
    const tag = JSON.stringify({ layout: 'balanced_2', items: [{ label: 'object', panel: 'bottom', slot: 'F' }] });
    const out = JSON.parse(applyMangaFrames(tag, settingsWith(), PORTRAIT));
    expect(out.items[0].bbox).toEqual([12, -504, 924, 504]);
  });

  it('该格没有这个槽位时抛错,而不是把符号框发去出图', () => {
    const tag = JSON.stringify({ layout: 'main_inset_then_two', items: [{ label: 'object', panel: 1, slot: 'E' }] });
    expect(() => applyMangaFrames(tag, settingsWith(), PORTRAIT)).toThrow(/没有 E 槽位/);
  });

  it('版式不存在或被停用时抛错', () => {
    const tag = JSON.stringify({ layout: 'balanced_1', items: [] });
    expect(() => applyMangaFrames(tag, settingsWith({ disabled: ['balanced_1'] }), PORTRAIT)).toThrow(/不存在或已停用/);
    expect(() => applyMangaFrames(JSON.stringify({ layout: 'nope', items: [] }), settingsWith(), PORTRAIT)).toThrow(/nope/);
  });

  it('X 槽按格数分档现算，并裁到画布内', () => {
    const tag = JSON.stringify({ layout: 'main_then_two', items: [{ label: 'character', panel: 2, slot: 'X' }] });
    // main_then_two 是 3 格 → 基准 72；bottom-left F=[204,-504,924,-12] 外扩后裁到 ±544/±960
    const out = JSON.parse(applyMangaFrames(tag, settingsWith(), PORTRAIT));
    expect(out.items[0].bbox).toEqual([132, -544, 960, 60]);
    expect(out.summary.caption).toContain('explicitly described border overlaps may extend outside');
    const wide = JSON.parse(applyMangaFrames(tag, settingsWith({ bleed: 100 }), PORTRAIT));
    expect(wide.items[0].bbox).toEqual([104, -544, 960, 88]);
  });

  it('开启时拒绝缺失版式、坏 JSON 和原生坐标绕过；关闭时原样放行', () => {
    expect(()=>applyMangaFrames('1girl, classroom', settingsWith(), PORTRAIT)).toThrow(/已开启/);
    const plain = JSON.stringify({ summary: {}, items: [] });
    expect(()=>applyMangaFrames(plain, settingsWith(), PORTRAIT)).toThrow(/缺少 layout/);
    expect(()=>applyMangaFrames('{broken',settingsWith(),PORTRAIT)).toThrow(/无法解析/);
    expect(()=>applyMangaFrames(JSON.stringify({layout:'balanced_1',items:[{bbox:[0,0,10,10]}]}),settingsWith(),PORTRAIT)).toThrow(/需要 panel\/slot/);
    expect(applyMangaFrames(plain, settingsWith({enabled:false}), PORTRAIT)).toBe(plain);
  });
  it('内区内容框仍注入整页外框说明，避免模型只看到 C 框',()=>{
    const result=JSON.parse(applyMangaFrames(JSON.stringify({layout:'main_with_inset',items:[{panel:1,slot:'C'}]}),settingsWith(),PORTRAIT));
    expect(result.summary.caption).toContain('exactly 2 distinct comic panels');
    expect(result.summary.caption).toContain('inset panels');
  });

  it('主大格加左侧三格：外框与每对遮挡只描述一次，各项保持归属、读序和原内容', () => {
    const canvas = { width:1664, height:2496 };
    const frames = [
      [-1248,-759,1199,832], [-1102,-832,-468,-130],
      [-333,-832,301,-130], [421,-832,1055,-130],
    ];
    const panels = frames.map((frame,i) => ({
      position:`panel-${i+1}`, layer:[0,1,3,2][i],
      slots:{ F:frame, C:frame.map((n,k)=>n+(k<2 ? 16 : -16)) },
    }));
    const manga = settingsWith({custom:[{id:'14',canvas,portrait:panels}]});
    const input = {
      summary:{caption:'Quiet room, clean lineart.'}, layout:'14',
      items:[1,1,1,2,2,3,3,4,4,4].map((panel,i)=>({
        panel, slot:'C', label:i%2 ? 'text' : 'object',
        caption:`panel ${panel}, Scene detail ${i}.`, ...(i%2 ? {text:`原句${i}。`} : {}),
      })),
    };
    const source = JSON.stringify(input);
    const out = JSON.parse(applyMangaFrames(source,manga,canvas));
    expect(out.summary.caption).toMatch(/^Page frame guide: exactly 4 distinct comic panels/);
    expect(out.summary.caption).toContain('panel 1 (nearly full-page)');
    expect(out.summary.caption).toContain('panel 2 (upper-left)');
    expect(out.summary.caption).toContain('panel 3 (middle-left)');
    expect(out.summary.caption).toContain('panel 4 (lower-left)');
    for (const front of [2,3,4]) {
      expect(JSON.stringify(out).split(`panel ${front} is in front of panel 1`)).toHaveLength(2);
    }
    for (const frame of frames) expect(out.summary.caption.split(`[${frame.join(', ')}]`)).toHaveLength(2);
    expect(out.summary.caption).toContain('Reading sequence: panel 1 then panel 2 then panel 3 then panel 4');
    expect(out.summary.caption).toContain('not another comic frame');
    expect(out.summary.caption).toContain('not visible lettering');
    expect(out.summary.caption.endsWith('Quiet room, clean lineart.')).toBe(true);
    expect(out.items).toHaveLength(input.items.length);
    out.items.forEach((item:Record<string,unknown>,i:number)=>{
      expect(item.caption).toBe(`Content of panel ${input.items[i].panel}: Scene detail ${i}.`);
      expect(item.bbox).toEqual(panels[input.items[i].panel-1].slots.C);
      expect(item.text).toBe(input.items[i].text);
      expect(item.panel).toBeUndefined();
      expect(item.slot).toBeUndefined();
    });
    expect(JSON.stringify(input)).toBe(source);
  });

  it('非重叠版式不生成虚构的遮挡或嵌入关系', () => {
    const out = JSON.parse(applyMangaFrames(JSON.stringify({
      layout:'balanced_2', items:[{panel:1,slot:'C'},{panel:2,slot:'C'}],
    }),settingsWith(),PORTRAIT));
    expect(out.summary.caption).toContain('full-width upper');
    expect(out.summary.caption).toContain('full-width lower');
    expect(out.summary.caption).not.toContain('Stacking:');
    expect(out.summary.caption).not.toContain('inset panels');
  });

  it('外框四边形只写在整页说明，未引用 F 时也保留轮廓，不重复到内容项', () => {
    const canvas = {width:1024,height:1024};
    const shape = [[-400,-400],[400,-300],[400,400],[-400,400]];
    const manga = settingsWith({custom:[{id:'outline',canvas,portrait:[{
      position:'one',slots:{F:[-400,-400,400,400],C:[-380,-380,380,380]},shapes:{F:shape},
    }]}]});
    for (const slot of ['C','F']) {
      const out = JSON.parse(applyMangaFrames(JSON.stringify({
        layout:'outline',items:[{panel:1,slot,caption:'A room.'},{panel:1,slot,caption:'A vase.'}],
      }),manga,canvas));
      expect(out.summary.caption).toContain(`clockwise corners xy ${JSON.stringify(shape)}`);
      expect(JSON.stringify(out).split('clockwise corners')).toHaveLength(2);
      expect(out.items[0].bbox).toEqual(manga.custom[0].portrait![0].slots[slot]);
    }
  });
});

describe('resolveLayouts', () => {
  it('旧自定义版式只迁移一次 BL/BR，删除后重载不补回，也不恢复其他已删槽位',()=>{
    const legacy={enabled:true,custom:[{id:'legacy',portrait:[
      {position:'p',slots:{F:[-400,-400,400,400],B:[200,-380,380,380]}},
      {position:'no_bottom',slots:{F:[-400,-400,400,400]}},
    ]}]};
    const upgraded=normalizeManga(legacy);
    expect(upgraded.textSlotsVersion).toBe(1);
    const panels=upgraded.custom[0].portrait!;
    expect(panels[0].slots.BL[3]).toBeLessThan(panels[0].slots.BR[1]);
    expect(panels[0].slots.T).toBeUndefined();
    expect(panels[1].slots.BL).toBeUndefined();
    delete panels[0].slots.BL;
    const saved=normalizeManga(JSON.parse(JSON.stringify(upgraded)));
    expect(saved.custom[0].portrait![0].slots.BL).toBeUndefined();
    expect(saved.custom[0].portrait![0].slots.BR).toBeDefined();
    expect(()=>applyMangaFrames(JSON.stringify({layout:'legacy',items:[{panel:1,slot:'BL'}]}),saved,PORTRAIT)).toThrow(/没有 BL/);
    expect(legacy.custom[0].portrait[0].slots).not.toHaveProperty('BL');
  });
  it('删除内置版式后横竖清单与生图查表均不可选，持久化并可恢复原配置', () => {
    const original = settingsWith({ disabled:['balanced_2'], deleted:['balanced_1'], custom:[{id:'balanced_1',usage:'保留的用途'}] });
    const saved = normalizeManga(JSON.parse(JSON.stringify(original)));
    for (const orientation of ['portrait','landscape'] as const) {
      expect(resolveLayouts(saved,orientation).map(x=>x.id)).not.toContain('balanced_1');
    }
    expect(buildMangaSpec(saved)).not.toContain('balanced_1');
    expect(() => applyMangaFrames(JSON.stringify({layout:'balanced_1',items:[{panel:1,slot:'F'}]}),saved,PORTRAIT)).toThrow(/恢复已删除/);
    saved.deleted=[];
    expect(resolveLayouts(saved,'portrait').find(x=>x.id==='balanced_1')?.usage).toBe('保留的用途');
    expect(saved.disabled).toEqual(['balanced_2']);
    expect(normalizeManga({deleted:[' balanced_1 ','balanced_1',null,'made_up']}).deleted).toEqual(['balanced_1']);
    expect(normalizeManga({}).deleted).toEqual([]);
  });
  it('全部内置横竖版式坐标有效且落在对应画布内', () => {
    for (const orientation of ['portrait', 'landscape'] as const) {
      const layouts = resolveLayouts(settingsWith(), orientation);
      expect(layouts).toHaveLength(18);
      for (const layout of layouts) {
        expect(parseCustomLayout(JSON.stringify({ id: layout.id, [orientation]: layout.panels }))[orientation]).toHaveLength(layout.panels.length);
      }
    }
  });
  it('拒绝部分损坏、自定义位置重复和越界的面板', () => {
    for (const slots of [{ F: [0, 0, 1] }, { F: [-2000, -10, 10, 10] }, { F: [-10, -10, 10, 10], C: 'bad' }]) {
      expect(() => parseCustomLayout(JSON.stringify({ id: 'broken', portrait: [{ position: 'single', slots }] }))).toThrow();
    }
    const panel = { position: 'single', slots: { F: [-10, -10, 10, 10] } };
    expect(() => parseCustomLayout(JSON.stringify({ id: 'broken', portrait: [panel, panel] }))).toThrow(/重复/);
  });
  it('自定义同 id 覆盖内置,新 id 追加,停用项消失', () => {
    const custom = parseCustomLayout(
      JSON.stringify({
        id: 'balanced_1',
        label: '我的单格',
        portrait: [{ position: 'single', slots: { F: [-900, -500, 900, 500] } }],
      }),
    );
    const added = parseCustomLayout(
      JSON.stringify({
        id: 'my_two',
        label: '自制双格',
        portrait: [
          { position: 'top', slots: { F: [-900, -500, -20, 500] } },
          { position: 'bottom', slots: { F: [20, -500, 900, 500] } },
        ],
      }),
    );
    const layouts = resolveLayouts(settingsWith({ custom: [custom, added], disabled: ['balanced_2'] }), 'portrait');
    const ids = layouts.map(layout => layout.id);
    expect(ids).not.toContain('balanced_2');
    expect(ids).toContain('my_two');
    expect(layouts.find(layout => layout.id === 'balanced_1')?.panels[0].slots.F).toEqual([-900, -500, 900, 500]);
    expect(layouts.find(layout => layout.id === 'balanced_1')?.panels[0].slots.C).toBeUndefined();
  });
});

describe('buildMangaSpec', () => {
  it('标题使用启用版式的实际画布尺寸，兼容混合尺寸', () => {
    const landscape = resolveLayouts(settingsWith(), 'landscape');
    const custom = resolveLayouts(settingsWith(), 'portrait').map(layout => ({
      id: layout.id, canvas: { width: 1152, height: 1728 }, portrait: layout.panels,
      landscape: landscape.find(other => other.id === layout.id)!.panels,
    }));
    const spec = buildMangaSpec(settingsWith({ custom }));
    expect(spec).toContain('portrait(1152×1728):');
    expect(spec).toContain('landscape(1728×1152):');
    expect(spec).not.toContain('portrait(1088×1920)');
    const mixed = buildMangaSpec(settingsWith({ custom: [custom[0]] }));
    expect(mixed).toContain('portrait(1152×1728 / 1088×1920):');
  });

  it('清单带格数、槽位与空间比例，不发送原始像素坐标表', () => {
    const spec = buildMangaSpec(settingsWith());
    expect(spec).toContain('balanced_1');
    expect(spec).toContain('main_inset_then_two');
    expect(spec.startsWith('【版式清单与挑选】')).toBe(true);
    expect(spec).toContain('portrait(1088×1920)');
    expect(spec).toContain('landscape(1920×1088)');
    expect(spec).toMatch(/1\(single\):[^\n]*槽位 F[^\n]*\bS\b/);
    expect(spec).not.toMatch(/1\(single\):[^\n]*\bX\b/);
    expect(spec).toContain('顶层增加 layout');
    expect(spec).toContain('位置[');
    expect(spec).toMatch(/；槽位 [^；\n]*\bC\b/);
    expect(spec).not.toContain('[-924,-504,924,504]');
    // 每行带「用途」引导，读序统一加前缀
    expect(spec).toContain('整页只给一个瞬间；表情或接触点的满页特写');
    expect(spec).toContain('｜读序 上到下，同行左到右');
    expect(spec).toContain('上半一记大画面，下半两个反应或对话');

    // 设置页写的选择说明整段拼在第四节末尾
    const withNotes = buildMangaSpec({ ...mangaDefaults(), enabled: true, selectionNotes: '同一页不要连用两套满格' });
    expect(withNotes.trimEnd().endsWith('同一页不要连用两套满格')).toBe(true);
    expect(spec).not.toContain('同一页不要连用两套满格');
  });

  it('新增版式立即出现在清单里', () => {
    const added = parseCustomLayout(
      JSON.stringify({
        id: 'my_two',
        label: '自制双格',
        portrait: [
          { position: 'top', slots: { F: [-900, -500, -20, 500] } },
          { position: 'bottom', slots: { F: [20, -500, 900, 500] } },
        ],
      }),
    );
    const spec = buildMangaSpec(settingsWith({ custom: [added] }));
    expect(spec).toContain('my_two');
  });
});
