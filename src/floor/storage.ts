import type { ComfyImageResult } from '@/backends/comfyui';
import { utf8ToBase64 } from '@/base64';
import { normalizeImagePath } from '@/floor/missingImages';
import { deleteUploadedFile, uploadBase64File } from '@/floor/upload';
import type { GenerationMeta } from '@/generationMeta';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { deleteUserImage, uploadUserImage } from '@/st/images';
import { settings } from '@/state/settings';

// 图片存 user/images，聊天 extra 按重抽版本和提示词保存引用。图库通过同名侧写读取元数据。

export interface BbiImageEntry {
  /** 本次生成唯一 id。 */
  generationId: string;
  /** ST 静态路径 /user/images/... 或旧 /user/files/...（<img src> 直接引用）。 */
  path: string;
  /** 生成时使用的完整 tag 原文（含 <bbi_image> 壳），与 promptHash 输入一致。 */
  prompt: string;
  /** 本次生成种子；第四步种子策略落地前固定 null。 */
  seed: number | null;
  status: 'ready' | 'error';
  createdAt: number;
  /** 生成时所在槽位序号（楼层内第 N 个 tag）。多 tag 楼层按位置隔离结果；
   *  旧数据缺失时按 entrySeq() 回退为 0。 */
  slotSeq?: number;
  /** 出图元信息（画师串/vibe/采样参数）。图库当前聊天的快速通道读它，避免逐张抓侧写；
   *  旧数据没有此键。 */
  meta?: GenerationMeta;
}

/** [swipeId][promptHash] = 历史 entry 列表。 */
export type BbiImageStore = Record<string, Record<string, BbiImageEntry[]>>;

export const BBI_IMAGE_EXTRA_KEY = 'bbiImage';

/* —— hash 与命名 —— */

/** cyrb53 派生：同步、确定、对聊天级提示词足够分散；输出 14 位 hex。 */
export function promptHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function generationId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 平铺文件名：角色卡名称哈希化，避免中文名称被替换成连续下划线。 */
export function imageFileName(
  characterName: string,
  swipeId: number,
  hash: string,
  genId: string,
  ext: string,
): string {
  const characterHash = promptHash(characterName.trim() || 'unknown');
  return `bbi_${characterHash}_${swipeId}_${hash}-${genId}.${ext}`;
}

/* —— 侧写元数据（sidecar） —— */

/** 侧写 json 的内容。v 是版本号：日后想加 backend/model 时靠它分辨老文件。 */
export interface BbiImageSidecar {
  v: 1 | 2;
  /** 可读角色名（图片文件名里那个是哈希，还原不回来）。 */
  character: string;
  /** 生成时使用的完整 tag 原文（含 <bbi_image> 壳），与 entry.prompt 同源。 */
  prompt: string;
  seed: number | null;
  createdAt: number;
  /** v2 起：画师串/vibe/采样参数等不在 tag 文本里的信息。老文件没有此键。 */
  meta?: GenerationMeta;
}

/**
 * 由图片文件名推出侧写文件名（换掉扩展名而已）。**读写两侧唯一口径**。
 *
 * 之所以能这么算、不用维护索引：/api/files/upload 是 `path.join(dir, body.name)` 原样落盘
 * （files.js，只校验不清洗），故上传时给什么名字、事后就能凭同一个纯函数算回来。
 * 而图片名 bbi_<hash>_<swipe>_<promptHash>-<genId> 恰好全在
 * validateAssetFileName 的白名单 /^[a-zA-Z0-9_\-.]+$/ 内，天然合规。
 *
 * 侧写只能放 user/files:/api/images/upload 的 format 必须是媒体扩展名，json 不在其列，
 * 塞不进图片自己的目录。
 */
export function sidecarFileName(imageFile: string): string {
  const base = imageFile.replace(/\.[^./]*$/, '');
  return `${base}.json`;
}

