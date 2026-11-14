import { naiDefaultUndesired, parseNaiv4vibe } from '@/backends/nai';
import {
  clampVibeStrength,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import { getContext } from '@/st/context';
import { newNaiArtist, type NaiArtistPreset, type NaiVibe } from '@/state/settings';

/**
 * 智绘姬(st-chatu8)vibe 兼容导入(只读,绝不写智绘姬的任何数据)。
 *
 * chatu8 的 vibe 存储模型:
 * - extension_settings['st-chatu8'] 里:
 *   - vibePresets: { [预设名]: { vibeDataId, strength, model, ... } }(Vibe 生成器预设)
 *   - vibeGroups: { [组名]: { vibes: [{ vibeDataId, strength }] } }(NAI4/4.5 vibe 组)
 *   - configImageStorage: { [id]: { path } } —— 存到酒馆服务器时的路径映射
 * - vibe 数据本体是 .naiv4vibe 格式的 JSON 字符串,两处可能:
 *   a) 酒馆服务器文件(configImageStorage[id].path 可直接 fetch);
 *   b) IndexedDB「chatu8_config_images」库的 config_images 表(记录 {id, data})。
 * 格式与我们的一致(同为官方 novelai-vibe-transfer),解析直接复用 parseNaiv4vibe。
 */

/** 智绘姬在 extension_settings 里的命名空间键。 */
export const CHATU8_SETTINGS_KEY = 'st-chatu8';
const CHATU8_DB_NAME = 'chatu8_config_images';
const CHATU8_STORE_NAME = 'config_images';
const FETCH_TIMEOUT_MS = 20_000;

export { vibeFingerprint } from '@/backends/vibeStore';

export interface Chatu8VibeRef {
  vibeDataId: string;
  strength: number;
  /** 来源名:预设名或组名(用于命名导入条目)。 */
  source: string;
  kind: 'preset' | 'group';
}

export interface Chatu8ArtistRef {
  /** Source preset name in st-chatu8. */
  source: string;
  /** 前置固定正向(fixedPrompt)→ 目标画师串位(正向最前,与智绘姬拼装位置一致)。 */
  prompt: string;
  /** 后置固定正向(fixedPrompt_end)→ 目标正面质量词位(正向最后,与智绘姬拼装位置一致)。 */
  quality: string;
  /** 固定负向(negativePrompt);导入时会在前面拼上当前模型官方基线(智绘姬同口径:官方 UCP + 用户负向)。 */
  negative: string;
  /** Whether this is the currently selected NovelAI prompt preset in st-chatu8. */
  active: boolean;
}

/** Collect every shared st-chatu8 prompt preset; the source does not track per-backend ownership. */
export function collectChatu8ArtistRefs(chatu8: unknown): Chatu8ArtistRef[] {
  if (!chatu8 || typeof chatu8 !== 'object') return [];
  const root = chatu8 as Record<string, unknown>;
  if (!root.yushe || typeof root.yushe !== 'object') return [];
  const activeName = typeof root.yusheid_novelai === 'string' ? root.yusheid_novelai : '';
  const refs: Chatu8ArtistRef[] = [];
  for (const [source, value] of Object.entries(root.yushe)) {
    if (!value || typeof value !== 'object') continue;
    const preset = value as Record<string, unknown>;
    refs.push({
      source,
      prompt: typeof preset.fixedPrompt === 'string' ? preset.fixedPrompt.trim() : '',
      quality: typeof preset.fixedPrompt_end === 'string' ? preset.fixedPrompt_end.trim() : '',
      negative: typeof preset.negativePrompt === 'string' ? preset.negativePrompt.trim() : '',
      active: source === activeName,
    });
  }
  return refs;
}

export interface Chatu8ArtistDetectInfo {
  found: boolean;
  total: number;
}

export function detectChatu8Artists(chatu8: unknown): Chatu8ArtistDetectInfo {
  if (!chatu8 || typeof chatu8 !== 'object') return { found: false, total: 0 };
  return { found: true, total: collectChatu8ArtistRefs(chatu8).length };
}

/** 一条预设的去向(与 collectChatu8ArtistRefs 顺序一一对应,预览徽标与落盘共用)。 */
export interface Chatu8ArtistPlan {
  source: string;
  /** 前置固定正向(预览用)。 */
  prompt: string;
  /** 后置固定正向(预览用)。 */
  quality: string;
  /** 固定负向原文(预览用;落盘值在 preset 里,前面已拼上官方基线)。 */
  negative: string;
  active: boolean;
  /** import = 新建条目;overwrite = 同名覆盖现有条目;skip = 内容完全相同,跳过。 */
  state: 'import' | 'overwrite' | 'skip';
  /** 目标条目 id:overwrite/skip 指向现有条目;import 指向新建条目。 */
  targetId: string;
  /** import/overwrite 时携带最终落库值(overwrite 时 id = 现有条目 id)。 */
  preset?: NaiArtistPreset;
}

export interface Chatu8ArtistImportResult {
  found: boolean;
  imported: number;
  overwritten: number;
  duplicates: number;
  plans: Chatu8ArtistPlan[];
  /** Matching target id for the source's active NovelAI preset; the caller decides whether to select it. */
  activeArtistId: string;
}

/**
 * 把智绘姬的全部提示词预设搬进画师串库(纯函数,绝不写智绘姬)。
 *
 * 映射(与智绘姬生成时的拼装位置一一对应):
 * - fixedPrompt(前置固定正向)→ 目标 prompt(画师串位,正向最前);
 * - fixedPrompt_end(后置固定正向)→ 目标 quality(正面质量词位,正向最后);
 * - negativePrompt(固定负向)→ 目标 negative。智绘姬的口径是「官方 UCP + 用户负向」,
 *   故用户负向非空时把当前模型官方基线烤在它前面(基线在导入时即定,随后不随模型切换);
 *   用户负向为空则留空走回落链,基线仍跟随模型,与智绘姬空负向时只用 UCP 同效。
 *
 * 同名即视为同一配方:内容不同 → 覆盖更新(旧版迁移把正向整体塞进画师串的条目,
 * 重新导入即被修好),完全相同 → 跳过。幂等,随时可再来。
 */
export function importArtistsFromChatu8(
  existing: readonly NaiArtistPreset[],
  chatu8: unknown = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY],
  model: string,
): Chatu8ArtistImportResult {
  if (!chatu8 || typeof chatu8 !== 'object') {
    return { found: false, imported: 0, overwritten: 0, duplicates: 0, plans: [], activeArtistId: '' };
  }

  // 同名覆盖按「首个同名条目」处理(库允许重名、以 id 为键;其余同名条目不动)。
  const byName = new Map<string, NaiArtistPreset>();
  for (const preset of existing) {
    const name = preset.name.trim();
    if (name && !byName.has(name)) byName.set(name, preset);
  }

  const bakeNegative = (ref: Chatu8ArtistRef): string =>
    ref.negative ? [naiDefaultUndesired(model), ref.negative].filter(Boolean).join(', ') : '';

  const buildPreset = (ref: Chatu8ArtistRef, negative: string): NaiArtistPreset => {
    const preset = newNaiArtist(ref.source);
    preset.prompt = ref.prompt;
    preset.quality = ref.quality;
    preset.negative = negative;
    return preset;
  };

  const result: Chatu8ArtistImportResult = {
    found: true,
    imported: 0,
    overwritten: 0,
    duplicates: 0,
    plans: [],
    activeArtistId: '',
  };

  for (const ref of collectChatu8ArtistRefs(chatu8)) {
    const negative = bakeNegative(ref);
    const sameContent = (p: NaiArtistPreset) =>
      p.prompt.trim() === ref.prompt && p.quality.trim() === ref.quality && p.negative.trim() === negative;

    const existingPreset = byName.get(ref.source.trim());
    if (existingPreset) {
      if (sameContent(existingPreset)) {
        result.duplicates++;
        result.plans.push({ ...ref, negative, state: 'skip', targetId: existingPreset.id });
      } else {
        const preset = buildPreset(ref, negative);
        preset.id = existingPreset.id;
        result.overwritten++;
        result.plans.push({ ...ref, negative, state: 'overwrite', targetId: existingPreset.id, preset });
      }
      if (ref.active) result.activeArtistId = existingPreset.id;
      continue;
    }

    const preset = buildPreset(ref, negative);
    result.imported++;
    result.plans.push({ ...ref, negative, state: 'import', targetId: preset.id, preset });
    if (ref.active) result.activeArtistId = preset.id;
  }
  return result;
}

