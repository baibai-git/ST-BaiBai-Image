import { slotType, type MangaOrientation, type MangaPanel, type ResolvedLayout } from '@/manga/layouts';
import type { ChatMsg } from '@/api/client';

export const ATLAS_IMAGE_HEADER = '【会话完整版式图册】';

export function layoutAtlasMessages(images: string[], labels: string[], perMessage = 4, revision?: string, catalog?: string): ChatMsg[] {
  if (!Number.isSafeInteger(perMessage) || perMessage < 1) throw new Error('版式图片分组上限无效');
  const messages: ChatMsg[]=[];
  for (let start=0;start<images.length;start+=perMessage) {
    const group=labels.slice(start,start+perMessage);
    messages.push({role:'user',
      content:ATLAS_IMAGE_HEADER+`（第 ${start/perMessage+1}/${Math.ceil(images.length/perMessage)} 组）\n`+
        group.map((label,i)=>`本消息第 ${i+1} 张（总图 ${start+i+1}）：${label}`).join('\n')+
        '\n图册包含暂时冷却的 ID；实际选版必须服从本轮文字白名单。图中 P 编号为输出 panel 编号；只参考几何，不把图例或标签画进作品。'+
        (start===0 && catalog ? '\n'+catalog : ''),
      images:images.slice(start,start+perMessage),atlasLabels:group,
      ...(revision ? {atlasRevision:revision} : {}),...(start===0 && catalog ? {atlasCatalog:catalog} : {})});
  }
  return messages;
}

/** Regroup adjacent generated atlas blocks; preserve other messages and source arrays. */
export function regroupLayoutAtlasMessages(messages: ChatMsg[], perMessage: number): ChatMsg[] {
  const result: ChatMsg[]=[];
  for (let index=0;index<messages.length;) {
    const isAtlas=(message:ChatMsg|undefined)=>message?.role==='user' && !message.purpose &&
      message.content.startsWith(ATLAS_IMAGE_HEADER) && !!message.images?.length && message.atlasLabels?.length===message.images.length;
    if (!isAtlas(messages[index])) { result.push(messages[index++]);continue; }
    const revision=messages[index].atlasRevision,catalog=messages[index].atlasCatalog;
    const images:string[]=[],labels:string[]=[];
    while (isAtlas(messages[index]) && messages[index].atlasRevision===revision) {
      const message=messages[index++];
      images.push(...message.images!);labels.push(...message.atlasLabels!);
    }
    result.push(...layoutAtlasMessages(images,labels,perMessage,revision,catalog));
  }
  return result;
}

export interface LayoutAtlas { orientation: MangaOrientation; ids: string[]; svg: string }
const WIDTH = 1440, HEIGHT = 1800, CARD_W = 692, CARD_H = 818;
const COLORS = { frame: '#34465b', subject: '#2463b3', text: '#b66c13', auxiliary: '#8c3ab0', background: '#728095' };
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[char]!);
const num = (value: number) => Math.round(value * 10) / 10;
const text = (x: number, y: number, value: string, size = 18, color = '#243449') =>
  `<text x="${num(x)}" y="${num(y)}" font-size="${size}" fill="${color}">${escape(value)}</text>`;
type Point = number[];
type Rect = { x: number; y: number; w: number; h: number };
function outline(panel: MangaPanel, key: string): Point[] {
  const [top,left,bottom,right] = panel.slots[key];
  return panel.shapes?.[key] ?? [[left,top],[right,top],[right,bottom],[left,bottom]];
}
function contains(points: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i=0,j=points.length-1; i<points.length; j=i++) {
    const [ax,ay]=points[i], [bx,by]=points[j];
    if ((ay>y)!==(by>y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
  }
  return inside;
}
function overlap(a: Rect, b: Rect): number {
  return Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)) * Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
}

