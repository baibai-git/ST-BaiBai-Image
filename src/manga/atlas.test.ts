import { describe, expect, it } from 'vitest';
import { buildLayoutAtlases } from './atlas';
import { buildMangaCatalog, mangaDefaults, mangaGridRegions, mangaPanelReadingOrder, normalizeManga, resolveLayouts, type ResolvedLayout } from './layouts';

const layout=(id:string):ResolvedLayout=>({id,label:id,readingOrder:'',canvas:{width:100,height:200},panels:[
  {position:'panel-9',layer:2,slots:{F:[-100,-50,0,50],S:[-90,-40,-10,40],TR:[-90,0,-60,40]},shapes:{F:[[-50,-100],[50,-80],[50,0],[-50,-20]]}},
  {position:'panel-1',layer:0,slots:{F:[0,-50,100,50],S:[0,-40,90,40]}}
]});
describe('four-layout atlases',()=>{
  it('groups four at a time, separates orientation, retains original panel identity and layer order',()=>{
    const candidates={portrait:['a','b','c','d','e'].map(layout),landscape:[layout('wide')]};
    const before=JSON.stringify(candidates);
    const atlases=buildLayoutAtlases(candidates);
    expect(atlases.map(x=>x.ids)).toEqual([['a','b','c','d'],['e'],['wide']]);
    expect(atlases[0].svg.indexOf('data-panel-frame="2"')).toBeLessThan(atlases[0].svg.indexOf('data-panel-frame="1"'));
    expect(atlases[0].svg).toContain('>TR<');
    expect(atlases[0].svg).not.toContain('>panel 9<');
    expect(JSON.stringify(candidates)).toBe(before);
    candidates.portrait[0].panels[0].shapes!.F[0][0]=-30;
    expect(buildLayoutAtlases(candidates)[0].svg).not.toBe(atlases[0].svg);
    candidates.portrait.push(layout('new'));
    expect(buildLayoutAtlases(candidates)[1].ids).toEqual(['e','new']);
  });
  it('escapes labels, omits compatibility X, and yields no sheet for empty candidates',()=>{
    const item=layout('<script>&"'); item.panels[0].slots.X=[-100,-50,100,50];
    const [atlas]=buildLayoutAtlases({portrait:[item],landscape:[]});
    expect(atlas.svg).toContain('&lt;script&gt;&amp;&quot;');
    expect(atlas.svg).not.toContain('<script>'); expect(atlas.svg).not.toContain('>X<');
    expect(buildLayoutAtlases({portrait:[],landscape:[]})).toEqual([]);
  });
  it('normalizes the toggle without changing saved geometry or restoring deleted slots',()=>{
    const old={...mangaDefaults(),custom:[{id:'custom',portrait:layout('x').panels,canvas:{width:100,height:200}}]};
    const text=normalizeManga(old), image=normalizeManga({...old,catalogMode:'image'});
    expect(text.catalogMode).toBe('text'); expect(image.catalogMode).toBe('image');
    expect(resolveLayouts(image,'portrait').find(x=>x.id==='custom')!.panels).toEqual(old.custom[0].portrait);
  });
  it('shows actual grid availability, clips disabled hatching, and preserves custom G keys',()=>{
    const item:ResolvedLayout={id:'diamond',label:'diamond',readingOrder:'',canvas:{width:960,height:1440},panels:[
      {position:'one',slots:{F:[-720,-480,720,480],TR:[-1,-1,1,1]},shapes:{F:[[0,-720],[480,0],[0,720],[-480,0]]}},
    ]};
    const grid=mangaGridRegions(item.panels[0]);
    const svg=buildLayoutAtlases({portrait:[item],landscape:[]})[0].svg;
    const states=[...svg.matchAll(/data-grid="(G\d)" data-panel="1" data-state="(\w+)"/g)];
    expect(states).toHaveLength(9);
    for (const [,key,state] of states) expect(state).toBe(grid[key] ? 'available' : 'unavailable');
    expect(svg).toContain('clip-path="url(#frame-0-0)"');
    expect(svg).toContain('fill="url(#g-disabled)"');
    expect(svg).toContain('>G1 不可用<');
    expect(svg).toContain('>G5<');
    expect(svg).toContain('data-slot-leader="TR"');
    expect(svg.lastIndexOf('data-slot-leader=')).toBeLessThan(svg.indexOf('data-slot-label='));
    const disabled=[...svg.matchAll(/<polygon points="([^"]*)" data-grid="G\d" data-panel="1" data-state="unavailable"/g)];
    for (const [,points] of disabled) {
      for (const point of points.split(' ')) {
        const [x,y]=point.split(',').map(Number);
        // Rendered diamond: its center is (366,561), half-width 478.7/2, half-height 718/2.
        expect(Math.abs(x-366)/(478.7/2)+Math.abs(y-561)/(718/2)).toBeLessThanOrEqual(1.002);
      }
    }
    item.panels[0].slots.G1=[-40,-40,40,40];
    const custom=buildLayoutAtlases({portrait:[item],landscape:[]})[0].svg;
    expect(custom).not.toContain('data-grid="G1"');
    expect(custom).toContain('>G1<');
    expect(custom).not.toContain('>G1 不可用<');
  });
  it('connects saved reading order rather than numeric or geometric order, using safe badges',()=>{
    const item=layout('ordered');item.readingOrder='panel-1 → panel-9';
    expect(mangaPanelReadingOrder(item)).toEqual([1,0]);
    const svg=buildLayoutAtlases({portrait:[item],landscape:[]})[0].svg;
    expect(svg).toContain('data-read-from="2" data-read-to="1"');
    expect(svg).not.toContain('data-read-from="1" data-read-to="2"');
    expect(svg).toContain('read 2 → 1');
    const arrowAt=svg.indexOf('data-read-from="2"'),labelAt=svg.indexOf('data-slot-label='),badgeAt=svg.indexOf('data-panel-badge=');
    expect(arrowAt).toBeGreaterThan(svg.lastIndexOf('data-panel-frame='));
    expect(arrowAt).toBeLessThan(labelAt);expect(labelAt).toBeLessThan(badgeAt);
    const arrow=svg.match(/data-read-from="2"[^>]* d="([^"]+)"/)!;
    expect(arrow[1].match(/L/g)).toHaveLength(1); // One direct segment, behind opaque labels.
    const badges=[...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*data-panel-badge="(\d+)"[^>]*data-placement="(\w+)"/g)];
    expect(badges).toHaveLength(2);
    expect(badges.every(match=>match[6]==='internal')).toBe(true);
    const a=badges[0].slice(1,5).map(Number),b=badges[1].slice(1,5).map(Number);
    expect(Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]))).toBe(0);
    item.readingOrder='free-form direction';expect(mangaPanelReadingOrder(item)).toEqual([0,1]);
    item.readingOrder='panel-1 → panel-1';expect(mangaPanelReadingOrder(item)).toEqual([0,1]);
  });
  it('keeps brief geometry and the same reading order in visual catalogs',()=>{
    const item=layout('geometry');item.readingOrder='panel-1 → panel-9';
    const catalog=buildMangaCatalog({portrait:[item],landscape:[]},'',true);
    expect(catalog).toContain('panel读序 2 → 1');
    expect(catalog).toMatch(/1:.*F 位置\[[\d.,]+\]% 宽高比[\d.]+ 面积[\d.]+%；槽位/);
    expect(catalog).toContain('均不保证文字容量');
    expect(catalog).not.toContain('斜四边形轮廓[');
    expect(catalog).not.toContain('排名');
  });
});
