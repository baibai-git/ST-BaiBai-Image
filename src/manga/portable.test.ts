import {describe,it,expect} from 'vitest';
import {readLayoutFile,writeLayoutFile,portableLayout,directionalLayout} from './portable';
import {parseCustomLayout} from './layouts';
const p={position:'panel-5',layer:3,locked:true,slots:{F:[-768,-512,768,512],S:[-650,-400,700,400],S_2:[-300,-200,-100,100]},slotNotes:{S:'same character',S_2:'hand'},slotContents:{S_2:[{label:'character',caption:'Her hand holds a cup.'}]},shapes:{S_2:[[-200,-300],[100,-290],[90,-100],[-200,-100]]}};
const old={id:'legacy_skill',label:'Old Skill',usage:'Choosing a page',description:'Actual page',promptCaption:'Legacy direct caption',canvas:{width:1024,height:1536},portrait:[p],landscape:[{position:'wide',slots:{F:[-512,-768,512,768]}}],omitFullPageFrame:true,omitSmallFrames:false,useBboxCorners:false};
describe('portable layout compatibility',()=>{
 it('keeps both directions, numbered regions, manual content, geometry and independent descriptions through repeated interchange',()=>{
   const file=JSON.parse(writeLayoutFile([old]));expect(file.format).toBe('moss-manga-layouts');
   const flat=portableLayout(readLayoutFile(file).layouts[0]);expect(flat.panels).toEqual([p]);
   const restored=directionalLayout(flat);expect(restored).toEqual(old);
   expect(parseCustomLayout(JSON.stringify(flat)).portrait).toEqual([p]);
   expect(restored.usage).toBe('Choosing a page');expect(restored.description).toBe('Actual page');expect(restored.promptCaption).toBe('Legacy direct caption');
 });
 it('accepts old envelopes, arrays and individual Skill exports; emits explicit legacy format',()=>{
   for(const value of [old,[old],{layouts:[old]},{format:'bbi-manga-layouts',version:1,layouts:[old]}])expect(readLayoutFile(value).layouts).toEqual([old]);
   const legacy=JSON.parse(writeLayoutFile([old],{legacy:true}));expect(legacy.format).toBe('bbi-manga-layouts');expect(legacy.layouts[0]).not.toHaveProperty('panels');
   const flatLegacy=JSON.parse(writeLayoutFile([portableLayout(old)],{legacy:true}));expect(flatLegacy.layouts[0]).not.toHaveProperty('panels');expect(flatLegacy.layouts[0].portrait).toEqual([p]);
   expect(portableLayout({...old,panels:[Object.fromEntries(Object.entries(p).reverse())]}).panels).toHaveLength(1);
 });
 it('fails conflicting geometry, unknown versions and malformed manual data instead of losing fields',()=>{
   expect(()=>portableLayout({...old,panels:[{...p,layer:9}]})).toThrow(/不一致/);
   expect(()=>readLayoutFile({format:'moss-manga-layouts',version:2,layouts:[old]})).toThrow(/版本/);
   expect(()=>parseCustomLayout(JSON.stringify({...old,portrait:[{...p,slotContents:{MISSING:[{label:'object',caption:'x'}]}}]}))).toThrow();
 });
});
