import type { NaiVibe } from '@/state/settings';

/**
 * Vibe 分组的纯逻辑(归拢、搜索、启用集合判定),与 NaiPanel 的渲染分开放。
 *
 * 分组是「一起启用/一起折叠」的标签而非独立状态:出图只看方案的 vibeIds
 * (state/settings.ts 的 effectiveNai),组的批量动作本质是对 vibeIds
 * 的批量改写,不引入第二套真相。
 *
 * 组名是用户任意输入,不能直接当 key/哨兵用(会和「未分组」「新建分组」撞名),
 * 故一律加 `g:` 前缀装箱:带前缀的必是真实组,裸值 UNGROUPED/NEW_GROUP 必是哨兵。
 */

export const GROUP_PREFIX = 'g:';
export const UNGROUPED = 'ungrouped';
export const NEW_GROUP = 'new';

/** 组名 → 装箱 key(空名即「未分组」哨兵)。 */
export function groupKey(name: string): string {
  return name.trim() ? `${GROUP_PREFIX}${name.trim()}` : UNGROUPED;
}

export interface VibeGroup {
  /** 装箱后的 key,用于 v-for key 与折叠集合。 */
  key: string;
  /** 展示名。 */
  label: string;
  /** 真实组名(未分组为空串),批量改组时用。 */
  name: string;
  /** 搜索命中的成员,只用于渲染。 */
  items: NaiVibe[];
  /**
   * 组的全部成员(不受搜索影响)。批量动作与计数一律用它:
   * 「只开这组」若只作用于搜索命中的子集,会把同组被搜索藏起来的条目一并关掉——
   * 用户看不见的东西被悄悄改掉是最难查的一类 bug,故渲染与语义分开两个列表。
   */
  all: NaiVibe[];
}

/** 搜索命中:名字或组名子串匹配(与设置页排除列表同口径,大小写不敏感)。 */
export function matchVibe(vibe: Pick<NaiVibe, 'name' | 'group'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return vibe.name.toLowerCase().includes(q) || vibe.group.toLowerCase().includes(q);
}

/**
 * 按组归拢。顺序:有名字的组按库中首次出现的先后排,「未分组」永远垫底
 * ——它不是一个组,只是还没归类的收容区,排前面会显得像默认组。
 *
 * 搜索没命中任何成员的组不会出现;命中的组则带上全量成员(all)。
 */
export function groupVibes(vibes: readonly NaiVibe[], query = ''): VibeGroup[] {
  const map = new Map<string, VibeGroup>();
  for (const vibe of vibes) {
    if (!matchVibe(vibe, query)) continue;
    const name = vibe.group.trim();
    const key = groupKey(name);
    let group = map.get(key);
    if (!group) {
      group = { key, label: name || '未分组', name, items: [], all: [] };
      map.set(key, group);
    }
    group.items.push(vibe);
  }
  // 全量成员单独收一遍:只补进已出现的组,搜索没命中的组不凭空出现
  for (const vibe of vibes) {
    map.get(groupKey(vibe.group))?.all.push(vibe);
  }
  const groups = [...map.values()];
  return [...groups.filter(g => g.name), ...groups.filter(g => !g.name)];
}

/**
 * 「生效中」不落盘、是算出来的:当前方案的启用集合(vibeIds)恰好等于本组全部成员时才成立。
 * 库外的悬空 id 不参与比较(normalize 与删除动作会清掉它们,这里不替它们背锅)。
 * 故用户手动多勾一条之后它会自己消失,不会出现「显示生效中但实际不是」的骗人状态。
 * 空组不算生效(否则库里全空时每个空组都显示生效中)。
 */
export function isGroupActive(
  group: VibeGroup,
  vibes: readonly NaiVibe[],
  enabledIds: ReadonlySet<string>,
): boolean {
  if (!group.all.length) return false;
  const ids = new Set(group.all.map(v => v.id));
  return vibes.every(v => enabledIds.has(v.id) === ids.has(v.id));
}
