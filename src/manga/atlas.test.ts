import { describe, expect, it } from 'vitest';
import { buildLayoutAtlases } from './atlas';
import { mangaDefaults, normalizeManga, resolveLayouts, type ResolvedLayout } from './layouts';

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
    expect(atlases[0].svg.indexOf('>P2<')).toBeLessThan(atlases[0].svg.indexOf('>P1<'));
    expect(atlases[0].svg).toContain('>TR<');
    expect(atlases[0].svg).not.toContain('>P9<');
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
});
