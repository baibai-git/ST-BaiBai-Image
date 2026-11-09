import type { BackendConn } from './types';
import type { OrientationLock } from '@/backends/size';
/**
 * NAI 生图模型标识。
 *
 * ⚠ 类型故意比下拉表宽:4.5 以下(4-full / 4-curated-preview / nai-diffusion-3)已从
 * NAI_MODELS 撤下,但标识留在类型里 —— backends/nai.ts 的协议分支(NAI3 发参考原图、
 * 原版 NAI4 不发 Character Prompts)与其回归测试仍按这些字符串区分代数。
 * 「能不能选中」一律以 NAI_MODELS 为准,它同时是 normalizeNai 的白名单。
 */
export type NaiModel =
  | 'nai-diffusion-5-full'
  | 'nai-diffusion-5-curated'
  | 'nai-diffusion-4-5-full'
  | 'nai-diffusion-4-5-curated'
  | 'nai-diffusion-4-full'
  | 'nai-diffusion-4-curated-preview'
  | 'nai-diffusion-3';

export type NaiVibeEncodings = Record<string, { encoding: string; infoExtracted: number }>;

/** Vibe 大数据正文:存 ST user/files，失败时回退本机 IndexedDB；不进入 extension_settings。 */
export interface NaiVibeData {
  /** 参考原图 base64(不含 data: 前缀):NAI3 直接使用。 */
  image: string;
  /** 缩略图 dataURL。 */
  thumbnail: string;
  /** 按模型分组的编码数据。 */
  encodings: NaiVibeEncodings;
}

/** Vibe 设置索引:只含小型元数据和正文文件路径。 */
export interface NaiVibe {
  id: string;
  /** 显示名(默认取 .naiv4vibe 的 name 或「Vibe-N」)。 */
  name: string;
  /** ST user/files 正文路径，或 `idb:` 开头的本机回退引用。 */
  dataPath: string;
  /** ST user/files 下的小缩略图路径；本机回退时为空。 */
  thumbnailPath: string;
  /** 正文包含的模型编码键。 */
  modelKeys: string[];
  /** 正文是否包含参考原图。 */
  hasImage: boolean;
  /** 编码内容指纹，用于无需读取正文的迁移去重。 */
  fingerprint: string;
  /** 参考强度 0–1。 */
  strength: number;
  /** 生成时是否叠加此 vibe。 */
  enabled: boolean;
  /**
   * 所属分组名(空串 = 未分组)。
   *
   * 刻意用扁平字符串而非独立的 groups 数组:组只是「一起启用/一起折叠」的标签,
   * 没有自身属性,存成引用就得额外维护「组删了成员怎么办」。改名/删组都是对
   * 本字段的批量赋值,天然不会产生悬空引用。
   *
   * 代价:一条 vibe 只属于一个组,且同一张图无法在两组里用不同强度
   * (strength 挂在 vibe 上而非成员关系上)。现状本就如此,真有需要再升级。
   */
  group: string;
}

/**
 * 一条具名画风配方:画师串 + 可选绑定的正面质量词/负面提示词。
 * 下拉切换时三者一起生效——一套配方即用户的一套完整画风搭配。
 *
 * 为什么不按模型分表:官方推荐词是**模型的属性**,切模型必须跟着换
 * (见 nai.ts 的 QUALITY_TAGS / DEFAULT_UNDESIRED_CONTENT);配方是**用户自己的搭配**,
 * 跨模型复用才是常态。故做成可增删的库,而非 Record<model, …>。
 *
 * 绑定字段的回落链(与渠道级「留空 = 跟随官方」同口径,逐级往下):
 *   配方绑定值 → 渠道级覆盖值(qualityTags / undesiredContent)→ 内置默认(当前 = 模型官方词)。
 * 空串 = 跟随下一级;解析汇聚在 nai.ts 的 naiQualityTags / naiUndesiredContent,
 * 以后内置默认要换成插件自己的精选词,只改 naiDefaultQualityTags / naiDefaultUndesired,
 * 链结构与存储口径都不变。老数据没有这两个字段,normalize 补空串即零变化。
 */
export interface NaiArtistPreset {
  id: string;
  /** 显示名(下拉列表与切换用;允许重名,以 id 为键)。 */
  name: string;
  /** 画师/画风 tag 串,拼在正向提示词最前面;留空的条目在拼装时等同于没选。 */
  prompt: string;
  /** 绑定的正面质量词;空串 = 跟随渠道级 qualityTags。 */
  quality: string;
  /** 绑定的负面提示词;空串 = 跟随渠道级 undesiredContent。 */
  negative: string;
  /**
   * 预览图路径(/api/images/upload 落在 user/images/柏宝绘_画师串/ 的相对路径)。
   * 可选:老数据没有此键;空 = 管理器卡片显示占位。文件归属随条目:
   * 删条目时按此路径删文件;复制条目不带走(否则两条目共指一个文件,删一边另一边破图)。
   */
  previewPath?: string;
}