/** 由图片路径（/user/images/…）推出侧写的可访问路径；不是本插件的图片则返回空串。 */
export function sidecarPathFor(imagePath: string): string {
  const file = imagePath.split('/').pop() ?? '';
  // 只认自家命名的图:外来文件算出来的名字必然 404，白刷一轮请求
  if (!/^bbi_[a-zA-Z0-9_]+-[a-zA-Z0-9]+\.[a-z0-9]+$/i.test(file)) return '';
  return `/user/files/${sidecarFileName(file)}`;
}

/* —— extra 读写（纯函数） —— */

export function readStore(message: STMessage): BbiImageStore | null {
  const extra = message.extra;
  if (!extra || typeof extra[BBI_IMAGE_EXTRA_KEY] !== 'object' || extra[BBI_IMAGE_EXTRA_KEY] === null) {
    return null;
  }
  return extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
}

/** hash 匹配的最新一条结果（卡片 ready）。 */
/** 旧数据（无 slotSeq 字段）回退为槽位 0。 */
function entrySeq(entry: BbiImageEntry): number {
  return entry.slotSeq ?? 0;
}

/** 同槽位的全部历史（时间正序，最新在末尾）。卡片翻页用。 */
export function historyEntries(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry[] {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list) return [];
  return list.filter(entry => entrySeq(entry) === seq);
}

/** hash 匹配且位于同一槽位的最新一条结果（卡片 ready）。 */
export function latestEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (entrySeq(list[i]) === seq) return list[i];
  }
  return null;
}

/** 当前 hash 无该槽位结果时，其它提示词（stale）在同一槽位的最新一条（卡片 stale）。
 *  只取同槽位：相邻 tag 的结果不会被误当成这个 tag 的历史。 */
export function latestStaleEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const bucket = store?.[String(swipeId)];
  if (!bucket) return null;
  let latest: BbiImageEntry | null = null;
  for (const [key, list] of Object.entries(bucket)) {
    if (key === hash || list.length === 0) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (entrySeq(list[i]) !== seq) continue;
      const candidate = list[i];
      if (!latest || candidate.createdAt > latest.createdAt) latest = candidate;
      break; // 该桶内最新的一条即可
    }
  }
  return latest;
}

/** 不可变式追加一条历史（返回新 store，原 store 不动）。 */
export function appendEntry(
  store: BbiImageStore,
  swipeId: number,
  hash: string,
  entry: BbiImageEntry,
): BbiImageStore {
  const swipeKey = String(swipeId);
  const next: BbiImageStore = { ...store };
  next[swipeKey] = { ...(store[swipeKey] ?? {}) };
  next[swipeKey][hash] = [...(store[swipeKey]?.[hash] ?? []), entry];
  return next;
}

/* —— CAS 写回 —— */

/**
 * 读-改-写循环：mutate 基于当前 store 返回新 store，写回前校验引用未被
 * 并发写入替换，冲突则基于最新 store 重试（DESIGN-FLOOR-UI.md §7.2）。
 */