/** 从 chatu8 设置里收集全部 vibe 引用(预设 + 组),按 vibeDataId 去重(预设优先,命名更好看)。 */
export function collectChatu8VibeRefs(chatu8: unknown): Chatu8VibeRef[] {
  if (!chatu8 || typeof chatu8 !== 'object') return [];
  const root = chatu8 as Record<string, unknown>;
  const refs: Chatu8VibeRef[] = [];
  const seen = new Set<string>();
  const push = (vibeDataId: unknown, strength: unknown, source: string, kind: Chatu8VibeRef['kind']) => {
    if (typeof vibeDataId !== 'string' || !vibeDataId || seen.has(vibeDataId)) return;
    seen.add(vibeDataId);
    refs.push({ vibeDataId, strength: clampVibeStrength(strength), source, kind });
  };

  const presets = root.vibePresets;
  if (presets && typeof presets === 'object') {
    for (const [name, preset] of Object.entries(presets)) {
      const p = preset as Record<string, unknown> | null;
      if (p && typeof p === 'object') push(p.vibeDataId, p.strength, name, 'preset');
    }
  }
  const groups = root.vibeGroups;
  if (groups && typeof groups === 'object') {
    for (const [groupName, group] of Object.entries(groups)) {
      const g = group as { vibes?: unknown } | null;
      if (!g || !Array.isArray(g.vibes)) continue;
      for (const vibe of g.vibes) {
        const v = vibe as Record<string, unknown> | null;
        if (v && typeof v === 'object') push(v.vibeDataId, v.strength, groupName, 'group');
      }
    }
  }
  return refs;
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return '';
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  return header.includes(';base64') ? base64ToUtf8(data) : decodeURIComponent(data);
}

