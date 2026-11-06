import { describe, expect, it, vi } from 'vitest';
import { applyMangaFrames, mangaDefaults } from './layouts';
const size={width:1088,height:1920};
function source(){return {layout:'balanced_1',summary:{caption:'An adult courier in a blue jacket.'},items:[{panel:1,slot:'S',label:'character',caption:'One adult courier holding a parcel.'},{panel:1,slot:'T',label:'text',caption:'Black printed Chinese lettering.',text:'包裹到了。'}]};}
function compile(input: unknown){return JSON.parse(applyMangaFrames(JSON.stringify(input),{...mangaDefaults(),enabled:true},size));}
describe('MOSS 无损字段清理',()=>{
  it('只移除已接管的冗余字段和空值，保留人物、原文、坐标和源对象',()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const input:any=source(),expected=compile(input);
      Object.assign(input,{width:1088,height:1920,layer:9,debug:'debug information',children:[],unused:null});
      Object.assign(input.summary,{meta:'anime',palette:['blue','',null],unused:{}});
      Object.assign(input.items[0],{tags:'courier',text:'',children:[],layer:4,debug:'debug information'});
      const before=JSON.stringify(input),output=compile(input);
      expect(JSON.stringify(input)).toBe(before);
      expect(Object.keys(output).sort()).toEqual(['bbox_coord_space','bbox_format','items','summary']);
      expect(output.summary.meta).toEqual(['anime']);expect(output.summary.palette).toEqual(['blue']);
      expect(output.items[0].tags).toEqual(['courier']);expect(output.items[0]).not.toHaveProperty('text');
      expect(output.items).toHaveLength(2);expect(output.items[1].text).toBe('包裹到了。');
      expect(output.items.map((x:any)=>x.bbox)).toEqual(expected.items.map((x:any)=>x.bbox));
      expect(warn).toHaveBeenCalled();expect(JSON.stringify(output)).not.toContain('debug information');
    } finally {warn.mockRestore();}
  });
  it.each([
    ['人物身份字段错误',(v:any)=>{delete v.items[0].label},'label'],
    ['人物描述为空',(v:any)=>{v.items[0].caption=' '},'caption'],
    ['台词缺失',(v:any)=>{delete v.items[1].text},'text'],
    ['人物项中有台词',(v:any)=>{v.items[0].text='保留这句台词'},'不能删除'],
    ['非空子项',(v:any)=>{v.items[0].children=[{caption:'another person'}]},'不能安全丢弃'],
    ['非空未知内容',(v:any)=>{v.items[0].font_size=32},'不能安全丢弃'],
    ['尺寸冲突',(v:any)=>{v.width=1024},'实际画布'],
    ['可选数组含非空对象',(v:any)=>{v.items[0].tags=[{identity:'courier'}]},'字符串数组'],
  ])('%s 不以删项修复',(_name,change,expected)=>{
    const input=source();change(input);expect(()=>compile(input)).toThrow(expected);
  });
});