export async function mutateStore(
  ctx: STContext,
  messageId: number,
  mutate: (store: BbiImageStore) => BbiImageStore,
  panelSwipeId?: number,
): Promise<boolean> {
  if (panelSwipeId !== undefined) {
    const message = ctx.chat[messageId];
    const swipe = message?.swipe_info?.[panelSwipeId];
    const owner = (message?.swipe_id ?? 0) === panelSwipeId ? message : swipe;
    if (!owner) return false;
    const previous = owner.extra;
    const previousSwipe = swipe?.extra;
    const store = (previous?.[BBI_IMAGE_EXTRA_KEY] as BbiImageStore | undefined) ?? {};
    const next = mutate(store);
    if (next === store) return false;
    const extra = { ...previous, [BBI_IMAGE_EXTRA_KEY]: next };
    const swipeExtra = { ...previousSwipe, [BBI_IMAGE_EXTRA_KEY]: next };
    owner.extra = extra;
    if (swipe && swipe !== owner) swipe.extra = swipeExtra;
    try {
      await ctx.saveChat();
    } catch (error) {
      if (owner.extra === extra) owner.extra = previous;
      if (swipe && swipe.extra === swipeExtra) swipe.extra = previousSwipe;
      throw error;
    }
    return true;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const message = ctx.chat[messageId];
    if (!message) return false;
    if (!message.extra) message.extra = {};
    let store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore | undefined;
    if (!store) {
      // 首次建立：同步写回空对象确立引用（无 await，无竞态窗口）
      message.extra[BBI_IMAGE_EXTRA_KEY] = {};
      store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
    }
    const next = mutate(store);
    if (message.extra[BBI_IMAGE_EXTRA_KEY] !== store) continue; // 并发写入，重试
    message.extra[BBI_IMAGE_EXTRA_KEY] = next;
    await ctx.saveChat();
    return true;
  }
  console.warn('[柏宝绘] extra 写入重试耗尽，放弃本次写入');
  return false;
}

/* —— 保存流程 —— */

