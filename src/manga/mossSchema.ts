/** Final MOSS fields only. Never drop a content item to repair its schema. */
const ROOT = new Set(['summary','items','layout','bbox_coord_space','bbox_format']);
const SUMMARY = new Set(['caption','canvas','meta','palette']);
const ITEM = new Set(['panel','slot','label','caption','bbox','text','tags','palette']);
const TRANSPORT = new Set(['debug','reasoning','thinking','layer','z-index','z_index']);
const empty = (value: unknown): boolean => value == null || typeof value === 'string' && !value.trim()
  || Array.isArray(value) && value.length === 0 || typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0;
function fail(path: string, reason: string): never { throw new Error(`漫画 Layout:${path} ${reason}，请重新生成提示词。`); }
function object(value: unknown): value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export function cleanMossFields(root: Record<string,unknown>, canvas: {width:number;height:number}): string[] {
  const cleaned: string[] = [];
  function keys(value: Record<string,unknown>, allowed: Set<string>, path: string): void {
    for (const [key,entry] of Object.entries(value)) {
      if (allowed.has(key)) continue;
      if (key === 'width' || key === 'height') {
        if (!empty(entry) && entry !== canvas[key]) fail(`${path}.${key}`, '与实际画布不一致');
      } else if (!TRANSPORT.has(key) && !empty(entry)) {
        fail(`${path}.${key}`, '含有不支持的内容字段，不能安全丢弃');
      }
      delete value[key]; cleaned.push(`${path}.${key}`);
    }
  }
  function strings(value: Record<string,unknown>, key: string, path: string): void {
    if (!(key in value)) return;
    const input=value[key];
    if (empty(input)) { delete value[key]; cleaned.push(`${path}.${key}`); return; }
    const entries=typeof input === 'string' ? [input] : input;
    if (!Array.isArray(entries) || entries.some(entry => !empty(entry) && typeof entry !== 'string')) fail(`${path}.${key}`, '需要字符串数组');
    const output=entries.filter(entry=>!empty(entry)).map(entry=>(entry as string).trim());
    if (JSON.stringify(input)!==JSON.stringify(output)) cleaned.push(`${path}.${key}`);
    value[key]=output;
  }
  keys(root,ROOT,'root');
  if (root.summary !== undefined) {
    if (!object(root.summary)) fail('summary','需要对象');
    keys(root.summary,SUMMARY,'summary');
    if (root.summary.caption !== undefined && (typeof root.summary.caption !== 'string' || !root.summary.caption.trim())) fail('summary.caption','需要非空画面描述');
    if (root.summary.canvas !== undefined && !['single','multi_panel','collage'].includes(root.summary.canvas as string)) fail('summary.canvas','需要 single、multi_panel 或 collage');
    strings(root.summary,'meta','summary'); strings(root.summary,'palette','summary');
  }
  if (Array.isArray(root.items)) root.items.forEach((item,index)=>{
    if (!object(item)) return; // The compiler reports malformed items with its existing location checks.
    keys(item,ITEM,`items[${index}]`);
    strings(item,'tags',`items[${index}]`); strings(item,'palette',`items[${index}]`);
    if (item.label !== 'text' && 'text' in item) {
      if (!empty(item.text)) fail(`items[${index}].text`,'在非文字项中含有字样，不能删除');
      delete item.text; cleaned.push(`items[${index}].text`);
    }
  });
  return cleaned;
}

/** Run before adding compiler prefixes so an empty caption cannot be disguised. */
export function validateMossContent(item: Record<string,unknown>, index: number): void {
  if (!['object','character','text'].includes(item.label as string)) fail(`items[${index}].label`,'需要 object、character 或 text');
  if (typeof item.caption !== 'string' || !item.caption.trim()) fail(`items[${index}].caption`,'需要非空画面描述');
  if (item.label === 'text' && (typeof item.text !== 'string' || !item.text.trim())) fail(`items[${index}].text`,'需要非空准确字样');
}
