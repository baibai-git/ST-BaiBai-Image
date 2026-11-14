import type { NaiArtistPreset } from '@/state/settings';

/**
 * 画师串库的纯逻辑(搜索匹配 / 删除规划 / 无图卡片的文字摘要)。
 * 与交互解耦,便于单测;NaiArtistLibrary.vue(管理)与 NaiArtistPicker.vue(选用)只做交互与落盘。
 */

/**
 * 搜索匹配:名称 + 画师串内容,大小写不敏感的子串匹配;空词恒真(= 不过滤)。
 * 绑定的正/负面词不参与——用户记画风靠的是名字和那串 artist tag,
 * 匹配面铺得越广,「明明搜到了」与「这怎么也命中」的意外都越多。
 */
export function matchArtist(
  preset: Pick<NaiArtistPreset, 'name' | 'prompt'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return preset.name.toLowerCase().includes(q) || preset.prompt.toLowerCase().includes(q);
}

export interface ArtistRemovalPlan {
  /** 删除后的库(保持原顺序)。 */
  remaining: NaiArtistPreset[];
  /** 实际被删的条目(调用方据此清理预览图文件)。 */
  removed: NaiArtistPreset[];
}

/**
 * 规划一次删除(单条与批量共用)。removedIds 之外的条目不碰;内置 bi_* 不在用户库里,天然删不到。
 *
 * 引用了被删条目的方案一律清成「不使用」,**不**接位到邻居:库是在设置面板里管的,
 * 删的时候没在看任何一套方案,替它们挑一条新画风就是静默改动(每张图都变样却查不出原因)。
 */
export function planArtistRemoval(
  list: readonly NaiArtistPreset[],
  removedIds: ReadonlySet<string>,
): ArtistRemovalPlan {
  return {
    remaining: list.filter(a => !removedIds.has(a.id)),
    removed: list.filter(a => removedIds.has(a.id)),
  };
}

/**
 * 没有预览图的卡片拿什么认:把画师串本身铺上去,去掉满屏重复的 `artist:` 前缀
 * (权重语法原样保留,那也是画风的一部分)。空串由调用方显示占位。
 */
export function artistPromptGist(prompt: string): string {
  return prompt
    .replace(/artist:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
