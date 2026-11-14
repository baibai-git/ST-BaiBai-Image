import { describe, expect, it } from 'vitest';

import {
  bakeAppearance,
  buildMossPrompt,
  comicAppearance,
  serializeComicLayout,
  toAbsCentralized,
  validateComicLayout,
  type ComicLayout,
} from './mossLayout';

describe('toAbsCentralized', () => {
  // 期望值由 nodes_moss_image.py 的同一公式在 Python 里算出(floor/ceil(round(v*size/1000, 9)) - size//2)
  it('matches the native MOSS node formula', () => {
    expect(toAbsCentralized([333, 117, 667, 883], 1024, 1536)).toEqual([-257, -393, 257, 393]);
    expect(toAbsCentralized([0, 0, 500, 1000], 1024, 1536)).toEqual([-768, -512, 0, 512]);
    expect(toAbsCentralized([0, 0, 1000, 1000], 1216, 832)).toEqual([-416, -608, 416, 608]);
    expect(toAbsCentralized([7, 3, 993, 997], 1360, 768)).toEqual([-379, -676, 379, 676]);
  });
});

describe('validateComicLayout', () => {
  it('normalizes bbox: rounds, clamps to 0–1000, and fixes reversed pairs', () => {
    const layout = validateComicLayout({
      summary: 'manga page',
      items: [{ label: 'character', caption: 'a girl', bbox: [600.4, -20, 100, 1200] }],
    });
    expect(layout.items[0].bbox).toEqual([100, 0, 600, 1000]);
  });

  it('rejects a zero-area bbox and unknown labels', () => {
    expect(() =>
      validateComicLayout({ summary: 's', items: [{ label: 'character', caption: 'c', bbox: [5, 0, 5, 9] }] }),
    ).toThrow(/面积为 0/);
    expect(() =>
      validateComicLayout({ summary: 's', items: [{ label: 'panel', caption: 'c', bbox: [0, 0, 9, 9] }] }),
    ).toThrow(/label/);
  });

  it('requires text on text items and defaults their caption', () => {
    expect(() =>
      validateComicLayout({ summary: 's', items: [{ label: 'text', caption: 'bubble', bbox: [0, 0, 9, 9] }] }),
    ).toThrow(/text 不能为空/);
    const layout = validateComicLayout({ summary: 's', items: [{ label: 'text', text: '你好', bbox: [0, 0, 9, 9] }] });
    expect(layout.items[0]).toEqual({ label: 'text', caption: 'speech bubble', text: '你好', bbox: [0, 0, 9, 9] });
  });

  it('refuses bbi_image sub-tag literals that would break the host tag', () => {
    expect(() => validateComicLayout({ summary: 'a </bbi_image> b', items: [] })).toThrow(/bbi_image/);
    expect(() => validateComicLayout({ summary: 'a </layout> b', items: [] })).toThrow(/bbi_image/);
  });

  it('accepts the native {"summary":{"caption":…}} shape too', () => {
    expect(validateComicLayout({ summary: { caption: 'page' }, items: [] }).summary).toBe('page');
  });

  it('keeps name only on character items and has no item cap', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      label: index % 2 ? 'object' : 'character',
      name: '小雪',
      caption: `c${index}`,
      bbox: [0, 0, 10, 10],
    }));
    const layout = validateComicLayout({ summary: 's', items });
    expect(layout.items).toHaveLength(40);
    expect(layout.items[0].name).toBe('小雪');
    expect(layout.items[1].name).toBeUndefined();
  });

  it('round-trips through serializeComicLayout byte-for-byte', () => {
    const raw = serializeComicLayout(
      validateComicLayout({
        summary: 'page',
        items: [
          { label: 'character', name: '小雪', caption: 'smiles', bbox: [0, 0, 500, 1000] },
          { label: 'text', caption: 'speech bubble', text: '你回来啦?', bbox: [40, 600, 200, 960] },
        ],
      }),
    );
    expect(serializeComicLayout(validateComicLayout(JSON.parse(raw)))).toBe(raw);
  });
});

