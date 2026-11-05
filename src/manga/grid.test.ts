import { describe, expect, it } from 'vitest';
import { applyMangaFrames, buildMangaCatalog, mangaDefaults, mangaGridRegions, resolveLayouts, resolveMangaGridRegion, type MangaPanel } from './layouts';
import { buildLayoutAtlases } from './atlas';

const canvas={width:960,height:1440};
const panel=():MangaPanel=>({position:'panel-1',slots:{F:[-720,-480,720,480],S:[-700,-460,700,460]}});
function setup(p=panel()) {
  return {...mangaDefaults(),enabled:true,custom:[{id:'grid_test',canvas,portrait:[p]}]};
}
function compile(items:unknown[],p=panel()) {
  return JSON.parse(applyMangaFrames(JSON.stringify({layout:'grid_test',summary:{caption:'A color comic.'},items}),setup(p),canvas));
}
const corners=([t,l,b,r]:number[])=>[[l,t],[r,t],[r,b],[l,b]];

describe('F virtual positioning grid',()=>{
  it('uses screen-space row order, centered yxyx coordinates, with no mutation',()=>{
    const p=panel(), before=JSON.stringify(p), grid=mangaGridRegions(p);
    expect(Object.keys(grid)).toEqual(['G1','G2','G3','G4','G5','G6','G7','G8','G9']);
    expect(grid.G1).toEqual([-720,-480,-240,-160]);
    expect(grid.G5).toEqual([-240,-160,240,160]);
    expect(grid.G9).toEqual([240,160,720,480]);
    expect(JSON.stringify(p)).toBe(before);
  });
  it('tiles odd-size frames and landscape frames without pixel gaps',()=>{
    for (const frame of [[-23,-17,52,84],[-480,-720,480,720]]) {
      const grid=mangaGridRegions({position:'x',slots:{F:frame}});
      expect(Object.values(grid).reduce((sum,[t,l,b,r])=>sum+(b-t)*(r-l),0)).toBe((frame[2]-frame[0])*(frame[3]-frame[1]));
      for (let row=0;row<3;row++) for(let col=0;col<2;col++) expect(grid[`G${row*3+col+1}`][3]).toBe(grid[`G${row*3+col+2}`][1]);
      for(let i=1;i<=6;i++) expect(grid[`G${i}`][2]).toBe(grid[`G${i+3}`][0]);
    }
  });
  it('fits slanted borders inward and omits cells that cannot fit a diamond',()=>{
    const p=panel(); p.shapes={F:[[-300,-720],[480,-720],[480,720],[-480,720]]};
    const grid=mangaGridRegions(p);
    expect(grid.G1).not.toEqual(mangaGridRegions(panel()).G1);
    for (const box of [...Object.values(grid),resolveMangaGridRegion(p,'G1+G2+G4+G5')!]) for (const [x,y] of corners(box)) {
      expect(x).toBeGreaterThanOrEqual(-300-.125*(y+720)-.001);
      expect(x).toBeLessThanOrEqual(480); expect(y).toBeGreaterThanOrEqual(-720); expect(y).toBeLessThanOrEqual(720);
    }
    p.shapes={F:[[0,-720],[480,0],[0,720],[-480,0]]};
    const diamond=mangaGridRegions(p);
    expect(Object.keys(diamond)).toEqual(['G2','G4','G5','G6','G8']);
    for (const box of Object.values(diamond)) for(const [x,y] of corners(box)) expect(Math.abs(x)/480+Math.abs(y)/720).toBeLessThanOrEqual(1.00001);
    expect(resolveMangaGridRegion(p,'G1+G2')).toBeUndefined();
  });
  it('merges only fully filled rectangles of available cells',()=>{
    const p=panel();
    expect(resolveMangaGridRegion(p,'G1+G2')).toEqual([-720,-480,-240,160]);
    expect(resolveMangaGridRegion(p,'G2+G1')).toEqual(resolveMangaGridRegion(p,'G1+G2'));
    expect(resolveMangaGridRegion(p,'G1+G4')).toEqual([-720,-480,240,-160]);
    expect(resolveMangaGridRegion(p,'G1+G2+G4+G5')).toEqual([-720,-480,240,160]);
    expect(resolveMangaGridRegion(p,'G1+G2+G3+G4+G5+G6+G7+G8+G9')).toEqual(p.slots.F);
    for(const key of ['G0','G10','G1_2','G1+G1','G1+G5','G1+G2+G4','G1+G3','G1+S','G1+']) expect(resolveMangaGridRegion(p,key),key).toBeUndefined();
    expect(mangaGridRegions({position:'x',slots:{S:[0,0,10,10]}})).toEqual({});
    expect(mangaGridRegions({position:'x',slots:{F:[0,0,0,10]}})).toEqual({});
  });
  it('only compiles referenced helpers, preserving native membership and subject identity',()=>{
    const p=panel(), settings=setup(p), before=JSON.stringify(settings);
    const out=compile([
      {panel:1,slot:'S',label:'character',caption:'One traveler holding a book.'},
      {panel:1,slot:'G4+G5',label:'object',caption:'The same traveler’s left gloved hand holding the book, wrist continuous with the jacket sleeve.'},
    ],p);
    expect(out.items).toHaveLength(2);
    expect(out.items[1].bbox).toEqual([-240,-480,240,160]);
    expect(out.items[1].caption).toContain('Content of panel 1:');
    expect(out.items[1].caption).toContain('wrist continuous with the jacket sleeve');
    expect(out.items.every((item:any)=>item.panel===undefined && item.slot===undefined)).toBe(true);
    expect(out.summary.caption).toContain('exactly 1 distinct comic panels');
    expect(out.bbox_format).toBe('yxyx'); expect(out.bbox_coord_space).toBe('abs_centralized');
    expect(JSON.stringify(settings)).toBe(before);
    expect(compile([{panel:1,slot:'S',label:'character',caption:'One traveler.'}]).items).toHaveLength(1);
  });
  it('rejects invalid references without changing grid geometry',()=>{
    for(const slot of ['G10','G1+G5','G1+G2+G4']) expect(()=>compile([{panel:1,slot,label:'object',caption:'Detail.'}])).toThrow(/没有/);
    expect(()=>compile([{panel:2,slot:'G5',label:'object',caption:'Detail.'}])).toThrow(/没有第 2 格/);
  });
  it('supports independent characters, objects and text in single or merged grid regions',()=>{
    const out=compile([
      {panel:1,slot:'S',label:'character',tags:['alice'],caption:'Alice in a blue jacket.'},
      {panel:1,slot:'G2+G5+G8',label:'character',tags:['bob'],palette:['brown'],caption:'Bob in a brown coat beside Alice.'},
      {panel:1,slot:'G1',label:'text',text:'你好',caption:'Spoken by Bob, large printed glyphs.'},
      {panel:1,slot:'G4',label:'object',caption:'A freestanding reading lamp.'},
    ]);
    expect(out.items.map((item:any)=>item.label)).toEqual(['character','character','text','object']);
    expect(out.items[1].bbox).toEqual([-720,-160,720,160]);
    expect(out.items[1].tags).toEqual(['bob']);expect(out.items[1].palette).toEqual(['brown']);
    expect(out.items[2].text).toBe('你好');expect(out.items[2].caption).toContain('selected grid text region');
    for(const item of out.items) expect(item.caption).not.toContain('Local positioning detail');
    expect(out.items[3].caption).not.toContain('anatomy');
  });
  it('keeps existing custom G keys intact and unavailable for virtual merges',()=>{
    const p=panel(); p.slots.G5=[0,0,50,50];
    expect(mangaGridRegions(p).G5).toBeUndefined();
    expect(resolveMangaGridRegion(p,'G4+G5')).toBeUndefined();
    expect(compile([{panel:1,slot:'G5',label:'character',caption:'Existing region.'}],p).items[0].bbox).toEqual([0,0,50,50]);
  });
  it('advertises helpers dynamically in both modes and draws them without persisting them',()=>{
    const settings=setup(), layouts={portrait:resolveLayouts(settings,'portrait').filter(x=>x.id==='grid_test'),landscape:[]};
    const before=JSON.stringify(layouts);
    for (const visual of [false,true]) {
      const catalog=buildMangaCatalog(layouts,'',visual);
      expect(catalog).toContain('G1 G2 G3'); expect(catalog).toContain('G1+G2+G4+G5'); expect(catalog).toContain('character、object、text');
      expect(catalog.split('\n').slice(1).join('\n')).toContain('【可选网格区域】');
      expect(catalog).toContain('槽位 F S G1 G2 G3 G4 G5 G6 G7 G8 G9');
    }
    const [atlas]=buildLayoutAtlases(layouts);
    expect(atlas.svg).toMatch(/>G[1-9]</);
    expect(atlas.svg.match(/data-state="available"/g)).toHaveLength(9);
    expect(JSON.stringify(layouts)).toBe(before);
    expect(Object.keys(layouts.portrait[0].panels[0].slots)).toEqual(['F','S']);
  });
});
