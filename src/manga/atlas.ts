import { mangaGridRegions, mangaPanelReadingOrder, slotType, type MangaOrientation, type MangaPanel, type ResolvedLayout } from '@/manga/layouts';
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
        '\n图册不授予本轮选择权限，实际选版必须服从本轮文字白名单。图中 panel 编号对应 item.panel，箭头连接编号表示读序；紫色虚线为可用 G，灰斜纹与“不可用”标牌表示整项 G 禁用，同处其他合法槽位不受影响。只参考几何，不把图例、箭头或标签画进作品。'+
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
const COLORS = { frame: '#34465b', subject: '#2463b3', text: '#b66c13', auxiliary: '#8c3ab0', background: '#728095', grid: '#9676ba', reading: '#e24735' };
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

function bounds(points: Point[]): Rect {
  const x=Math.min(...points.map(p=>p[0])), y=Math.min(...points.map(p=>p[1]));
  return {x,y,w:Math.max(...points.map(p=>p[0]))-x,h:Math.max(...points.map(p=>p[1]))-y};
}
const center=(r:Rect):Point=>[r.x+r.w/2,r.y+r.h/2];
const samples=(r:Rect):Point[]=>[0,.5,1].flatMap(v=>[0,.5,1].map(u=>[r.x+r.w*u,r.y+r.h*v]));
const polygon=(points:Point[],attrs:string)=>`<polygon points="${points.map(p=>p.map(num).join(',')).join(' ')}" ${attrs}/>`;
const rect=(r:Rect,attrs:string)=>`<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" ${attrs}/>`;

/** Keep the disabled highlight and its callout target inside the convex saved F outline. */
function clipped(points:Point[],frame:Point[]):Point[] {
  const area=frame.reduce((sum,[x,y],i)=>sum+x*frame[(i+1)%frame.length][1]-frame[(i+1)%frame.length][0]*y,0);
  const sign=area>=0?1:-1;
  let result=points;
  for (let i=0;i<frame.length && result.length;i++) {
    const a=frame[i],b=frame[(i+1)%frame.length];
    const side=(p:Point)=>sign*((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]));
    const input=result;result=[];
    for (let j=0;j<input.length;j++) {
      const p=input[(j+input.length-1)%input.length],q=input[j],dp=side(p),dq=side(q);
      if ((dp>=0)!==(dq>=0)) {const t=dp/(dp-dq);result.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t]);}
      if (dq>=0) result.push(q);
    }
  }
  return result;
}

function positions(points:Point[],w:number,h:number,centered=false):Rect[] {
  const box=bounds(points);
  const fractions=centered ? [.5,.12,.88,.3,.7,0,1] : [0,.5,1,.25,.75,.12,.88];
  return fractions.flatMap(v=>fractions.map(u=>({x:box.x+Math.max(0,box.w-w)*u,y:box.y+Math.max(0,box.h-h)*v,w,h})));
}
function place(points:Point[],w:number,h:number,occupied:Rect[],visible:(p:Point)=>boolean,near?:Point):Rect|undefined {
  const options=positions(points,w,h,!!near);
  if (near) options.sort((a,b)=>Math.hypot(...center(a).map((n,i)=>n-near[i]))-Math.hypot(...center(b).map((n,i)=>n-near[i])));
  return options.find(r=>samples(r).every(p=>contains(points,p[0],p[1]) && visible(p)) && occupied.every(old=>overlap(r,old)===0));
}

