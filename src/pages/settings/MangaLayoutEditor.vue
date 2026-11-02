<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import ModalMask from '@/components/ModalMask.vue';
import { canvasOf, normalizeCanvas, orientationOf, parseCustomLayout, slotType, type MangaCustomLayout, type ResolvedLayout } from '@/manga/layouts';
import { clamp, deformCorner, editablePanel, fitRect, MIN_PANEL, panelRect, quadPoints, saveEditedPanel, setSlotRect, slotRect, snapRect, type EditablePanel, type PanelRect } from '@/manga/editor';

const props = defineProps<{ sources: (ResolvedLayout & { key: string })[]; existingIds: string[]; initialKey?: string; editingId?: string }>();
const emit = defineEmits<{ close: []; save: [layout: MangaCustomLayout] }>();
interface LayoutDocument { id: string; label: string; usage: string; width: number; height: number; panels: EditablePanel[] }
function unusedId(base: string): string {
  let id = base, suffix = 2;
  while (props.existingIds.includes(id)) id = `${base}_${suffix++}`;
  return id;
}
const doc = ref<LayoutDocument>({ id: unusedId('my_layout'), label: '自定义版式', usage: '', width: 1088, height: 1920, panels: [] });
const selected = ref(-1);
const selectedSlot = ref('');
const sourceKey = ref(props.initialKey ?? '');
const snap = ref(true);
const slotsPreview = ref(true);
const error = ref('');
const discard = ref(false);
const dialog = ref<HTMLElement>();
const svg = ref<SVGSVGElement>();
const canvasViewport = ref<HTMLElement>();
const canvasZoom = ref(1);
const quickEdit = ref<{index:number; key:string} | null>(null);
const quickDraft = ref('');
const quickField = ref<HTMLTextAreaElement>();
const canvasWidth = ref(1088), canvasHeight = ref(1920);
const undoStack = ref<string[]>([]), redoStack = ref<string[]>([]);
const baseline = ref('');
const current = computed(() => doc.value.panels[selected.value]);
const activeRect = computed(() => current.value ? selectedSlot.value && current.value.slots[selectedSlot.value] ? slotRect(current.value, selectedSlot.value) : current.value : null);
const slotLabels: Record<string,string> = { C:'内区', S:'主体', T:'顶部文字', B:'底部文字', TL:'左上文字', TR:'右上文字', BL:'左下文字', BR:'右下文字', L:'左人物', R:'右人物', O:'道具/音效', ML:'左侧文字', MR:'右侧文字', E:'有限越线' };
const slotPickerOpen = ref(false);
const availableSlots = computed(() => current.value ? Object.keys(editablePanel(current.value, canvas.value).slots) : []);
let slotSession: { before: string; undo: string[]; redo: string[] } | null = null;
function confirmSlot(): void {
  slotSession = null; selectedSlot.value = '';
}
function cancelSlot(): void {
  if (slotSession) {
    const session = slotSession;
    restore(session.before);
    undoStack.value = session.undo; redoStack.value = session.redo;
  }
  confirmSlot();
}
function selectPanel(index: number): void { confirmSlot(); selected.value = index; slotPickerOpen.value = false; }
function selectSlot(index: number, key: string): void {
  if (selected.value === index && selectedSlot.value === key) return;
  selectPanel(index);
  if (key && current.value?.slots[key]) {
    slotSession = { before: snapshot(), undo: [...undoStack.value], redo: [...redoStack.value] };
    selectedSlot.value = key; slotsPreview.value = true;
  }
}
function setActiveRect(rect: PanelRect): void {
  if (!current.value) return;
  if (selectedSlot.value) setSlotRect(current.value, selectedSlot.value, rect);
  else doc.value.panels[selected.value] = { ...current.value, ...rect };
}
function deleteSlot(): void {
  const key = selectedSlot.value;
  if (current.value && key) edit(() => { delete current.value!.slots[key]; delete current.value!.corners[key]; if (current.value!.slotNotes) delete current.value!.slotNotes[key]; });
}
function resetSlots(): void {
  if (current.value) edit(() => { current.value!.slots = editablePanel(current.value!, canvas.value).slots; current.value!.corners = current.value!.corners.F ? { F:current.value!.corners.F } : {}; selectedSlot.value = ''; });
  slotPickerOpen.value = false;
}
function addSlot(key: string): void {
  if (!current.value || !availableSlots.value.includes(key)) return;
  const base=key;
  let suffix=2;
  while (current.value.slots[key]) key=`${base}_${suffix++}`;
  edit(() => {
    const panel=current.value!, template=slotRect(editablePanel(panel,canvas.value),base);
    const offset=24*Object.keys(panel.slots).filter(name=>slotType(name)===base).length;
    setSlotRect(panel,key,fitRect({...template,x:template.x+offset,y:template.y+offset},canvas.value,1));
  });
  selectSlot(selected.value, key);
}
function addAllSlots(): void {
  if (!current.value) return;
  edit(() => {
    const panel = current.value!;
    for (const [key, rect] of Object.entries(editablePanel(panel, canvas.value).slots)) {
      if (!panel.slots[key]) panel.slots[key] = { ...rect };
    }
    slotsPreview.value = true;
  });
  slotPickerOpen.value = false;
}
function visibleSlots(panel: EditablePanel, index: number): { key: string; rect: PanelRect }[] {
  if (!slotsPreview.value) return [];
  return Object.keys(panel.slots)
    .sort((a,b) => Number(index === selected.value && a === selectedSlot.value) - Number(index === selected.value && b === selectedSlot.value)).map(key => ({ key, rect: slotRect(panel,key) }));
}
const canvas = computed(() => ({ width: doc.value.width, height: doc.value.height }));
const drawn = computed(() => doc.value.panels.map((rect, index) => ({ rect, index })).sort((a, b) => (a.rect.layer ?? a.index) - (b.rect.layer ?? b.index) || a.index-b.index));
const selectedLayer = computed(() => drawn.value.findIndex(item => item.index === selected.value));
function moveLayer(delta: number): void {
  const rank = selectedLayer.value, to = rank + delta;
  if (rank < 0 || to < 0 || to >= drawn.value.length) return;
  const ordered = [...drawn.value];
  [ordered[rank], ordered[to]] = [ordered[to], ordered[rank]];
  edit(() => { ordered.forEach(({rect},layer) => { rect.layer = layer; }); });
}
const snapshot = (): string => JSON.stringify(doc.value);
const positions = computed(() => {
  const used = new Set(doc.value.panels.map(panel=>panel.position).filter(Boolean));
  return doc.value.panels.map((panel,index) => {
    if (panel.position) return panel.position;
    let suffix=index+1;
    while (used.has(`panel-${suffix}`)) suffix++;
    const name=`panel-${suffix}`; used.add(name); return name;
  });
});
function remember(before: string): void {
  if (before === snapshot()) return;
  undoStack.value.push(before);
  if (undoStack.value.length > 100) undoStack.value.shift();
  redoStack.value = [];
  error.value = '';
}
function edit(action: () => void, slotEdit = false): void { if (!slotEdit) confirmSlot(); const before = snapshot(); action(); remember(before); }
function restore(value: string): void {
  doc.value = JSON.parse(value);
  canvasWidth.value = doc.value.width; canvasHeight.value = doc.value.height;
  selected.value = Math.min(selected.value, doc.value.panels.length - 1);
  if (!current.value?.slots[selectedSlot.value]) selectedSlot.value = '';
  error.value = ''; discard.value = false;
  slotPickerOpen.value = false;
}
function undo(): void { confirmSlot(); const before = undoStack.value.pop(); if (before) { redoStack.value.push(snapshot()); restore(before); } }
function redo(): void { confirmSlot(); const after = redoStack.value.pop(); if (after) { undoStack.value.push(snapshot()); restore(after); } }
function loadSource(): void {
  const source = props.sources.find(item => item.key === sourceKey.value);
  if (!source) return;
  edit(() => {
    const editing = source.id === props.editingId;
    doc.value = { id: editing ? source.id : unusedId(`${source.id}_copy`), label: editing ? source.label : `${source.label}（副本）`, usage: source.usage ?? '', ...source.canvas, panels: source.panels.map((panel,index) => ({...editablePanel(panelRect(panel, source.canvas), source.canvas, panel), layer:panel.layer ?? index})) };
  });
  canvasWidth.value = doc.value.width; canvasHeight.value = doc.value.height;
  selectPanel(doc.value.panels.length ? 0 : -1);
}
function resizeCanvas(): void {
  const size = normalizeCanvas({ width: canvasWidth.value, height: canvasHeight.value });
  if (!size) { error.value = '画布宽高须为 64～8192 的偶数。'; return; }
  edit(() => {
    const old = canvas.value;
    doc.value.panels = doc.value.panels.map(p => ({ ...fitRect({ x: p.x * size.width / old.width, y: p.y * size.height / old.height, width: p.width * size.width / old.width, height: p.height * size.height / old.height }, size), slots: p.slots, corners:p.corners, layer:p.layer, position:p.position, ...(p.slotNotes ? { slotNotes:p.slotNotes } : {}) }));
    Object.assign(doc.value, size);
  });
}
function preset(width: number, height: number): void { canvasWidth.value = width; canvasHeight.value = height; resizeCanvas(); }
function add(): void {
  edit(() => {
    const offset = (doc.value.panels.length % 5) * .04;
    const panel = editablePanel(fitRect({ x: doc.value.width * (.08 + offset), y: doc.value.height * (.08 + offset), width: doc.value.width * .55, height: doc.value.height * .3 }, canvas.value), canvas.value);
    panel.slots = {};
    doc.value.panels.push({...panel, layer:Math.max(-1,...doc.value.panels.map((p,i)=>p.layer ?? i))+1});
    selectPanel(doc.value.panels.length - 1);
  });
}
function remove(): void { if (current.value) edit(() => { doc.value.panels.splice(selected.value, 1); selectPanel(Math.min(selected.value, doc.value.panels.length - 1)); }); }
function duplicate(): void { if (current.value) edit(() => { doc.value.panels.push({ ...fitRect({ ...current.value!, x: current.value!.x + 24, y: current.value!.y + 24 }, canvas.value), slots: JSON.parse(JSON.stringify(current.value!.slots)), corners:JSON.parse(JSON.stringify(current.value!.corners)), ...(current.value!.slotNotes ? { slotNotes:{...current.value!.slotNotes} } : {}), layer:Math.max(-1,...doc.value.panels.map((p,i)=>p.layer ?? i))+1 }); selectPanel(doc.value.panels.length - 1); }); }
function reorder(delta: number): void {
  const to = selected.value + delta;
  if (!current.value || to < 0 || to >= doc.value.panels.length) return;
  edit(() => { const [p] = doc.value.panels.splice(selected.value, 1); doc.value.panels.splice(to, 0, p); selected.value = to; });
}
function changeRect(key: keyof PanelRect, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (activeRect.value && Number.isFinite(value)) edit(() => { setActiveRect(fitRect({ ...activeRect.value!, [key]: value }, canvas.value, selectedSlot.value ? 1 : MIN_PANEL)); }, true);
}
function changeText(key: 'id' | 'label' | 'usage', event: Event): void { edit(() => { doc.value[key] = (event.target as HTMLInputElement).value; }); }
function changeSlotNote(event: Event): void {
  if (!current.value) return;
  const key = selectedSlot.value || 'F', note = (event.target as HTMLTextAreaElement).value;
  edit(() => {
    if (note) (current.value!.slotNotes ??= {})[key] = note;
    else if (current.value!.slotNotes) delete current.value!.slotNotes[key];
  }, true);
}

