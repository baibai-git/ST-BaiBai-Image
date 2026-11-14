import { describe, expect, it } from 'vitest';
import { artistPromptGist, matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import type { NaiArtistPreset } from '@/state/settings';

function preset(id: string, name = id, prompt = ''): NaiArtistPreset {
  return { id, name, prompt, quality: '', negative: '' };
}

describe('matchArtist', () => {
  it('空词恒真(不过滤)', () => {
    expect(matchArtist(preset('a', '厚涂', 'artist:wlop'), '')).toBe(true);
    expect(matchArtist(preset('a', '厚涂', 'artist:wlop'), '   ')).toBe(true);
  });

  it('按名称与画师串内容匹配,大小写不敏感', () => {
    const p = preset('a', '厚涂', 'artist:WLOP, artist:as109');
    expect(matchArtist(p, '厚涂')).toBe(true);
    expect(matchArtist(p, 'wlop')).toBe(true);
    expect(matchArtist(p, 'AS109')).toBe(true);
    expect(matchArtist(p, '油画')).toBe(false);
  });
});

describe('planArtistRemoval', () => {
  const list = [preset('a'), preset('b'), preset('c'), preset('d')];

  it('按 id 拆成剩余与被删两份,保持原顺序', () => {
    const plan = planArtistRemoval(list, new Set(['c', 'b']));
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.removed.map(p => p.id)).toEqual(['b', 'c']);
  });

  it('删除集里有不存在的 id(含内置 bi_*)→ 忽略', () => {
    const plan = planArtistRemoval(list, new Set(['bi_default', 'gone']));
    expect(plan.remaining).toHaveLength(4);
    expect(plan.removed).toEqual([]);
  });
});

describe('artistPromptGist', () => {
  it('去掉 artist: 前缀、压平空白,权重语法原样保留', () => {
    expect(artistPromptGist('artist:wlop,  Artist: as109,\n1.2::artist:ask::')).toBe('wlop, as109, 1.2::ask::');
  });

  it('空串与纯空白 → 空串(调用方显示占位)', () => {
    expect(artistPromptGist('   ')).toBe('');
  });
});