function edge(r:Rect,towards:Point):Point {
  const [x,y]=center(r),dx=towards[0]-x,dy=towards[1]-y;
  const t=1/Math.max(Math.abs(dx)/(r.w/2+3),Math.abs(dy)/(r.h/2+3),.001);
  return [x+dx*t,y+dy*t];
}
const pathData=(path:Point[])=>path.map(([x,y],i)=>`${i?'L':'M'}${num(x)},${num(y)}`).join(' ');

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
        text(28,66,'F = full frame · panel # = item.panel · arrows = order · dashed G = usable · hatched G = disabled',16),
        `<defs><pattern id="g-disabled" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(40)"><rect width="6" height="6" fill="#dce0e6"/><path d="M0 0V6" stroke="#858e9b" stroke-width="1.7"/></pattern><marker id="reading-head" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" orient="auto"><path d="M1 1L9 5L1 9L3 5Z" fill="${COLORS.reading}"/></marker></defs>`,
      ];
      const present=new Set(batch.flatMap(layout=>layout.panels.flatMap(panel=>Object.keys(panel.slots).map(slotType))));
      const legend: [keyof typeof COLORS,string][]=[
        ['subject',`Subject ${['S','L','R'].filter(key=>present.has(key)).join(' / ')}`],
        ['text',`Text ${['T','TL','TR','B','BL','BR','ML','MR'].filter(key=>present.has(key)).join(' / ')}`],
        ['auxiliary',present.has('O') ? 'Auxiliary O' : ''],
        ['background',[present.has('C') ? 'Inner content C' : '',present.has('E') ? 'Edge overlap E' : ''].filter(Boolean).join(' / ')],
      ];
      legend.filter(([,label])=>label && !/^(Subject|Text) $/.test(label)).forEach(([role,label],i)=>parts.push(text(28+i*352,96,label,Math.min(16,Math.floor(510/label.length)),COLORS[role])));
      batch.forEach((layout,cell)=>{
        const x=20+(cell%2)*(CARD_W+16), y=120+Math.floor(cell/2)*(CARD_H+16);
        parts.push(`<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="white" stroke="#cbd5e1"/>`,
          text(x+18,y+34,`ID ${layout.id}`,Math.min(25,Math.max(10,Math.floor(1050/(layout.id.length+3))))),text(x+18,y+61,`${layout.panels.length} panels · ${layout.canvas.width} × ${layout.canvas.height} · read ${mangaPanelReadingOrder(layout).map(i=>i+1).join(' → ')}`,17));
        const scale=Math.min((CARD_W-48)/layout.canvas.width,(CARD_H-100)/layout.canvas.height);
        const pageW=layout.canvas.width*scale, pageH=layout.canvas.height*scale;
        const pageX=x+(CARD_W-pageW)/2, pageY=y+82+(CARD_H-100-pageH)/2;
        const point=([px,py]:Point):Point=>[num(pageX+(px+layout.canvas.width/2)*scale),num(pageY+(py+layout.canvas.height/2)*scale)];
        parts.push(`<rect x="${num(pageX)}" y="${num(pageY)}" width="${num(pageW)}" height="${num(pageH)}" fill="#fff" stroke="#d2d9e2"/>`);
        const ordered=layout.panels.map((panel,index)=>({panel,index,frame:panel.slots.F ? outline(panel,'F').map(point) : []})).sort((a,b)=>(a.panel.layer ?? a.index)-(b.panel.layer ?? b.index)||a.index-b.index);
        const occupied:Rect[]=[],badges=new Map<number,{box:Rect;external:boolean;anchor:Point}>();
        const labelRequests:{label:string;points:Point[];color:string;index:number;grid:boolean;disabled?:boolean;anchor?:Point}[]=[];
        const visible=(index:number,p:Point)=>{
          const at=ordered.findIndex(item=>item.index===index),frame=ordered[at].frame;
          return (!frame.length || contains(frame,p[0],p[1])) && !ordered.slice(at+1).some(item=>item.frame.length && contains(item.frame,p[0],p[1]));
        };
        // Reserve panel badges before slot labels, in the visible part of each saved frame.
        for (const {index,frame} of [...ordered].reverse()) {
          if (!frame.length) continue;
          const padded=bounds(frame), inset=4;
          const inner=[[padded.x+inset,padded.y+inset],[padded.x+padded.w-inset,padded.y+inset],[padded.x+padded.w-inset,padded.y+padded.h-inset],[padded.x+inset,padded.y+padded.h-inset]];
          let box=place(inner,68,24,occupied,p=>visible(index,p));
          const external=!box;
          if (!box) {
            const options=positions([[x+8,y+76],[x+CARD_W-8,y+76],[x+CARD_W-8,y+CARD_H-8],[x+8,y+CARD_H-8]],68,24);
            const cost=(r:Rect)=>occupied.reduce((sum,old)=>sum+overlap(r,old)*10000,0)+samples(r).filter(p=>ordered.some(item=>item.frame.length && contains(item.frame,p[0],p[1]))).length*1000+Math.hypot(...center(r).map((n,i)=>n-center(padded)[i]));
            box=options.reduce((best,next)=>cost(next)<cost(best)?next:best);
          }
          occupied.push(box);badges.set(index,{box,external,anchor:center(padded)});
        }
        const reading=mangaPanelReadingOrder(layout),arrows:{from:number;to:number;points:Point[]}[]=[];
        for (let i=1;i<reading.length;i++) {
          const from=badges.get(reading[i-1])?.box,to=badges.get(reading[i])?.box;
          if (from && to) arrows.push({from:reading[i-1]+1,to:reading[i]+1,points:[edge(from,center(to)),edge(to,center(from))]});
        }
        for (const {panel,index,frame} of ordered) {
          if (frame.length) parts.push(`<polygon data-panel-frame="${index+1}" points="${frame.map(p=>p.join(',')).join(' ')}" fill="#f8fafc" stroke="${COLORS.frame}" stroke-width="2.5"/>`);
          if (frame.length) {
            const clip=`frame-${cell}-${index}`,mask=`visible-${cell}-${index}`,at=ordered.findIndex(item=>item.index===index);
            parts.push(`<defs><clipPath id="${clip}">${polygon(frame,'')}</clipPath><mask id="${mask}" maskUnits="userSpaceOnUse" x="${pageX-8}" y="${pageY-8}" width="${pageW+16}" height="${pageH+16}">${polygon(frame,'fill="white"')}${ordered.slice(at+1).filter(item=>item.frame.length).map(item=>polygon(item.frame,'fill="black"')).join('')}</mask></defs>`);
            const grid=mangaGridRegions(panel),[t,l,b,r]=panel.slots.F;
            parts.push(`<g clip-path="url(#${clip})" data-grid-panel="${index+1}">`);
            for (let i=0;i<9;i++) {
              const key=`G${i+1}`;
              if (panel.slots[key]) continue; // Saved custom G slots keep their original geometry and role.
              const box=grid[key],available=!!box;
              const nominal=[Math.round(t+(b-t)*Math.floor(i/3)/3),Math.round(l+(r-l)*(i%3)/3),Math.round(t+(b-t)*(Math.floor(i/3)+1)/3),Math.round(l+(r-l)*(i%3+1)/3)];
              const [top,left,bottom,right]=box ?? nominal;
              const nominalPoints=[[left,top],[right,top],[right,bottom],[left,bottom]].map(point);
              const points=available?nominalPoints:clipped(nominalPoints,frame);
              parts.push(polygon(points,`data-grid="${key}" data-panel="${index+1}" data-state="${available?'available':'unavailable'}" ${available ? `fill="none" stroke="${COLORS.grid}" stroke-opacity=".65" stroke-width=".9" stroke-dasharray="4 3"` : 'fill="url(#g-disabled)" stroke="#596371" stroke-width="1.6" stroke-dasharray="4 2"'}`));
              const anchor=!available && points.length ? [0,1].map(axis=>points.reduce((sum,p)=>sum+p[axis],0)/points.length) : undefined;
              labelRequests.push({label:available?key:`${key} 不可用`,points:points.length?points:nominalPoints,color:available?COLORS.grid:'#4b5563',index,grid:true,disabled:!available,anchor});
            }
            parts.push('</g>');
          }
          const groups=new Map<string,{keys:string[];points:Point[]}>();
          for (const key of Object.keys(panel.slots).filter(key=>!['F','X'].includes(slotType(key)))) {
            const points=outline(panel,key).map(point), id=JSON.stringify(points);
            const group=groups.get(id);
            if (group) group.keys.push(key); else groups.set(id,{keys:[key],points});
          }
          for (const {keys,points} of groups.values()) {
            const type=slotType(keys[0]);
            const role=['T','TL','TR','B','BL','BR','ML','MR'].includes(type) ? 'text' : type==='O' ? 'auxiliary' : ['C','E'].includes(type) ? 'background' : 'subject';
            const color=COLORS[role];
            parts.push(`<polygon points="${points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-opacity="${role==='background' ? '.35' : '.8'}" stroke-width="1.4"${role==='text' ? ' stroke-dasharray="5 3"' : ''}/>`);
            labelRequests.push({label:keys.join('/'),points,color,index,grid:false});
          }
        }
        // Annotation order: saved geometry/grid, direct reading arrows, opaque labels, panel badges.
        for (const {from,to,points} of arrows) {
          const d=pathData(points);
          parts.push(`<path d="${d}" fill="none" stroke="white" stroke-width="9" stroke-linecap="round"/>`,
            `<path data-read-from="${from}" data-read-to="${to}" d="${d}" fill="none" stroke="${COLORS.reading}" stroke-width="4" stroke-linecap="round" marker-end="url(#reading-head)"/>`);
        }
        const callouts:string[]=[],slotLabels:string[]=[];
        for (const {label,points,color,index,grid,disabled,anchor:target} of labelRequests.sort((a,b)=>Number(!!b.disabled)-Number(!!a.disabled)||Number(b.grid)-Number(a.grid))) {
          const w=disabled?70:Math.max(22,label.length*(grid?6.3:7)+7),h=disabled?20:grid?15:17,anchor=target??center(bounds(points));
          let box=place(points,w,h,occupied,p=>visible(index,p),anchor);
          const displaced=!box;
          const frame=ordered.find(item=>item.index===index)!.frame;
          box ??= frame.length ? place(frame,w,h,occupied,p=>visible(index,p),anchor) : undefined;
          const external=!box;
          let shown=label;
          if (!box) {
            shown=`${index+1}:${label}`;
            const ew=w+14,options:Rect[]=[];
            for (let row=y+88;row<y+CARD_H-22;row+=19) for (const left of [x+8,x+CARD_W-ew-8]) options.push({x:left,y:row,w:ew,h});
            options.sort((a,b)=>Math.hypot(...center(a).map((n,i)=>n-anchor[i]))-Math.hypot(...center(b).map((n,i)=>n-anchor[i])));
            box=options.find(r=>occupied.every(old=>overlap(r,old)===0));
            box ??= options.reduce((best,next)=>occupied.reduce((s,r)=>s+overlap(next,r),0)<occupied.reduce((s,r)=>s+overlap(best,r),0)?next:best);
          }
          occupied.push(box);
          if (displaced) {
            const from=edge(box,anchor);
            callouts.push(`<path data-slot-leader="${escape(label)}" d="M${from.map(num).join(',')} L${anchor.map(num).join(',')}" fill="none" stroke="${color}" stroke-opacity=".45" stroke-width=".7"${external?'':` mask="url(#visible-${cell}-${index})"`}/>`);
          }
          slotLabels.push(rect(box,`rx="${disabled?3:2}" fill="${disabled?'#4b5563':'white'}"${disabled?' stroke="white" stroke-width="1"':''} data-slot-label="${escape(label)}" data-panel="${index+1}"`),text(box.x+3,box.y+(disabled?14:grid?11.5:13),shown,disabled?12:grid?11:12,disabled?'white':color));
        }
        parts.push(...callouts,...slotLabels);
        for (const [index,{box,external,anchor}] of badges) {
          if (external) parts.push(`<path d="M${center(box).map(num).join(',')} L${anchor.map(num).join(',')}" stroke="${COLORS.frame}" stroke-width="1"/>`);
          parts.push(rect(box,`rx="4" fill="${COLORS.frame}" data-panel-badge="${index+1}" data-placement="${external?'external':'internal'}"`),text(box.x+6,box.y+17,`panel ${index+1}`,15,'white'));
        }
      });
      parts.push(text(28,1790,'Annotations only · n:key belongs to panel n · saved geometry unchanged · do not draw labels or arrows in artwork.',15),'</svg>');
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
