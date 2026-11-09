/**
 * 画幅方向(横屏/竖屏)与尺寸解析的共享工具。
 *
 * 分工:模型只决定「横还是竖」,具体像素由用户在各后端面板里配一对(竖屏尺寸/横屏尺寸)——
 * 不同 checkpoint 适应的分辨率不同,写死一个比例会让一半场景吃亏。
 *
 * 本模块刻意不 import settings:出图后端与协议层都要用它,
 * 依赖具体 Settings 类型会绕出循环引用。按方向取尺寸的入参用结构化约束表达。
 */

export type Orientation = 'portrait' | 'landscape';

export interface ImageSize {
  width: number;
  height: number;
}

/** 只作精确匹配的横屏缩写(太短,做子串匹配会误伤 landscape 之外的词)。 */
const LANDSCAPE_CODES = new Set(['l', 'h', 'w']);

/** 出现即判横屏的关键词(子串匹配,覆盖「横屏构图」「landscape shot」这类短语)。 */
const LANDSCAPE_WORDS = ['landscape', 'horizontal', 'widescreen', 'wide', '横', '宽屏'];

/**
 * 容忍式归一:认不出来一律 'portrait'。
 *
 * 竖屏是插件原本的固定默认(832×1216),降级到它 = 维持现状,
 * 因此模型漏给/给乱值时不该抛错——parseImagePlan 抛错会白白消耗 runner 的重试次数。
 * 也认「16:9 / 1216x832」这类比例写法:宽 > 高即横屏。
 */
export function normalizeOrientation(value: unknown): Orientation {
  if (typeof value !== 'string') return 'portrait';
  const text = value.trim().toLowerCase();
  if (!text) return 'portrait';
  if (LANDSCAPE_CODES.has(text)) return 'landscape';

  // 比例/尺寸写法:16:9、1216x832、1216×832 → 比较宽高
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*[:：×xX*]\s*(\d+(?:\.\d+)?)/);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      return a > b ? 'landscape' : 'portrait';
    }
  }

  return LANDSCAPE_WORDS.some(word => text.includes(word)) ? 'landscape' : 'portrait';
}

/**
 * 宽松尺寸解析:「1216×832 / 1216x832 / 1216*832」→ {width, height}。
 * 只做通用下限校验(整数、64–4096);后端各自的额外限制(如 NAI 要求 64 的倍数、
 * 上限 2048)由调用方在此之上再加,错误信息也由调用方给,便于贴合后端语境。
 * 解析不出返回 null,由调用方决定是报错还是降级。
 */
export function parseSize(text: string): ImageSize | null {
  const match = (text ?? '').match(/(\d{2,4})\s*[×xX*]\s*(\d{2,4})/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 64 || height < 64 || width > 4096 || height > 4096) return null;
  return { width, height };
}

/** 一对画幅尺寸配置(各出图后端各持一份)。 */
export interface SizePair {
  /** 竖屏尺寸,如 832×1216。 */
  portraitSize: string;
  /** 横屏尺寸,如 1216×832。 */
  landscapeSize: string;
}

/** 按方向取用户配置的尺寸串(未填时返回空串,由调用方决定回落)。 */
export function pickSize(pair: SizePair, orientation: Orientation): string {
  const text = orientation === 'landscape' ? pair.landscapeSize : pair.portraitSize;
  return (text ?? '').trim();
}

/**
 * 画幅锁:'auto' = 由自动 tag 按画面判定横竖(默认,即改动前的行为);
 * 'portrait' / 'landscape' = 该渠道一律出这个方向。
 *
 * 归属与尺寸对相同(NAI 渠道级一份、ComfyUI 每套工作流各一份),面板上也与横竖尺寸并排:
 * 它本质是「这对尺寸只用哪一格」。从前的替代做法是把两格填成同一个尺寸——
 * 出图是统一了,AI 却仍按横竖判据取景(锁竖时照样为群像构思宽画面)。
 */
/** Editor input only. Legacy imported canvas coordinates keep their original precision. */
export function alignMossCanvasDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(64, Math.min(8192, Math.round(value / 16) * 16)) : value;
}

export type OrientationLock = 'auto' | Orientation;

/** 容忍式归一:只认两个方向值,其余(含老数据缺字段)一律 'auto' = 维持改动前的行为。 */
export function normalizeOrientationLock(value: unknown): OrientationLock {
  return value === 'portrait' || value === 'landscape' ? value : 'auto';
}

/**
 * 实际出图方向:锁了用锁定方向,否则用 tag 里记的那个(AI 判定或用户手改)。
 *
 * 只在出图时覆盖,**tag 原文不改写**:promptHash 吃的是 tag 原文,批量改写会让老图
 * 无辜变成「旧提示词」;解锁后每张图仍按自己记的方向出。
 */
export function effectiveOrientation(lock: OrientationLock, size: Orientation): Orientation {
  return lock === 'auto' ? size : lock;
}