/** Exact saved outlines, four layouts per sheet; panel array order is the output panel number. */
export function buildLayoutAtlases(layouts: Record<MangaOrientation, ResolvedLayout[]>): LayoutAtlas[] {
  const result: LayoutAtlas[]=[];
  for (const orientation of ['portrait','landscape'] as const) {
    const entries=layouts[orientation];
    for (let start=0;start<entries.length;start+=4) {
      const batch=entries.slice(start,start+4);
      const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Arial, Microsoft YaHei, sans-serif">`,
        `<rect width="${WIDTH}" height="${HEIGHT}" fill="#eef2f7"/>`,
        text(28,36,`LAYOUT ATLAS · ${orientation} · ${start/4+1}/${Math.ceil(entries.length/4)}`,25),
        text(28,66,'P# = output panel number · labels = legal slot keys · regions are alternatives, not required content',16),
      ];
      const legend=[['subject','Subject S / L / R'],['text','Text T / TL / TR / B / ML / MR'],['auxiliary','Auxiliary O'],['background','Background C / E']] as const;
      legend.forEach(([role,label],i)=>parts.push(text(28+i*352,96,label,16,COLORS[role])));
      batch.forEach((layout,cell)=>{
        const x=20+(cell%2)*(CARD_W+16), y=120+Math.floor(cell/2)*(CARD_H+16);
        parts.push(`<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="white" stroke="#cbd5e1"/>`,
          text(x+18,y+34,`ID ${layout.id}`,Math.min(25,Math.max(10,Math.floor(1050/(layout.id.length+3))))),text(x+18,y+61,`${layout.panels.length} panels · ${layout.canvas.width} × ${layout.canvas.height} · read P1 → P${layout.panels.length}`,17));
        const scale=Math.min((CARD_W-48)/layout.canvas.width,(CARD_H-100)/layout.canvas.height);
        const pageW=layout.canvas.width*scale, pageH=layout.canvas.height*scale;
        const pageX=x+(CARD_W-pageW)/2, pageY=y+82+(CARD_H-100-pageH)/2;
        const point=([px,py]:Point):Point=>[num(pageX+(px+layout.canvas.width/2)*scale),num(pageY+(py+layout.canvas.height/2)*scale)];
        parts.push(`<rect x="${num(pageX)}" y="${num(pageY)}" width="${num(pageW)}" height="${num(pageH)}" fill="#fff" stroke="#d2d9e2"/>`);
        const ordered=layout.panels.map((panel,index)=>({panel,index})).sort((a,b)=>(a.panel.layer ?? a.index)-(b.panel.layer ?? b.index)||a.index-b.index);
        for (const {panel,index} of ordered) {
          const frame=panel.slots.F ? outline(panel,'F').map(point) : [];
          if (frame.length) parts.push(`<polygon points="${frame.map(p=>p.join(',')).join(' ')}" fill="#f8fafc" stroke="${COLORS.frame}" stroke-width="2.5"/>`);
          const groups=new Map<string,{keys:string[];points:Point[]}>();
          for (const key of Object.keys(panel.slots).filter(key=>!['F','X'].includes(slotType(key)))) {
            const points=outline(panel,key).map(point), id=JSON.stringify(points);
            const group=groups.get(id);
            if (group) group.keys.push(key); else groups.set(id,{keys:[key],points});
          }
          const labels: {label:string;points:Point[];color:string}[]=[];
          for (const {keys,points} of groups.values()) {
            const type=slotType(keys[0]);
            const role=['T','TL','TR','B','BL','BR','ML','MR'].includes(type) ? 'text' : type==='O' ? 'auxiliary' : ['C','E'].includes(type) ? 'background' : 'subject';
            const color=COLORS[role];
            parts.push(`<polygon points="${points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-opacity="${role==='background' ? '.35' : '.8'}" stroke-width="1.4"${role==='text' ? ' stroke-dasharray="5 3"' : ''}/>`);
            labels.push({label:keys.join('/'),points,color});
          }
          // Start each panel's collision set anew: later overlaid panels obscure earlier ones.
          const local: Rect[]=[];
          for (const {label,points,color} of labels.sort((a,b)=>a.points.reduce((v,p)=>v+p[0],0)-b.points.reduce((v,p)=>v+p[0],0))) {
            const minX=Math.min(...points.map(p=>p[0])), maxX=Math.max(...points.map(p=>p[0]));
            const minY=Math.min(...points.map(p=>p[1])), maxY=Math.max(...points.map(p=>p[1]));
            const w=Math.max(23,label.length*9+8), h=20;
            const positions=[.5,.12,.88,.3,.7].flatMap(v=>[.5,.1,.9,.3,.7].map(u=>({x:minX+(maxX-minX-w)*u,y:minY+(maxY-minY-h)*v,w,h})));
            const cost=(r:Rect)=>local.reduce((sum,old)=>sum+overlap(r,old),0)+(!contains(points,r.x+r.w/2,r.y+r.h/2)?100000:0);
            const r=positions.reduce((best,next)=>cost(next)<cost(best)?next:best);
            local.push(r);
            parts.push(`<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(w)}" height="${h}" rx="3" fill="white" fill-opacity=".94"/>`,text(r.x+4,r.y+15,label,15,color));
          }
          if (frame.length) {
            const [anchor]=[...frame].sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
            const badge={x:Math.min(anchor[0]+3,pageX+pageW-49),y:anchor[1]+3,w:46,h:25};
            parts.push(`<rect x="${num(badge.x)}" y="${num(badge.y)}" width="46" height="25" rx="4" fill="${COLORS.frame}"/>`,text(badge.x+6,badge.y+19,`P${index+1}`,18,'white'));
          }
        }
      });
      parts.push(text(28,1790,'Geometry comes from saved layouts. No characters, dialogue or example actions are depicted.',15),'</svg>');
      result.push({orientation,ids:batch.map(layout=>layout.id),svg:parts.join('\n')});
    }
  }
  return result;
}

/** Browser-native PNG conversion; no upload, external renderer or new dependency. */
export async function rasterizeLayoutAtlas(svg: string): Promise<string> {
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
  try {
    const image=new Image();
    await new Promise<void>((resolve,reject)=>{ image.onload=()=>resolve(); image.onerror=()=>reject(new Error('版式拼图渲染失败')); image.src=url; });
    const canvas=document.createElement('canvas'); canvas.width=WIDTH; canvas.height=HEIGHT;
    const context=canvas.getContext('2d'); if (!context) throw new Error('浏览器不支持版式拼图渲染');
    context.drawImage(image,0,0);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