describe('buildMossPrompt', () => {
  const layout: ComicLayout = {
    summary: 'full color manga page',
    items: [
      { label: 'character', name: '小雪', caption: 'white hair girl smiling', bbox: [0, 0, 500, 1000] },
      { label: 'text', caption: 'speech bubble', text: '你回来啦?', bbox: [40, 600, 200, 960] },
    ],
  };

  it('emits the native node JSON: key order, centralized pixels, raw unicode, no name', () => {
    expect(buildMossPrompt(layout, 1024, 1536, 'masterpiece')).toBe(
      '{"summary":{"caption":"masterpiece, full color manga page"},"items":[' +
        '{"label":"character","caption":"white hair girl smiling","bbox":[-768,-512,0,512]},' +
        '{"label":"text","caption":"speech bubble","text":"你回来啦?","bbox":[-707,102,-460,472]}' +
        '],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}',
    );
  });

  it('falls back to the plain caption when there are no items', () => {
    expect(buildMossPrompt({ summary: 'a quiet street', items: [] }, 1024, 1536, ' style ')).toBe(
      'style, a quiet street',
    );
  });
});

describe('comicAppearance', () => {
  const fields = { fandom: 'hoshino_(blue_archive)', sex: '1girl', hair: 'white hair', eyes: 'blue eyes' };

  // 插画时期的 nl 常是中文概述、且不随字段变化更新;字段才是准的
  it('prefers fields over nl, and uses nl only when fields are empty', () => {
    const nl = '16岁少女，一头长及腰际的粉白色长发，眼眸明亮。';
    expect(comicAppearance({ fields, raw: '', nl })).toBe('a girl with white hair, blue eyes');
    expect(comicAppearance({ fields: {}, raw: 'pink hair', nl })).toBe('16岁少女，一头长及腰际的粉白色长发，眼眸明亮');
    expect(comicAppearance({ fields: { sex: '1girl' }, raw: '', nl: 'A girl with silver hair. ' })).toBe(
      'A girl with silver hair',
    );
  });

  it('builds a subject phrase from fields without fandom, and unescapes parentheses', () => {
    expect(comicAppearance({ fields, raw: '', nl: '' })).toBe('a girl with white hair, blue eyes');
    expect(comicAppearance({ fields: {}, raw: 'hoshino \\(blue archive\\), pink hair', nl: '' })).toBe(
      'hoshino (blue archive), pink hair',
    );
  });

  // 逗号 tag 流(1girl, …)在一页多人时串人:动作找不到主语。句子形态让烤进去的外貌当主语
  it('reads as a sentence the caption can continue', () => {
    const look = comicAppearance({
      fields: { sex: '1boy', hair: 'short black hair', eyes: 'grey eyes', outfit: 'navy school blazer' },
      raw: '',
      nl: '',
    });
    expect(look).toBe('a boy with short black hair, grey eyes, wearing navy school blazer');
    expect(bakeAppearance('waves at the camera', look)).toBe(
      'a boy with short black hair, grey eyes, wearing navy school blazer, waves at the camera',
    );
    // 认不出的 sex 不丢,留作特征;主语回落 a person
    expect(comicAppearance({ fields: { sex: 'androgynous', hair: 'silver hair' }, raw: '', nl: '' })).toBe(
      'a person with androgynous, silver hair',
    );
    expect(comicAppearance({ fields: { sex: '1girl', outfit: 'red dress' }, raw: '', nl: '' })).toBe(
      'a girl, wearing red dress',
    );
  });

  it('bakeAppearance prepends once', () => {
    expect(bakeAppearance('waves', 'white hair')).toBe('white hair, waves');
    expect(bakeAppearance('white hair, waves', 'white hair')).toBe('white hair, waves');
    expect(bakeAppearance('waves', '')).toBe('waves');
  });
});
