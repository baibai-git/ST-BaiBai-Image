/**
 * 一次生成实际用到的「配方」快照 —— 随图落盘（侧写 json + 楼层 extra），
 * 供日后回看「这张图当时用的画师串 / vibe / 采样参数是什么」。
 *
 * 为什么存快照而不是只存引用 id：画师串配方、vibe 条目、工作流预设事后都可能被
 * 改名或删除，只存 id 的话老图就查无此人 —— 正是用户「画出一张很喜欢的图却忘了用
 * 哪个画师串/vibe」的痛点。
 *
 * 为什么单独一个叶子模块、零 import：
 * - prompt / seed 已经由 BbiImageEntry 与侧写单独存了，这里只补「不在 tag 文本里」的
 *   那部分（画师串、vibe、采样参数、模型）；
 * - settings.ts → backends/nai.ts → 本模块，依赖只能单向。若这里 import settings 的
 *   BackendId 就会成环（settings 已 import nai 的默认负面词），故 backend 用字面量联合，
 *   与 state/history.ts 的 ImageBegin 同款规避。
 */

/** 画师串快照。存正文而不只存 id：配方可能被改名/删除。 */
export interface GenerationArtist {
  id: string;
  /** 用户给配方起的显示名。 */
  name: string;
  /** 画师串正文（真正用于复现的东西）。 */
  prompt: string;
}

/** 一个实际叠加进请求的 vibe。 */
export interface GenerationVibe {
  id: string;
  name: string;
  /** 所属分组名快照；空串 = 未分组。 */
  group: string;
  /** 面板显示的配置强度（复现时用户按这个值重开）。 */
  strength: number;
  /**
   * 实际发给后端的强度：开启「参考强度归一化」且总强度 > 1 时会被按比例压小。
   * 与 strength 不同时 UI 会额外标注出来。
   */
  effectiveStrength: number;
}

/**
 * 采样参数快照。字段全部可选，两种后端各填各的 —— 加键即可扩展，不用改格式版本。
 * NAI 与 ComfyUI 对同一概念叫法不同（NAI 的 scale / ComfyUI 的 cfg）统一到 cfg，
 * 展示更直观；真正要复现的还是整台配方，不在协议字段名上抠。
 */
export interface GenerationParams {
  /** ComfyUI：simple / custom；NAI 无此键。 */
  mode?: string;
  /** ComfyUI 简易模板 id（checkpoint / flux / anima / moss）。 */
  template?: string;
  /** ComfyUI 底模 / UNet 文件名。 */
  baseModel?: string;
  vae?: string;
  /** CLIP 文件名，多选以「、」连接。 */
  clips?: string;
  /** LoRA 列表，形如「名字×强度」以「、」连接。 */
  loras?: string;
  sampler?: string;
  scheduler?: string;
  steps?: number;
  /** 提示词相关性（NAI 的 scale / ComfyUI 的 cfg）。 */
  cfg?: number;
  /** 拼进正向词末尾的质量词（NAI 解析后实际值）。 */
  quality?: string;
  /** NAI 关联性调整（cfg_rescale）。 */
  cfgRescale?: number;
  /** NAI 噪声表。 */
  noiseSchedule?: string;
  /** NAI Variety Boost。 */
  varietyBoost?: boolean;
  /** NAI 参考强度归一化。 */
  normalizeRefStrength?: boolean;
  /** ComfyUI Flux 专用引导强度。 */
  guidance?: number;
  /** ComfyUI Anima 专用 shift。 */
  shift?: number;
}

/** 随图落盘的完整出图元信息。 */
export interface GenerationMeta {
  backend: 'nai' | 'comfyui';
  /** NAI 模型名 / ComfyUI 工作流预设名。vibe 编码按模型分组，必须一起记。 */
  model: string;
  /** 实际发给后端的画幅像素；0 = 由工作流自带尺寸（ComfyUI 未解析出时）。 */
  width: number;
  height: number;
  /** 实际发送的完整正向词（NAI = 画师串 + tag + 质量词；ComfyUI 简易模式 = 固定正面 + 内容）。 */
  positive: string;
  /** 实际发送的负面词（拿不到时为空串，负面仍在 tag 文本里）。 */
  negative: string;
  /** NAI 画师串；其它后端为 null。 */
  artist: GenerationArtist | null;
  /** NAI 实际叠加的 vibe（被跳过的不在内）；其它后端为空数组。 */
  vibes: GenerationVibe[];
  params: GenerationParams;
}

/** 强度等小数展示：整数不带小数点，其余最多 3 位、去掉尾随 0。 */
function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function formatVibe(vibe: GenerationVibe): string {
  const group = vibe.group ? `(${vibe.group})` : '';
  const normalized =
    Math.abs(vibe.effectiveStrength - vibe.strength) > 1e-6
      ? `(实际 ×${round(vibe.effectiveStrength)})`
      : '';
  return `${vibe.name}${group} ×${round(vibe.strength)}${normalized}`;
}

/**
 * 把 meta 渲染成几行只读文本（图库灯箱与楼层卡片共用，避免两处口径漂移）。
 *
 * **只读展示，绝不能被写回正文**：画师串/vibe 是「这张图怎么来的」的溯源信息，
 * 不是可编辑的提示词。要改提示词请走提示词编辑器（那条路只碰 tag 正文）。
 */
export function formatGenerationMeta(meta: GenerationMeta): string {
  const lines: string[] = [];

  if (meta.artist) {
    lines.push(`画师串: ${meta.artist.name}${meta.artist.prompt ? ` · ${meta.artist.prompt}` : ''}`);
  }
  if (meta.params.quality) {
    lines.push(`质量词: ${meta.params.quality}`);
  }
  if (meta.vibes.length) {
    lines.push(`Vibe: ${meta.vibes.map(formatVibe).join('、')}`);
  }
  lines.push(`模型: ${meta.model}`);
  if (meta.width > 0 && meta.height > 0) {
    lines.push(`尺寸: ${meta.width}×${meta.height}`);
  }
  if (meta.negative) {
    lines.push(`负面: ${meta.negative}`);
  }

  const p = meta.params;
  const sampling: string[] = [];
  if (p.template) sampling.push(`模板 ${p.template}`);
  if (p.baseModel) sampling.push(`底模 ${p.baseModel}`);
  if (p.vae) sampling.push(`VAE ${p.vae}`);
  if (p.clips) sampling.push(`CLIP ${p.clips}`);
  if (p.loras) sampling.push(`LoRA ${p.loras}`);
  if (p.sampler) sampling.push(p.scheduler ? `${p.sampler}/${p.scheduler}` : p.sampler);
  if (typeof p.steps === 'number') sampling.push(`${p.steps} 步`);
  if (typeof p.cfg === 'number') sampling.push(`CFG ${round(p.cfg)}`);
  if (typeof p.cfgRescale === 'number' && p.cfgRescale > 0) sampling.push(`CFG-Rescale ${round(p.cfgRescale)}`);
  if (p.noiseSchedule) sampling.push(`噪声表 ${p.noiseSchedule}`);
  if (p.varietyBoost) sampling.push('Variety Boost');
  if (typeof p.guidance === 'number') sampling.push(`引导 ${round(p.guidance)}`);
  if (typeof p.shift === 'number') sampling.push(`Shift ${round(p.shift)}`);
  if (sampling.length) lines.push(`采样: ${sampling.join(' · ')}`);

  return lines.join('\n');
}