/**
 * 一条 NAI 接入点:只有地址与密钥。
 *
 * 为什么**只**把 url/key 拆成多条、模型/采样器/尺寸一概留在渠道级:公益站之间换的是
 * 「从哪儿发、用谁的额度」,协议与参数完全一致。参数若跟着接入点走,换个站就得把
 * 步数/画师串/vibe 重配一遍,而用户要的恰恰是「同一套设置换个出口」。
 */
export interface NaiEndpoint {
  id: string;
  /** 显示名(下拉切换用;允许重名,以 id 为键)。 */
  name: string;
  /** 接口地址;内置官方那条恒为 NAI_OFFICIAL_URL。 */
  url: string;
  /** 该站的 API Key(公益站各有各的 key,故随条目走而非渠道级共用一份)。 */
  key: string;
}

/** NAI 连接与出图参数。接入点(地址+密钥)可存多条,见 endpoints。 */
export interface NaiSettings extends BackendConn {
  /**
   * 接入点列表。**不变式:恒非空,且必含内置官方那条**(normalize 缺则补回列表首位)。
   * 官方条不可删,故 UI 不必处理「删空了怎么办」——与 ComfyUI 工作流库的恒非空同构,
   * 与画师串库的「允许为空」相反:没有地址就出不了图,它是必需品。
   */
  endpoints: NaiEndpoint[];
  /** 当前使用的接入点 id;悬空时由 normalize 回落到第一条(地址是必需品,不能落空)。 */
  activeEndpointId: string;
  /**
   * 【存量字段,已不参与出图】老版本的单一渠道密钥。
   *
   * 出图一律走 effectiveNai()(取 endpoints 里当前那条),这两个键(key 与继承自
   * BackendConn 的 url)留着**只为回滚**:装回旧版本时配置还在。迁移是纯加法、不清空
   * ——与 negativePrompt 并框那次刻意不同:那边是「同一个框换了位置」,留着会让人以为
   * 两份都生效;这里 UI 上压根不再显示它们,不存在误解。
   */
  key: string;
  model: NaiModel;
  /** 负面提示词覆盖值;留空 = 按模型取官方负面词(见 nai.ts naiDefaultUndesired)。 */
  undesiredContent: string;
  sampler: string;
  steps: number;
  /** 提示词相关性(CFG scale)。 */
  scale: number;
  /** 关联性调整(cfg_rescale,0–1)。 */
  cfgRescale: number;
  /** 噪声表(karras/native/exponential/polyexponential)。 */
  noiseSchedule: string;
  /** 固定种子;0 = 每次随机。 */
  seed: number;
  /** Variety Boost(skip_cfg_above_sigma,按尺寸与模型自动算 magic 值)。 */
  varietyBoost: boolean;
  /** 参考强度归一化:多个 vibe 强度总和超过 1 时按比例压回 1。 */
  normalizeRefStrength: boolean;
  /**
   * 同时出图数(1–4,默认 1)。NAI 的 generate-image 是阻塞式请求、服务端不排队,
   * 并发压过去容易吃 429,故由客户端闸门限流(floor/genQueue.ts)。
   * ComfyUI 无此设置:它有服务端队列,一次性全发即可。
   */
  concurrency: number;
  /** Vibe 库索引；正文存在 ST user/files，设置中不存大 Base64。 */
  vibes: NaiVibe[];
  /**
   * 画风配方库(画师串 + 可选绑定的正/负面词)。**与 ComfyUI 工作流库相反:允许为空**——
   * 工作流不给就没法出图,故那边有「恒非空」不变式;配方不给只是不加画风,是可选调味。
   * 这里只存**用户自己的**配方;官方推荐的内置配方在 backends/nai.ts 的
   * BUILTIN_NAI_ARTISTS(只读、随版本更新),不进 settings——不然默认值会冻在
   * 每个用户的设备上,以后想调都得做指纹迁移。
   */
  artistPresets: NaiArtistPreset[];
  /**
   * 当前使用的画师串 id。**空串 = 不使用画师串**,是有意义的存储值。
   * 合法值域:{''} ∪ 用户库 id ∪ 内置库 id(bi_*);其余一律由 normalizeNai 清成空串——
   * 刻意**不**像 activeWorkflowId 那样回落第一条:那会给用户静默套上一套
   * 他没选过的画风,每张图都变样却查不出原因。
   */
  activeArtistId: string;
  /**
   * 生成自然语言(仅 4.5/V5 有意义,默认开 = 改动前的行为):开 = 自动 tag 为 Base 与每个角色
   * 写英文 nl;关 = 只写 tag。与 ComfyUI 工作流的同名开关同一口径——**只管 AI 写不写,
   * 不管发不发**:tag 里已有的 nl 照常发送(想对比就清掉 nl 或「AI 重写提示词」)。
   * 关它不影响原生多角色提示(characters[]),那是模型能力,不是写法。
   * 存在理由:4.5 的提示词预算(约 512 token,Base 与全部角色共用)比 V5 紧得多,
   * nl 是最大头,超了会被截断、画面跟着走样。
   */
  naturalLanguage: boolean;
  /** 画幅锁(渠道级,面板上与横竖尺寸并排);语义见 size.ts 的 OrientationLock。 */
  orientationLock: OrientationLock;
}