function frameDescription(panel: EditablePanel, key: string): string { return panel.slotNotes?.[key] ?? ''; }
function openDescription(index: number, key: string): void {
  if (gesture) return;
  selectSlot(index,key==='F'?'':key);
  quickEdit.value={index,key};quickDraft.value=frameDescription(doc.value.panels[index],key);
  void nextTick(()=>quickField.value?.focus());
}
function saveQuickDescription(): void {
  if (!quickEdit.value) return;
  const {index,key}=quickEdit.value;
  edit(()=>{
    const panel=doc.value.panels[index];
    if (quickDraft.value) (panel.slotNotes ??= {})[key]=quickDraft.value;
    else if (panel.slotNotes) delete panel.slotNotes[key];
  },true);
  quickEdit.value=null;
}
function previewDescription(panel: EditablePanel, key: string): string {
  const text=frameDescription(panel,key).replace(/\s+/g,' ').trim();
  return text.length>80?text.slice(0,80)+'…':text;
}
function quickKeydown(event: KeyboardEvent): void {
  if (event.key!=='Tab') return;
  const items=[...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button,textarea')];
  const root=dialog.value?.getRootNode() as Document | ShadowRoot | undefined;
  const next=event.shiftKey && root?.activeElement===items[0] ? items.at(-1) : !event.shiftKey && root?.activeElement===items.at(-1) ? items[0] : undefined;
  if (next) { event.preventDefault();next.focus(); }
}

let gesture: { pointerId: number; x: number; y: number; clientX:number; clientY:number; dragging:boolean; rect: PanelRect; before: string; handle: string; quad:number[][]; deform:boolean } | null = null;
function zoomCanvas(event: WheelEvent): void {
  if (!event.ctrlKey || !event.deltaY) return;
  event.preventDefault();event.stopPropagation();
  if (gesture || !svg.value || !canvasViewport.value) return;
  const viewport=canvasViewport.value, before=svg.value.getBoundingClientRect();
  const x=(event.clientX-before.left)/before.width, y=(event.clientY-before.top)/before.height;
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1);
  canvasZoom.value=clamp(canvasZoom.value*Math.exp(-delta*.002),.25,4);
  void nextTick(()=>{
    const after=svg.value?.getBoundingClientRect();
    if (after) { viewport.scrollLeft+=after.left+x*after.width-event.clientX;viewport.scrollTop+=after.top+y*after.height-event.clientY; }
  });
}
function point(event: PointerEvent): { x: number; y: number } {
  const rect = svg.value!.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width * doc.value.width, y: (event.clientY - rect.top) / rect.height * doc.value.height };
}
function begin(event: PointerEvent, index: number, handle = '', slot = ''): void {
  if (event.button !== 0 || gesture) return;
  selectSlot(index, slot);
  gesture = { pointerId: event.pointerId, ...point(event), clientX:event.clientX, clientY:event.clientY, dragging:false, rect: { ...activeRect.value! }, before: snapshot(), handle, quad:quadPoints(current.value!,slot || 'F'), deform:event.ctrlKey && handle.length===2 };
}
function move(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const p = point(event), g = gesture, dx = p.x - g.x, dy = p.y - g.y;
  // Delay capture until a real drag so stationary clicks reach the frame's dblclick handler.
  if (!g.dragging) {
    if (Math.hypot(event.clientX-g.clientX,event.clientY-g.clientY)<3) return;
    g.dragging=true;svg.value!.setPointerCapture(event.pointerId);
  }
  const minimum = selectedSlot.value ? 1 : MIN_PANEL;
  if (g.deform) {
    const index = ['nw','ne','se','sw'].indexOf(g.handle);
    const points = g.quad.map((p,i) => i===index ? [p[0]+dx,p[1]+dy] : p);
    deformCorner(current.value!,selectedSlot.value || 'F',points,canvas.value);
    return;
  }
  let rect = { ...g.rect };
  if (!g.handle) { rect.x += dx; rect.y += dy; }
  else {
    if (g.handle.includes('w')) { rect.x = clamp(g.rect.x + dx, 0, g.rect.x + g.rect.width - minimum); rect.width = g.rect.x + g.rect.width - rect.x; }
    if (g.handle.includes('n')) { rect.y = clamp(g.rect.y + dy, 0, g.rect.y + g.rect.height - minimum); rect.height = g.rect.y + g.rect.height - rect.y; }
    if (g.handle.includes('e')) rect.width = clamp(g.rect.width + dx, minimum, doc.value.width - rect.x);
    if (g.handle.includes('s')) rect.height = clamp(g.rect.height + dy, minimum, doc.value.height - rect.y);
  }
  rect = fitRect(rect, canvas.value, minimum);
  const others = selectedSlot.value ? [current.value!, ...Object.keys(current.value!.slots).filter(key => key !== selectedSlot.value).map(key => slotRect(current.value!, key))] : doc.value.panels.filter((_, i) => i !== selected.value);
  const unsnapped = { ...rect };
  if (snap.value && !event.altKey) rect = snapRect(rect, canvas.value, others, 6 * doc.value.width / svg.value!.getBoundingClientRect().width, !!g.handle, minimum);
  if (g.handle === 'e' || g.handle === 'w') { rect.y = unsnapped.y; rect.height = unsnapped.height; }
  if (g.handle === 'n' || g.handle === 's') { rect.x = unsnapped.x; rect.width = unsnapped.width; }
  setActiveRect(rect);
}
function end(event: PointerEvent, cancel = false): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const before = gesture.before;
  gesture = null;
  if (svg.value?.hasPointerCapture(event.pointerId)) svg.value.releasePointerCapture(event.pointerId);
  if (cancel) restore(before); else remember(before);
}
function handles(): { name: string; x: number; y: number }[] {
  const points = quadPoints(current.value!, selectedSlot.value || 'F');
  return ['nw','ne','se','sw'].flatMap((name,i) => [{ name, x:points[i][0], y:points[i][1] }, { name:['n','e','s','w'][i], x:(points[i][0]+points[(i+1)%4][0])/2, y:(points[i][1]+points[(i+1)%4][1])/2 }]);
}
function polygon(panel: EditablePanel, key: string): string { return quadPoints(panel,key).map(p=>p.join(',')).join(' '); }
function requestClose(): void {
  if (snapshot() !== baseline.value || canvasWidth.value !== doc.value.width || canvasHeight.value !== doc.value.height) discard.value = true;
  else emit('close');
}
function keydown(event: KeyboardEvent): void {
  if (quickEdit.value) return;
  if (event.key === 'Tab' && dialog.value) {
    const items = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]')];
    const root = dialog.value.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement;
    if (event.shiftKey && (active === items[0] || active === dialog.value)) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && active === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
  }
  if (event.key === 'Escape') { event.stopPropagation(); requestClose(); return; }
  if ((event.target as HTMLElement).matches('input,textarea,select,button')) return;
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault(); if (event.key.toLowerCase() === 'y' || event.shiftKey) redo(); else undo();
  } else if (event.key === 'Delete') { event.preventDefault(); if (selectedSlot.value) deleteSlot(); else remove(); }
  else if (activeRect.value && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const d = event.shiftKey ? 10 : 1;
    edit(() => { setActiveRect(fitRect({ ...activeRect.value!, x: activeRect.value!.x + (event.key === 'ArrowRight' ? d : event.key === 'ArrowLeft' ? -d : 0), y: activeRect.value!.y + (event.key === 'ArrowDown' ? d : event.key === 'ArrowUp' ? -d : 0) }, canvas.value, selectedSlot.value ? 1 : MIN_PANEL)); }, true);
  }
}
function save(): void {
  if (canvasWidth.value !== doc.value.width || canvasHeight.value !== doc.value.height) { error.value = '画布尺寸已修改，请先点击“应用尺寸”。'; return; }
  if (!doc.value.id.trim() || (props.existingIds.includes(doc.value.id.trim()) && doc.value.id.trim() !== props.editingId)) { error.value = '请填写未使用的版式 ID，或保留正在编辑的版式 ID。'; return; }
  if (!doc.value.panels.length) { error.value = '请至少添加一格。'; return; }
  try {
    const orientation = orientationOf(doc.value.width, doc.value.height);
    const standard = canvasOf(orientation);
    if (doc.value.id.trim() === props.editingId && props.sources.some(source => {
      const sourceOrientation = orientationOf(source.canvas.width, source.canvas.height);
      const sourceStandard = canvasOf(sourceOrientation);
      return source.id === props.editingId && sourceOrientation !== orientation && (doc.value.width !== standard.width || doc.value.height !== standard.height || source.canvas.width !== sourceStandard.width || source.canvas.height !== sourceStandard.height);
    })) {
      error.value = '此版式含另一画布方向。请保持标准画布尺寸，或从“快捷自定义”新建独立版式后再调整非标准尺寸。'; return;
    }
    const layout = parseCustomLayout(JSON.stringify({ id: doc.value.id.trim(), label: doc.value.label.trim() || doc.value.id.trim(), usage: doc.value.usage.trim(), canvas: canvas.value, readingOrder: positions.value.join(' → '), [orientation]: doc.value.panels.map((r, i) => saveEditedPanel(r, canvas.value, positions.value[i])) }));
    emit('save', layout);
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
onMounted(() => {
  if (props.initialKey) loadSource();
  undoStack.value = []; redoStack.value = []; baseline.value = snapshot();
  void nextTick(() => dialog.value?.focus());
});
</script>

<template>
  <ModalMask :open="true" top-layer @close="requestClose">
    <section ref="dialog" class="manga-designer" role="dialog" aria-modal="true" aria-label="快捷自定义版式" tabindex="-1" @keydown="keydown">
      <header>
        <strong>{{ editingId ? '可视化编辑版式' : '快捷自定义版式' }}</strong>
        <div class="inline editor-actions">
          <button type="button" @click="requestClose">取消</button>
          <button type="button" class="primary" @click="save">{{ editingId ? '保存版式修改' : '保存为自定义版式' }}</button>
          <button type="button" aria-label="关闭编辑器" @click="requestClose">✕</button>
        </div>
      </header>
      <div class="canvas-controls">
        <label>画布宽 <input v-model.number="canvasWidth" aria-label="画布宽" type="number" min="64" max="8192" step="2" /></label>
        <label>画布高 <input v-model.number="canvasHeight" aria-label="画布高" type="number" min="64" max="8192" step="2" /></label>
        <button type="button" @click="resizeCanvas">应用尺寸</button>
        <button type="button" @click="preset(1088,1920)">1088×1920</button><button type="button" @click="preset(1920,1088)">1920×1088</button><button type="button" @click="preset(1024,1024)">1024×1024</button>
      </div>
      <p class="hint">改变画布尺寸会等比例换算各轴坐标。工作流与预设尺寸须与此画布一致；插件不自动更改工作流。</p>
      <div class="designer-body">
        <aside class="tools">
          <label>从现有版式复制<select v-model="sourceKey" aria-label="源版式"><option value="">请选择</option><option v-for="source in sources" :key="source.key" :value="source.key">{{ source.label }} · {{ source.canvas.width }}×{{ source.canvas.height }}</option></select></label>
          <button type="button" :disabled="!sourceKey" @click="loadSource">载入副本</button>
          <button type="button" @click="add">＋ 新增分格</button>
          <button type="button" :disabled="!current" @click="duplicate">复制选中分格</button>
          <button type="button" :disabled="!current" @click="remove">删除选中分格</button>
          <button type="button" :disabled="!current" title="为选中分格补齐所有默认内框，保留已有槽位的位置、形状和说明" @click="addAllSlots">一键添加所有槽位</button>
          <div class="inline"><button type="button" :disabled="!undoStack.length" @click="undo">撤销</button><button type="button" :disabled="!redoStack.length" @click="redo">重做</button></div>
          <label class="check"><input v-model="snap" type="checkbox" />对齐吸附</label>
          <label class="check"><input v-model="slotsPreview" type="checkbox" />显示可编辑槽位</label>
          <p class="hint">拖动外框移动整格；拖动黄色/绿色小框单独编辑槽位。直接拖动四角或边中点缩放；按住 Ctrl 再拖四角才形变。Alt 暂停吸附，方向键微调，Delete 删除选中项，Ctrl+Z 撤销。</p>
          <strong>读序（先读 1）</strong>
          <button v-for="(_, i) in doc.panels" :key="i" type="button" :class="{ active: selected === i }" @click="selectPanel(i)">第 {{ i + 1 }} 格</button>
          <div class="inline"><button type="button" :disabled="selected <= 0" @click="reorder(-1)">提前</button><button type="button" :disabled="selected < 0 || selected >= doc.panels.length-1" @click="reorder(1)">延后</button></div>
          <div class="inline"><button type="button" :disabled="selectedLayer < 0 || selectedLayer >= doc.panels.length-1" @click="moveLayer(1)">上移一层</button><button type="button" :disabled="selectedLayer <= 0" @click="moveLayer(-1)">下移一层</button></div>
          <p class="hint">{{ current ? `当前第 ${selectedLayer+1} / ${doc.panels.length} 层（数字越大越靠前）。` : '' }}层级控制重叠遮挡，不改变读序；遮挡关系自动写入生图提示词。</p>
        </aside>
        <div class="canvas-area">
          <div ref="canvasViewport" class="canvas-viewport" aria-label="画布缩放区域" @wheel.capture="zoomCanvas">
          <svg ref="svg" class="layout-canvas" :viewBox="`0 0 ${doc.width} ${doc.height}`" :style="{ aspectRatio: `${doc.width}/${doc.height}`, width: `min(${100*canvasZoom}%, ${62*doc.width/doc.height*canvasZoom}vh)` }" role="img" aria-label="版式画布" tabindex="0" @pointermove="move" @pointerup="end($event)" @pointercancel="end($event,true)" @lostpointercapture="end($event,true)">
            <rect :width="doc.width" :height="doc.height" fill="white" @pointerdown="selectPanel(-1)" />
            <g v-for="{ rect: r, index: i } in drawn" :key="i" class="panel" :class="{ selected: i===selected }" @pointerdown.stop="begin($event,i)" @dblclick.stop.prevent="openDescription(i,'F')">
              <polygon :points="polygon(r,'F')" :fill="i===selected ? '#dcecff' : '#f1f2f4'" :stroke="i===selected ? '#2675cf' : '#333'" stroke-width="2" vector-effect="non-scaling-stroke" />
              <foreignObject v-if="previewDescription(r,'F')" :x="r.x+6" :y="r.y+doc.width*.04" :width="Math.max(1,r.width-12)" :height="Math.max(1,Math.min(r.height-doc.width*.04,doc.width*.055))" class="frame-description"><div :style="{fontSize:`${doc.width*.018}px`}" :title="frameDescription(r,'F')">{{ previewDescription(r,'F') }}</div></foreignObject>
              <g v-for="s in visibleSlots(r,i)" :key="s.key" class="slot" :data-slot="s.key" @pointerdown.stop="begin($event,i,'',s.key)" @dblclick.stop.prevent="openDescription(i,s.key)">
                <polygon :points="polygon(r,s.key)" :fill="slotType(s.key)==='T' ? '#e5ba6638' : '#50a18a18'" :stroke="i===selected && s.key===selectedSlot ? '#df7827' : slotType(s.key)==='T' ? '#b48733' : '#50a18a'" :stroke-width="i===selected && s.key===selectedSlot ? 2 : 1" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />
                <text :x="s.rect.x+5" :y="s.rect.y+doc.width*.025" :font-size="doc.width*.021" fill="#575c62">{{ s.key }}</text>
                <foreignObject v-if="previewDescription(r,s.key)" :x="s.rect.x+6" :y="s.rect.y+doc.width*.032" :width="Math.max(1,s.rect.width-12)" :height="Math.max(1,Math.min(s.rect.height-doc.width*.032,doc.width*.055))" class="frame-description"><div :style="{fontSize:`${doc.width*.018}px`}" :title="frameDescription(r,s.key)">{{ previewDescription(r,s.key) }}</div></foreignObject>
              </g>
              <text :x="r.x+8" :y="r.y+doc.width*.032" :font-size="doc.width*.026" fill="#164b83">{{ i+1 }}</text>
            </g>
              <template v-if="current && activeRect"><rect v-for="h in handles()" :key="h.name" class="resize-handle" :data-ctrl-deform="h.name.length===2" :data-handle="h.name" :rx="h.name.length===2 ? doc.width*.009 : 0" :x="h.x-doc.width*.009" :y="h.y-doc.width*.009" :width="doc.width*.018" :height="doc.width*.018" :fill="selectedSlot ? '#df7827' : '#2675cf'" stroke="white" vector-effect="non-scaling-stroke" :style="{cursor:`${h.name}-resize`}" :aria-label="`${h.name} 控制点`" @pointerdown.stop.prevent="begin($event,selected,h.name,selectedSlot)" /></template>
          </svg>
          </div>
          <p class="hint">{{ doc.width }}×{{ doc.height }} · {{ doc.panels.length }} 格 · 缩放 {{ Math.round(canvasZoom*100) }}% · Ctrl＋滚轮缩放，双击框编辑说明<br />槽位可单独移动、缩放和删除；移动外框时槽位跟随，保存后保留编辑结果。</p>
        </div>
        <aside class="properties">
          <label>版式 ID<input :value="doc.id" aria-label="版式 ID" @change="changeText('id',$event)" /></label>
          <label>名称<input :value="doc.label" aria-label="版式名称" @change="changeText('label',$event)" /></label>
          <label>用途说明<textarea :value="doc.usage" aria-label="版式用途" rows="3" @change="changeText('usage',$event)"></textarea></label>
          <template v-if="current">
            <strong>第 {{ selected+1 }} 格 · {{ selectedSlot ? `${selectedSlot} ${slotLabels[slotType(selectedSlot)] ?? '槽位'}` : '外框 F' }}</strong>
            <div v-if="selectedSlot" class="slot-actions">
              <div class="inline"><button type="button" class="primary" @click="confirmSlot">确定内框</button><button type="button" @click="cancelSlot">取消内框修改</button></div>
              <p class="hint">确定后保留内框并返回外框编辑；取消恢复本次内框修改。完成整页后请点击右上角保存按钮。切换选中项会保留当前修改。</p>
            </div>
            <button type="button" :disabled="!selectedSlot" @click="deleteSlot">删除选中槽位</button>
            <button type="button" @click="resetSlots">恢复本格默认槽位</button>
            <label>{{ selectedSlot ? `内框 ${selectedSlot} 用途说明` : '外框 F 用途说明' }}
              <textarea :value="current.slotNotes?.[selectedSlot || 'F'] ?? ''" aria-label="当前框用途说明" rows="3" :placeholder="selectedSlot ? '例如：半身主体，侧重人物动作与反应' : '例如：交代场景和人物关系的开场格'" @input="changeSlotNote"></textarea>
            </label>
            <div class="slot-list"><button type="button" :class="{active:!selectedSlot}" @click="confirmSlot">外框 F</button><button v-for="(_,key) in current.slots" :key="key" type="button" :class="{active:selectedSlot===key}" @click="selectSlot(selected,String(key))">{{ key }} {{ slotLabels[slotType(String(key))] ?? '' }}</button></div>
            <div class="slot-picker">
              <button type="button" :aria-expanded="slotPickerOpen" :disabled="!availableSlots.length" @click="slotPickerOpen=!slotPickerOpen">添加内框 {{ slotPickerOpen ? '▴' : '▾' }}</button>
              <div v-if="slotPickerOpen && availableSlots.length" class="slot-options" role="group" aria-label="可添加的内框">
                <button v-for="key in availableSlots" :key="key" type="button" @click="addSlot(key)">{{ key }} {{ slotLabels[key] }}</button>
              </div>
            </div>
            <label v-for="field in (['x','y','width','height'] as const)" :key="field">{{ {x:'左边距',y:'上边距',width:'宽度',height:'高度'}[field] }}<input :value="activeRect?.[field]" :aria-label="`${selectedSlot ? '槽位' : '分格'}${field}`" type="number" step="1" @change="changeRect(field,$event)" /></label>
          </template>
          <p v-else class="hint">添加或选择一格，编辑精确尺寸。</p>
          <p class="hint">右侧按钮可选重叠槽位，Delete 删除小框，撤销可恢复。普通拖动四角或边中点改大小，Ctrl+拖四角改形状。MOSS 以外接矩形与轮廓描述接收形状参考，不保证精确裁剪。</p>
        </aside>
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <footer v-if="discard"><span>放弃未保存的修改？</span><button type="button" @click="discard=false">继续编辑</button><button type="button" @click="emit('close')">放弃修改</button></footer>
      <div v-if="quickEdit" class="quick-mask" @mousedown.self="quickEdit=null">
        <section class="quick-dialog" role="dialog" aria-modal="true" aria-label="快速编辑框说明" @keydown.stop="quickKeydown" @keydown.esc.prevent="quickEdit=null">
          <header><strong>第 {{ quickEdit.index+1 }} 格 · {{ quickEdit.key }} 框说明</strong><button type="button" aria-label="关闭快速编辑" @click="quickEdit=null">✕</button></header>
          <textarea ref="quickField" v-model="quickDraft" aria-label="快速框说明" rows="7" @keydown.ctrl.enter.prevent="saveQuickDescription"></textarea>
          <footer><button type="button" @click="quickEdit=null">取消</button><button type="button" class="primary" @click="saveQuickDescription">确定框说明</button></footer>
        </section>
      </div>
    </section>
  </ModalMask>
</template>

<style scoped>
.frame-description{pointer-events:none}.frame-description div{background:#fffD;color:#20334e;line-height:1.3;padding:2px 4px;border-radius:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}.quick-mask{position:fixed;inset:0;background:#0006;z-index:10010;display:grid;place-items:center;padding:20px}.quick-dialog{width:min(560px,90vw);padding:18px;background:var(--bbi-surface,#fff);color:var(--bbi-ink,#222);border-radius:10px;box-shadow:0 12px 50px #0005}.quick-dialog textarea{width:100%;resize:vertical}
.editor-actions{margin-left:auto;flex-wrap:nowrap}.editor-actions button{white-space:nowrap}
.slot-picker{grid-column:1/-1}.slot-picker>button{width:100%}.slot-options{display:flex;flex-direction:column;gap:3px;max-height:210px;overflow-y:auto;margin-top:5px;padding:5px;border:1px solid #8886;border-radius:6px}.slot-options button{text-align:left;flex:none}
.slot-actions{grid-column:1/-1;padding:8px;border:1px solid #2675cf66;border-radius:6px}.slot-actions .hint{margin-bottom:0}
.manga-designer{width:min(1140px,96vw);max-height:94vh;overflow:auto;background:var(--bbi-surface,#fff);color:var(--bbi-ink,#222);border-radius:12px;padding:18px;box-sizing:border-box;box-shadow:0 16px 64px #0005;outline:none;font-size:13px}
header,footer,.canvas-controls,.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}header{justify-content:space-between;font-size:17px;margin-bottom:14px}footer{justify-content:flex-end;margin-top:14px;border-top:1px solid #8884;padding-top:12px}.canvas-controls label{display:flex;align-items:center;gap:5px}.canvas-controls input{width:90px}.designer-body{display:grid;grid-template-columns:180px minmax(180px,1fr) 180px;gap:16px;margin-top:12px}.tools,.properties{display:flex;flex-direction:column;gap:9px}.tools label:not(.check),.properties label{display:flex;flex-direction:column;gap:5px}.check{display:flex;gap:5px;align-items:center}input,textarea,select{box-sizing:border-box;min-width:0;max-width:100%;padding:6px;border:1px solid #8886;border-radius:5px;color:inherit;background:transparent;font:inherit}button{border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;padding:6px 9px;cursor:pointer;font:inherit}button:disabled{opacity:.4;cursor:default}button.active,button.primary{background:#2675cf;color:white}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.layout-canvas:focus-visible{outline:2px solid #2675cf;outline-offset:2px}.hint{font-size:12px;line-height:1.6;opacity:.75;margin:7px 0}.canvas-area{background:#8881;border:1px solid #8884;padding:12px;display:flex;flex-direction:column;align-items:center;min-width:0}.canvas-viewport{width:100%;height:62vh;overflow:auto;overscroll-behavior:contain}.layout-canvas{display:block;margin:0 auto;max-width:none;height:auto;overflow:visible;touch-action:none;user-select:none;box-shadow:0 2px 10px #0003}.panel,.slot{cursor:move}.slot-list{display:flex;flex-wrap:wrap;gap:4px;max-height:145px;overflow:auto}.slot-list button{font-size:11px;padding:4px 5px}.panel text{pointer-events:none}.error{color:#b3261e}
@media(max-width:760px){.designer-body{grid-template-columns:1fr}.tools{display:flex;flex-direction:row;flex-wrap:wrap}.tools>.hint{width:100%}.properties{display:grid;grid-template-columns:1fr 1fr}.properties>.hint{grid-column:1/-1}.canvas-viewport{height:58vh}.manga-designer{padding:12px}}
</style>