async function resultToBase64(result: ComfyImageResult): Promise<string> {
  if (result.url.startsWith('data:')) {
    // server 代理模式：data URL 去前缀直接用
    const comma = result.url.indexOf(',');
    return result.url.slice(comma + 1);
  }
  // browser 直连模式：blob URL → blob → base64（分块拼接防栈溢出）
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`读取图片失败 (${response.status})`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* —— 可选 JPG 转存(settings.storage.saveAsJpeg) —— */

/** 转码质量：视觉无损档。不并设滑条——极少数不满意直接关开关即可，免多一项配置。 */
const JPEG_QUALITY = 0.9;

function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new FileReader();
  return new Promise((resolve, reject) => {
    buffer.onload = () => {
      const dataUrl = String(buffer.result ?? '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('转码后图片格式无效'));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    buffer.onerror = () => reject(new Error('转码后图片读取失败'));
    buffer.readAsDataURL(blob);
  });
}

/**
 * 把原图重编码为 JPG(固定质量 0.9,自底向上重绘消除 alpha)。
 * PNG → canvas → JPEG：丢掉内嵌生成参数(NAI tEXt / ComfyUI 工作流块)，换来
 * 约为原体积 10–20% 的文件——这是有意为之的取舍，开关默认关。
 * 注：canvas 解码即屏敔一切元数据，无需额外「抹除」步骤。
 */
async function reencodeAsJpeg(source: Blob): Promise<Blob> {
  // createImageBitmap 比 <img> 快且不进 DOM；但部分环境(如 iOS Safari 旧版)对
  // EXIF 取向敏感度不同，这里显式 imageOrientation: 'none' 保持像素原样
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D 上下文不可用');
    // JPG 无 alpha 通道：先铺白底再绘图，否则透明区域被压成黑色
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('JPG 编码失败'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}

/**
 * 按设置准备待落盘的图片：开关开启时重编码为 JPG，关闭时原样返回。
 * 转码链路任何一步失败都回退原格式——宁可多占磁盘也不能把图开坏或丢失。
 */
export async function prepareImageForStorage(result: ComfyImageResult): Promise<{
  base64: string;
  format: string;
}> {
  if (settings.storage.saveAsJpeg) {
    try {
      // data URL/blob URL 都能被 fetch 成 Blob
      const response = await fetch(result.url);
      if (!response.ok) throw new Error(`读取图片失败 (${response.status})`);
      const original = await response.blob();
      // 本就是 JPG(webp 等不可再压)时直接跳过重编码，避免二次有损
      if (result.format !== 'jpg' && result.format !== 'jpeg') {
        const jpeg = await reencodeAsJpeg(original);
        return { base64: await blobToBase64(jpeg), format: 'jpg' };
      }
      return { base64: await blobToBase64(original), format: result.format };
    } catch (error) {
      console.warn('[柏宝绘] JPG 转码失败，本次回退保存原格式', error);
    }
  }
  return { base64: await resultToBase64(result), format: result.format };
}

/**
 * 图片二进制 + 侧写 json 落盘。**存图的唯一物理路径**,楼层与公开接口共用。
 *
 * 不碰聊天记录:楼层侧随后自己写 extra 指针,公开接口侧压根没有指针要写
 * (第三方自己决定图显示在哪,图不进任何楼层正文)。
 *
 * 文件名与目录必须走这里,不能各自另起一套:
 * - 目录 `柏宝绘_<角色名>` 是图库的**唯一**分组依据(index.vue 只列 FOLDER_PREFIX 开头的目录),
 *   名字换个前缀,图存下去了但图库里看不见;
 * - 文件名 `bbi_…-<genId>.<ext>` 要能被 sidecarPathFor 的正则认出来,否则它返回空串、
 *   图库压根不去请求侧写 —— 症状是图在、提示词空白、**且没有任何报错**。
 */
async function uploadImageWithSidecar(
  characterName: string,
  swipeId: number,
  hash: string,
  tag: string,
  seed: number,
  result: ComfyImageResult,
  meta?: GenerationMeta,
): Promise<{ path: string; genId: string; createdAt: number; imageFile: string }> {
  const genId = generationId();
  // 先按设置决定落盘格式(开关开启时重编码为 JPG),文件名后缀跟随实际格式
  const { base64, format } = await prepareImageForStorage(result);
  const imageFile = imageFileName(characterName, swipeId, hash, genId, format);
  const path = await uploadUserImage(`柏宝绘_${characterName}`, imageFile, base64, format);
  const createdAt = Date.now();

  // 侧写:图库跨聊天浏览时,提示词只能从这里拿。
  // **失败只警告不抛** —— 图已经存好了,绝不能因为一个附属 json 让整次存图失败;
  // 用户宁可少看一段提示词,也不能丢图。
  const sidecar: BbiImageSidecar = {
    v: 2,
    character: characterName,
    prompt: tag,
    seed,
    createdAt,
    ...(meta ? { meta } : {}),
  };
  try {
    await uploadBase64File(sidecarFileName(imageFile), utf8ToBase64(JSON.stringify(sidecar)));
  } catch (error) {
    console.warn('[柏宝绘] 侧写元数据写入失败（不影响图片）', error);
  }

  return { path, genId, createdAt, imageFile };
}

/**
 * 存一张**不属于任何楼层**的图(公开接口 STBaiBaiImage.generate 的 save 路径)。
 *
 * 与 saveImageResult 的分工:那个存完还要写 extra 指针、触发重水合,让楼层卡片显示它;
 * 这个只把文件放进图库就收工 —— 第三方插件自己决定图显示在哪(这正是公开接口的意义),
 * 柏宝绘不替它往聊天记录里塞任何东西。
 *
 * swipeId 固定 0:文件名里那一格本是「同一楼的第几个 swipe」,外部图没有楼层坐标,
 * 取 0 只为让文件名保持同一格式(图库与 sidecarPathFor 都靠格式认图)。
 * 唯一性由 genId 保证,不靠这一格。
 */
export async function saveExternalImage(
  characterName: string,
  tag: string,
  seed: number,
  result: ComfyImageResult,
  meta?: GenerationMeta,
): Promise<string> {
  const name = characterName.trim() || '未命名角色';
  const { path } = await uploadImageWithSidecar(name, 0, promptHash(tag), tag, seed, result, meta);
  return path;
}

/**
 * 完整保存流程（DESIGN-FLOOR-UI.md §7.6）：
 * 图片二进制落盘 → extra 写指针（先文件后指针，避免孤儿指针）；
 * 指针写失败则文件留作孤儿，由后续清理兜底。
 */
export async function saveImageResult(
  messageId: number,
  swipeId: number,
  seq: number,
  tag: string,
  seed: number,
  result: ComfyImageResult,
  meta?: GenerationMeta,
  ownsSlot?: () => boolean,
): Promise<BbiImageEntry> {
  const ctx = getContext();
  if (!ctx?.saveChat) throw new Error('SillyTavern 上下文不可用');
  const chatId = ctx.getCurrentChatId();
  if (!chatId) throw new Error('当前聊天不可用');

  const hash = promptHash(tag);
  const characterName = ctx.chat[messageId]?.name?.trim() || ctx.name2?.trim() || '未命名角色';
  const { path, genId, createdAt } = await uploadImageWithSidecar(
    characterName,
    swipeId,
    hash,
    tag,
    seed,
    result,
    meta,
  );
  if (ownsSlot && !ownsSlot()) throw new DOMException('生图任务已失效', 'AbortError');

  const entry: BbiImageEntry = {
    generationId: genId,
    path,
    prompt: tag,
    // 本次生成实际使用的种子（调用方生成后传入；-1 不在支持范围）
    seed,
    status: 'ready',
    createdAt,
    slotSeq: seq,
    ...(meta ? { meta } : {}),
  };

  const saved = await mutateStore(ctx, messageId, store => appendEntry(store, swipeId, hash, entry),
    seq < 0 ? swipeId : undefined);
  if (!saved) {
    console.warn('[柏宝绘] 图片已上传但 extra 写入失败，文件留作孤儿', path);
    throw new Error('图片已上传，但聊天记录保存失败');
  }
  return entry;
}

// 图库只删文件和侧写。聊天卡片通过图片加载错误处理失效引用。
export async function deleteImageFileOnly(path: string): Promise<void> {
  const target = normalizeImagePath(path);
  await deleteUserImage(target);
  const sidecar = sidecarPathFor(target);
  if (!sidecar) return;
  try {
    await deleteUploadedFile(sidecar);
  } catch (error) {
    console.warn('[柏宝绘] 删除侧写元数据失败（留作孤儿）', error);
  }
}

/**
 * 删除一条结果：先 extra 删指针并落盘，成功后再删文件（顺序相反会留下
 * 指向已删文件的破指针；文件删除失败则留作孤儿由清理兜底）。
 * 仅删除 user/images 下的文件（连同它的侧写 json），
 * 旧 user/files 图片只移除记录，保留原文件。
 */
export async function deleteImageResult(
  messageId: number,
  swipeId: number,
  hash: string,
  genId: string,
  panelSlot = false,
): Promise<boolean> {
  const ctx = getContext();
  if (!ctx?.saveChat) return false;
  let pathToDelete = '';
  const removed = await mutateStore(ctx, messageId, store => {
    const bucket = store[String(swipeId)];
    const list = bucket?.[hash];
    if (!list) return store;
    const index = list.findIndex(entry => entry.generationId === genId);
    if (index < 0) return store;
    pathToDelete = list[index].path;
    const nextList = list.filter((_, i) => i !== index);
    const next: BbiImageStore = { ...store };
    next[String(swipeId)] = { ...bucket };
    if (nextList.length) {
      next[String(swipeId)][hash] = nextList;
    } else {
      delete next[String(swipeId)][hash];
    }
    return next;
  }, panelSlot ? swipeId : undefined);
  if (!removed) return false;
  if (/^\/?user\/images\//.test(pathToDelete)) {
    try {
      await deleteUserImage(pathToDelete);
    } catch (error) {
      console.warn('[柏宝绘] 删除图片文件失败（留作孤儿）', error);
    }
    // 侧写跟着走。deleteUploadedFile 对 404 返回 false 不抛（老图本就没有侧写，属正常）
    const sidecar = sidecarPathFor(pathToDelete);
    if (sidecar) {
      try {
        await deleteUploadedFile(sidecar);
      } catch (error) {
        console.warn('[柏宝绘] 删除侧写元数据失败（留作孤儿）', error);
      }
    }
  }
  return true;
}
