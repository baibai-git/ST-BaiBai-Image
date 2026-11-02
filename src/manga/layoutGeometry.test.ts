import { describe, expect, it } from 'vitest';
import { buildMangaCatalog, type MangaPanel, type ResolvedLayout } from './layouts';

const canvas={width:1000,height:2000};
function catalog(panels:MangaPanel[],extra:Partial<ResolvedLayout>={}) {
  return buildMangaCatalog({portrait:[{id:'test',label:'test',canvas,readingOrder:'1→2→3',panels,...extra}],landscape:[]});
}

describe('LLM layout geometry',()=> {
  it('distinguishes reading index from position and area, and describes real inner regions without mutating them',()=> {
    const panels:MangaPanel[]=[
      {position:'panel-2',slots:{F:[-1000,100,0,500],S:[-900,120,-200,480],T:[-1000,100,-800,500]},slotNotes:{F:'show the listener'}},
      {position:'panel-1',slots:{F:[-1000,-500,1000,0]}},
      {position:'panel-3',slots:{F:[200,100,1000,500]}},
    ];
    const original=JSON.stringify(panels), text=catalog(panels);
    expect(text).toContain('1(panel-2):F S T；F upper-right 位置[60,0,40,50]% 宽高比0.4 面积20% 排名2/3');
    expect(text).toContain('2(panel-1):F；F full-height left 位置[0,0,50,100]% 宽高比0.25 面积50% 排名1/3');
    expect(text).toContain('S[5,10,90,70] T[0,0,100,20]');
    expect(text).toContain('框用途 {"F":"show the listener"}');
    expect(text).not.toContain('MR[');
    expect(text.indexOf('1(panel-2)')).toBeLessThan(text.indexOf('2(panel-1)'));
    expect(JSON.stringify(panels)).toBe(original);
  });

  it('uses polygon area instead of bbox area, including reverse winding and equal-area ranks',()=> {
    const quad=[[-500,-1000],[500,-1000],[0,1000],[-500,1000]];
    const text=catalog([
      {position:'a',slots:{F:[-1000,-500,1000,500],S:[-1000,-500,1000,500]},shapes:{F:quad,S:quad}},
      {position:'b',slots:{F:[-1000,-500,1000,500]},shapes:{F:[...quad].reverse()}},
    ]);
    expect(text.match(/面积75% 排名1\/2/g)).toHaveLength(2);
    expect(text).toContain('斜四边形轮廓[0,0;100,0;50,100;0,100]');
    expect(text).toContain('S[0,0,100,100]斜框面积75%');
    expect(text).not.toContain('几何包含：');
  });

  it('reports actual overlap layers and geometric containment without inventing an inset event',()=> {
    const text=catalog([
      {position:'main',layer:3,slots:{F:[-1000,-500,1000,500],S:[-1100,-500,1000,500]}},
      {position:'contained',layer:1,slots:{F:[-500,-100,0,100]}},
    ]);
    expect(text).toContain('panel 1 is in front of panel 2');
    expect(text).toContain('几何包含：panel 2 位于 panel 1 轮廓内');
    expect(text).toContain('是否同刻嵌入仍按用途与原文判断');
    expect(text).toContain('S[0,-5,100,105]');
    expect(text).toContain('跨格主体 S');
    const touching=catalog([{position:'left',slots:{F:[-1000,-500,1000,0]}},{position:'right',slots:{F:[-1000,0,1000,500]}}]);
    expect(touching).not.toContain('重叠层级：');
  });

  it('uses the actual custom canvas, handles missing F honestly, and excludes compatibility X slots',()=> {
    const text=catalog([{position:'only-text',slots:{T:[-100,-100,100,100],X:[-100,-100,100,100]}}],{canvas:{width:2000,height:1000}});
    expect(text).toContain('portrait(2000×1000)');
    expect(text).toContain('F未配置，整格边界未知');
    expect(text).toContain('T[45,40,10,20]');
    expect(text).not.toContain('X[');
  });
});
