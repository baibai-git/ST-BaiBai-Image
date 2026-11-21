import { describe, expect, it } from 'vitest';

import { groupVibes, isGroupActive, matchVibe } from '@/backends/vibeGroups';
import type { NaiVibe } from '@/state/settings';

function vibe(id: string, group = '', enabled = false, name = id): NaiVibe {
  return {
    id,
    name,
    dataPath: `/user/files/${id}.json`,
    thumbnailPath: '',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: `fp-${id}`,
    strength: 0.6,
    enabled,
    group,
  };
}

describe('matchVibe', () => {
  it('空查询全部命中', () => {
    expect(matchVibe(vibe('a'), '')).toBe(true);
    expect(matchVibe(vibe('a'), '   ')).toBe(true);
  });

  it('名字或组名子串命中,大小写不敏感', () => {
    const v = { name: 'Sunset Girl', group: '风景组' };
    expect(matchVibe(v, 'sunset')).toBe(true);
    expect(matchVibe(v, 'GIRL')).toBe(true);
    expect(matchVibe(v, '风景')).toBe(true);
    expect(matchVibe(v, '战斗')).toBe(false);
  });
});

describe('groupVibes', () => {
  it('名为 ungrouped 的分组不与未分组的图片混在一起', () => {
    const groups = groupVibes([vibe('named', 'ungrouped'), vibe('loose', '   ')]);
    expect(groups.map(group => [group.label, group.all.map(item => item.id)])).toEqual([
      ['ungrouped', ['named']], ['未分组', ['loose']],
    ]);
  });

  it('按组归拢,未分组永远垫底', () => {
    const groups = groupVibes([
      vibe('1'),
      vibe('2', '战斗组'),
      vibe('3'),
      vibe('4', '日常组'),
      vibe('5', '战斗组'),
    ]);
    expect(groups.map(g => g.label)).toEqual(['战斗组', '日常组', '未分组']);
    expect(groups[0].all.map(v => v.id)).toEqual(['2', '5']);
    expect(groups[2].all.map(v => v.id)).toEqual(['1', '3']);
  });

  it('有名字的组按库中首次出现顺序排', () => {
    const groups = groupVibes([vibe('1', 'Z组'), vibe('2', 'A组')]);
    expect(groups.map(g => g.label)).toEqual(['Z组', 'A组']);
  });

  it('搜索只收窄 items,all 始终是全量成员', () => {
    const groups = groupVibes(
      [vibe('1', '战斗组', false, '剑光'), vibe('2', '战斗组', false, '火焰'), vibe('3', '日常组', false, '咖啡')],
      '剑',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(v => v.id)).toEqual(['1']);
    // 关键:同组被搜索藏起来的「火焰」仍在 all 里,批量动作才不会把它误关
    expect(groups[0].all.map(v => v.id)).toEqual(['1', '2']);
  });

  it('搜索没命中的组不出现', () => {
    const groups = groupVibes([vibe('1', '战斗组', false, '剑光'), vibe('2', '日常组', false, '咖啡')], '咖啡');
    expect(groups.map(g => g.label)).toEqual(['日常组']);
  });

  it('按组名搜索能带出整组', () => {
    const groups = groupVibes([vibe('1', '战斗组', false, '剑光'), vibe('2', '战斗组', false, '火焰')], '战斗');
    expect(groups[0].items).toHaveLength(2);
  });

  it('组名首尾空格归一到同一组', () => {
    const groups = groupVibes([vibe('1', '战斗组'), vibe('2', ' 战斗组 ')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].all.map(v => v.id)).toEqual(['1', '2']);
  });

  it('空库返回空数组', () => {
    expect(groupVibes([])).toEqual([]);
  });
});

describe('isGroupActive', () => {
  it('启用集合恰好等于本组全部成员时才算生效', () => {
    const vibes = [vibe('1', '战斗组', true), vibe('2', '战斗组', true), vibe('3', '日常组', false)];
    const [battle, daily] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(true);
    expect(isGroupActive(daily, vibes)).toBe(false);
  });

  it('组外多开一条即不再生效(不会显示骗人的生效中)', () => {
    const vibes = [vibe('1', '战斗组', true), vibe('2', '日常组', true)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('组内漏开一条也不算生效', () => {
    const vibes = [vibe('1', '战斗组', true), vibe('2', '战斗组', false)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('搜索期间的判定仍按全量成员算', () => {
    const vibes = [vibe('1', '战斗组', true, '剑光'), vibe('2', '战斗组', false, '火焰')];
    // 搜索只剩「剑光」,但「火焰」未启用 → 整组不算生效
    const [battle] = groupVibes(vibes, '剑');
    expect(battle.items).toHaveLength(1);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('全部未启用时不算生效', () => {
    const vibes = [vibe('1', '战斗组', false)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });
});