/** 与 chatu8 getConfigText 的服务器分支同口径:fetch 路径后按 data:/JSON/base64 尝试解码。 */
async function fetchServerText(path: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(path, { signal: controller.signal });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (text.startsWith('data:')) return decodeDataUrlText(text);
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text;
    try {
      return base64ToUtf8(trimmed);
    } catch {
      return text;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读 chatu8 的 IndexedDB(不带版本号打开,避免触发 upgrade;只读单条记录)。
 * data 可能是字符串(text)或 ArrayBuffer(图片,不会是 vibe 文本,忽略)。
 */
let chatu8DbPromise: Promise<IDBDatabase | null> | null = null;

function openChatu8Db(): Promise<IDBDatabase | null> {
  if (chatu8DbPromise) return chatu8DbPromise;
  chatu8DbPromise = new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(CHATU8_DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHATU8_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
  });
  return chatu8DbPromise;
}

async function readChatu8Store(id: string): Promise<string | null> {
  const db = await openChatu8Db();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const get = db.transaction([CHATU8_STORE_NAME], 'readonly').objectStore(CHATU8_STORE_NAME).get(id);
      get.onsuccess = () => {
        const data = (get.result as { data?: unknown } | undefined)?.data;
        if (typeof data === 'string') resolve(data);
        else resolve(null);
      };
      get.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export interface Chatu8DetectInfo {
  /** 是否检测到智绘姬设置。 */
  found: boolean;
  /** vibe 引用总数(预设+组内,已按 id 去重)。 */
  total: number;
  presets: number;
  groups: number;
}

/** 智绘姬 vibe 检测:只读 settings 里的引用列表(同步、廉价),供迁移面板实时展示。 */
export function detectChatu8Vibes(chatu8: unknown): Chatu8DetectInfo {
  if (!chatu8 || typeof chatu8 !== 'object') return { found: false, total: 0, presets: 0, groups: 0 };
  const refs = collectChatu8VibeRefs(chatu8);
  return {
    found: true,
    total: refs.length,
    presets: refs.filter(r => r.kind === 'preset').length,
    groups: refs.filter(r => r.kind === 'group').length,
  };
}

/** 旧版迁移把组名拼进了显示名,分隔符是「 · 」。 */
const LEGACY_GROUP_SEPARATOR = ' · ';

export interface PrefixGroupPlan {
  id: string;
  /** 从名字前缀识别出的组名。 */
  group: string;
  /** 去掉前缀后的显示名。 */
  name: string;
}

/**
 * 为「已经迁移过」的库补分组:旧版把组名拼成了「组名 · 原名」,这里把前缀还原成 group。
 *
 * 只动 group 为空的条目(不覆盖用户已手工分好的组),且前缀与余名都非空才算。
 * 纯函数、只返回需要改动的条目,调用方决定是否落盘——用户点按钮前要能看到「将整理 N 个」。
 */
export function planPrefixGroups(
  vibes: readonly Pick<NaiVibe, 'id' | 'name' | 'group'>[],
): PrefixGroupPlan[] {
  const plans: PrefixGroupPlan[] = [];
  for (const vibe of vibes) {
    if (vibe.group.trim()) continue;
    const at = vibe.name.indexOf(LEGACY_GROUP_SEPARATOR);
    if (at <= 0) continue;
    const group = vibe.name.slice(0, at).trim();
    const name = vibe.name.slice(at + LEGACY_GROUP_SEPARATOR.length).trim();
    if (!group || !name) continue;
    plans.push({ id: vibe.id, group, name });
  }
  return plans;
}

export interface Chatu8ImportResult {
  /** 是否检测到 chatu8 设置。 */
  found: boolean;
  imported: number;
  /** 内容与本库已有(或本次已导入)重复而跳过。 */
  duplicates: number;
  /** 引用存在但数据取不到/解析失败。 */
  failed: number;
  /** 待入库的新条目(调用方 push 进 settings.nai.vibes)。 */
  vibes: NaiVibe[];
}

let importSeq = 0;

export interface Chatu8ImportOptions {
  onProgress?: (current: number, total: number) => void;
}

/**
 * 从 st-chatu8 导入全部 vibe。existing 传当前库(内容去重用)。
 * 单个失败不阻塞整体;结果为 null 表示未检测到 chatu8。
 */
export async function importVibesFromChatu8(
  existing: NaiVibe[],
  options: Chatu8ImportOptions = {},
): Promise<Chatu8ImportResult> {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  if (!chatu8 || typeof chatu8 !== 'object') {
    return { found: false, imported: 0, duplicates: 0, failed: 0, vibes: [] };
  }
  const refs = collectChatu8VibeRefs(chatu8);
  const serverMap =
    (chatu8 as Record<string, unknown>).configImageStorage &&
    typeof (chatu8 as Record<string, unknown>).configImageStorage === 'object'
      ? ((chatu8 as Record<string, unknown>).configImageStorage as Record<string, { path?: unknown }>)
      : {};

  const fingerprints = new Set(existing.map(v => v.fingerprint).filter(Boolean));
  const result: Chatu8ImportResult = { found: true, imported: 0, duplicates: 0, failed: 0, vibes: [] };

  for (const [index, ref] of refs.entries()) {
    options.onProgress?.(index + 1, refs.length);
    // 服务器优先(chatu8 同口径),取不到再试 IndexedDB
    const path = serverMap[ref.vibeDataId]?.path;
    let text = typeof path === 'string' && path ? await fetchServerText(path) : null;
    if (!text) text = await readChatu8Store(ref.vibeDataId);
    if (!text) {
      result.failed++;
      continue;
    }
    // IndexedDB 里可能存的是 dataURL 字符串,先剥壳
    if (text.startsWith('data:')) text = decodeDataUrlText(text);
    try {
      const parsed = parseNaiv4vibe(text);
      const fingerprint = vibeFingerprint(parsed.encodings);
      if (fingerprints.has(fingerprint)) {
        result.duplicates++;
        continue;
      }
      const id = `vibe_${Date.now()}_${++importSeq}`;
      const data = { image: parsed.image, thumbnail: parsed.thumbnail, encodings: parsed.encodings };
      const paths = await saveVibeFiles(data, null, id);
      fingerprints.add(fingerprint);
      result.vibes.push(
        vibeMetaFromData(
          id,
          // 预设用预设名(用户起的);组内条目无名,用 vibe 文件原名(组名已进 group 字段,
          // 不再拼进显示名——那会变成「组名 · 组名 · xxx」的重复)
          ref.kind === 'preset' ? ref.source : parsed.name,
          paths.dataPath,
          paths.thumbnailPath,
          data,
          ref.strength,
          // 智绘姬的组结构原样保留;预设不属于任何组
          ref.kind === 'group' ? ref.source : '',
        ),
      );
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
