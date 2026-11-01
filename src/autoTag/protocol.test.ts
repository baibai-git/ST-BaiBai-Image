import { describe, expect, it } from 'vitest';

import { injectImageTags, parseImagePlan as parseImagePlanWithRange } from '@/autoTag/protocol';

const segments = [
  { id: 'P1', sourceLine: 0, text: '第一幕结束' },
  { id: 'P2', sourceLine: 2, text: '第二幕结束' },
];

/** 大部分协议测试关注内容解析,沿用允许 0 张的默认范围;数量下限另列专门用例。 */
function parseImagePlan(
  raw: string,
  targetSegments: typeof segments,
  maxImages: number,
) {
  return parseImagePlanWithRange(raw, targetSegments, 0, maxImages);
}

describe('auto tag position protocol', () => {
  it('parses a fenced JSON response and applies the local maximum', () => {
    const raw = `说明文字\n\`\`\`json
{"images":[{"position":"P1","tag":"first scene"},{"position":"P2","tag":"second scene"}]}
\`\`\``;
    expect(parseImagePlan(raw, segments, 1)).toEqual({
      images: [
        { position: 'P1', sourceLine: 0, tag: 'first scene', nl: '', negative: '', characters: [], size: 'portrait' },
      ],
      changes: [],
    });
  });

  it('rejects a result below the configured minimum so the runner can retry', () => {
    expect(() =>
      parseImagePlanWithRange(
        '{"images":[{"position":"P1","tag":"only one"}]}',
        segments,
        2,
        3,
      ),
    ).toThrow('少于设置的最少图片数 2');
  });

  it('accepts an empty image list when the configured minimum is zero', () => {
    expect(parseImagePlanWithRange('{"images":[],"changes":[]}', segments, 0, 2)).toEqual({
      images: [],
      changes: [],
    });
  });

  it('clamps a dirty minimum to the maximum before validating', () => {
    const raw =
      '{"images":[{"position":"P1","tag":"first"},{"position":"P2","tag":"second"}]}';
    expect(parseImagePlanWithRange(raw, segments, 9, 2).images).toHaveLength(2);
  });

  it('preserves natural-language appearance when creating a character profile', () => {
    const raw = JSON.stringify({
      images: [],
      changes: [{
        name: 'A', field: 'new', fields: { hair: 'long black hair', eyes: 'blue eyes' },
        nl: 'A Chinese fixed-appearance description.', position: 'P1',
      }],
    });
    expect(parseImagePlan(raw, segments, 1).changes[0].nl).toBe('A Chinese fixed-appearance description.');
  });

  it('accepts the legacy prompt key as an alias of tag', () => {
    expect(parseImagePlan('{"images":[{"position":"P1","prompt":"scene"}]}', segments, 1)).toEqual({
      images: [{ position: 'P1', sourceLine: 0, tag: 'scene', nl: '', negative: '', characters: [], size: 'portrait' }],
      changes: [],
    });
  });

  it('keeps the optional nl part and collapses its newlines', () => {
    const raw = '{"images":[{"position":"P1","tag":"1girl","nl":"A girl.\\nShe smiles."}]}';
    expect(parseImagePlan(raw, segments, 1)).toEqual({
      images: [
        {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl',
          nl: 'A girl. She smiles.',
          negative: '',
          characters: [],
          size: 'portrait',
        },
      ],
      changes: [],
    });
  });


  it('parses V5 character prompts and drops malformed character entries only', () => {
    const raw = JSON.stringify({
      images: [{
        position: 'P1',
        tag: '2girls, classroom',
        nl: 'base scene',
        characters: [
          { name: 'A', tag: 'girl, black hair', nl: 'left' },
          { name: '', tag: 'girl' },
          { name: 'B', prompt: 'girl, silver hair' },
        ],
      }],
    });
    expect(parseImagePlan(raw, segments, 1).images[0].characters).toEqual([
      { name: 'A', tag: 'girl, black hair', nl: 'left' },
      { name: 'B', tag: 'girl, silver hair', nl: '' },
    ]);
  });

  it('takes the landscape orientation from the size key', () => {
    const raw = '{"images":[{"position":"P1","tag":"2girls","size":"landscape"}]}';
    expect(parseImagePlan(raw, segments, 1)).toEqual({
      images: [
        { position: 'P1', sourceLine: 0, tag: '2girls', nl: '', negative: '', characters: [], size: 'landscape' },
      ],
      changes: [],
    });
  });

  it('falls back to portrait for a missing or garbled size instead of throwing', () => {
    // 为方向抛错会白白吃掉 runner 的重试次数,所以一律容忍降级
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a"}]}', segments, 1).images[0].size).toBe('portrait');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":"随便"}]}', segments, 1).images[0].size).toBe('portrait');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":123}]}', segments, 1).images[0].size).toBe('portrait');
  });

  it('still reads the orientation out of loose Chinese wording', () => {
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":"横屏"}]}', segments, 1).images[0].size).toBe('landscape');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","size":"竖版"}]}', segments, 1).images[0].size).toBe('portrait');
  });

  it('accepts orientation/aspect as aliases of size', () => {
    expect(
      parseImagePlan('{"images":[{"position":"P1","tag":"a","orientation":"landscape"}]}', segments, 1).images[0].size,
    ).toBe('landscape');
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a","aspect":"16:9"}]}', segments, 1).images[0].size).toBe(
      'landscape',
    );
  });

  it('normalizes lowercase position IDs and accepts id as an alias', () => {
    expect(parseImagePlan('{"images":[{"id":"p2","tag":"scene"}]}', segments, 1).images[0]).toMatchObject({
      position: 'P2',
      sourceLine: 2,
    });
  });

  it('rejects positions missing from the target source', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"P9","tag":"scene"}]}', segments, 2),
    ).toThrow('不在目标正文');
  });

  it('rejects malformed position IDs', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"第二段","tag":"scene"}]}', segments, 2),
    ).toThrow('P编号');
  });

  it('rejects nested bbi tags in prompts', () => {
    expect(() =>
      parseImagePlan(
        '{"images":[{"position":"P1","tag":"<bbi_image>bad</bbi_image>"}]}',
        segments,
        1,
      ),
    ).toThrow('不得包含');
  });

  it('rejects sub-tag literals in the nl part', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"P1","tag":"ok","nl":"bad</nl>"}]}', segments, 1),
    ).toThrow('不得包含');
  });

  it('rejects a fake size sub-tag smuggled into the tag text', () => {
    expect(() =>
      parseImagePlan('{"images":[{"position":"P1","tag":"1girl<size>landscape</size>"}]}', segments, 1),
    ).toThrow('不得包含');
  });

  it('keeps the optional dynamic negative part and accepts negative_prompt as an alias', () => {
    const raw =
      '{"images":[{"position":"P1","tag":"1girl","negative_prompt":"extra people, duplicate"}]}';
    expect(parseImagePlan(raw, segments, 1).images[0].negative).toBe('extra people, duplicate');
  });

  it('rejects sub-tag literals in the negative part', () => {
    expect(() =>
      parseImagePlan(
        '{"images":[{"position":"P1","tag":"ok","negative":"bad</negative>"}]}',
        segments,
        1,
      ),
    ).toThrow('不得包含');
  });

  it('inserts multiple tags after the same line in array order', () => {
    expect(
      injectImageTags('第一行\n第二行', [
        { position: 'P1', sourceLine: 0, tag: 'prompt a', nl: '', negative: '', characters: [], size: 'portrait' },
        { position: 'P1', sourceLine: 0, tag: 'prompt b', nl: '', negative: '', characters: [], size: 'landscape' },
      ]),
    ).toBe(
      '第一行\n<bbi_image>prompt a<size>portrait</size></bbi_image>\n<bbi_image>prompt b<size>landscape</size></bbi_image>\n第二行',
    );
  });

  it('wraps the nl part in a <nl> sub-tag, keeping the tag part bare', () => {
    expect(
      injectImageTags('第一行', [
        {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl, moonlight',
          nl: 'A girl in moonlight.',
          negative: '',
          characters: [],
          size: 'portrait',
        },
      ]),
    ).toBe(
      '第一行\n<bbi_image>1girl, moonlight<nl>A girl in moonlight.</nl><size>portrait</size></bbi_image>',
    );
  });

  it('wraps the dynamic negative part in a <negative> sub-tag', () => {
    expect(
      injectImageTags('第一行', [
        {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl',
          nl: '',
          negative: 'extra people, duplicate character',
          characters: [],
          size: 'portrait',
        },
      ]),
    ).toBe(
      '第一行\n<bbi_image>1girl<negative>extra people, duplicate character</negative><size>portrait</size></bbi_image>',
    );
  });


  it('serializes V5 character prompts as a JSON sub-tag', () => {
    const output = injectImageTags('line', [{
      position: 'P1', sourceLine: 0, tag: '1girl', nl: 'base', negative: '',
      characters: [{ name: 'A', tag: 'girl, black hair', nl: 'left' }], size: 'portrait',
    }]);
    expect(output).toContain('<characters>[{"name":"A","tag":"girl, black hair","nl":"left"}]</characters>');
  });

  it('preserves CRLF and appends correctly after the final line', () => {
    expect(
      injectImageTags('第一行\r\n\r\n第三行', [
        { position: 'P1', sourceLine: 0, tag: 'prompt a', nl: '', negative: '', characters: [], size: 'portrait' },
        { position: 'P2', sourceLine: 2, tag: 'prompt c', nl: '', negative: '', characters: [], size: 'portrait' },
      ]),
    ).toBe(
      '第一行\r\n<bbi_image>prompt a<size>portrait</size></bbi_image>\r\n\r\n第三行\r\n<bbi_image>prompt c<size>portrait</size></bbi_image>',
    );
  });
});

describe('changes parsing', () => {
  it('parses valid character changes alongside images', () => {
    const raw =
      '{"images":[{"position":"P1","tag":"@小雪"}],"changes":[{"name":"小雪","field":"hair","value":"short black hair","position":"P2","reason":"剪了短发"}]}';
    expect(parseImagePlan(raw, segments, 1).changes).toEqual([
      {
        name: '小雪',
        field: 'hair',
        value: 'short black hair',
        nl: undefined,
        reason: '剪了短发',
        position: 'P2',
        sourceLine: 2,
      },
    ]);
  });

  it('accepts structured new-entry changes with required identity fields', () => {
    const raw =
      '{"images":[],"changes":[{"name":"结构角色","field":"new","fields":{"sex":"1girl","hair":"long blonde hair","eyes":"blue eyes","bogus":"drop"},"position":"P1","reason":"建档"}]}';
    expect(parseImagePlan(raw, segments, 1).changes).toEqual([
      {
        name: '结构角色',
        field: 'new',
        value: '{"sex":"1girl","hair":"long blonde hair","eyes":"blue eyes"}',
        nl: undefined,
        reason: '建档',
        position: 'P1',
        sourceLine: 0,
      },
    ]);
  });

  it('drops unusable new profiles without failing the whole plan', () => {
    // 建档坏一条只该丢这条:为它作废整次输出会连图一起没有,那是更坏的结果
    const raw =
      '{"images":[{"position":"P1","tag":"a"}],"changes":[{"name":"旧格式","field":"new","value":"1girl, red eyes","position":"P1"},{"name":"缺瞳色","field":"new","fields":{"hair":"long black hair"},"position":"P1"}]}';
    const plan = parseImagePlan(raw, segments, 1);
    expect(plan.changes).toEqual([]);
    expect(plan.images).toHaveLength(1);
  });

  it('treats a new profile as floor-wide, defaulting a missing or unknown position', () => {
    // 建档不是「从某处开始」的变化,位置只作记录 —— 缺了/坏了都不该丢掉这条档案
    const raw =
      '{"images":[],"changes":[{"name":"无位置","field":"new","fields":{"hair":"silver hair","eyes":"red eyes"}},{"name":"坏位置","field":"new","fields":{"hair":"black hair","eyes":"blue eyes"},"position":"P9"}]}';
    expect(parseImagePlan(raw, segments, 1).changes).toMatchObject([
      { name: '无位置', field: 'new', position: 'P1', sourceLine: 0 },
      { name: '坏位置', field: 'new', position: 'P1', sourceLine: 0 },
    ]);
  });

  it('drops permanent changes without a valid effective position', () => {
    // 永久变化必须知道从哪一格开始生效,位置坏 = 无法定位 = 丢弃(但不连累 images)
    const raw =
      '{"images":[{"position":"P1","tag":"a"}],"changes":[{"name":"小雪","field":"hair","value":"red hair"},{"name":"小雪","field":"eyes","value":"red eyes","position":"P9"}]}';
    const plan = parseImagePlan(raw, segments, 1);
    expect(plan.changes).toEqual([]);
    expect(plan.images).toHaveLength(1);
  });

  it('drops invalid change records but keeps the rest', () => {
    const raw =
      '{"images":[],"changes":[{"name":"","field":"hair","value":"x"},{"name":"A","field":"bogus","value":"x"},{"name":"B","field":"hair","value":"ok","position":"P1","reason":"r"},"junk",{"name":"C","field":"nl","nl":"a girl with long hair","position":"P2"}]}';
    expect(parseImagePlan(raw, segments, 1).changes).toEqual([
      {
        name: 'B',
        field: 'hair',
        value: 'ok',
        nl: undefined,
        reason: 'r',
        position: 'P1',
        sourceLine: 0,
      },
      {
        name: 'C',
        field: 'nl',
        value: '',
        nl: 'a girl with long hair',
        reason: '',
        position: 'P2',
        sourceLine: 2,
      },
    ]);
  });

  it('missing changes key yields an empty array', () => {
    expect(parseImagePlan('{"images":[{"position":"P1","tag":"a"}]}', segments, 1).changes).toEqual([]);
  });

  it('no longer requires a character audit array', () => {
    expect(parseImagePlan('{"images":[],"changes":[]}', segments, 1)).toEqual({
      images: [],
      changes: [],
    });
  });
});


it('关闭动态负面词时丢弃AI误返回的negative及别名，包括其中的无效子标签', () => {
  const segments = [{ id: 'P1', sourceLine: 0, text: '正文' }];
  const raw = JSON.stringify({ images: [{ position: 'P1', tag: 'a quiet room', negative_prompt: 'bad</negative>' }] });
  const plan = parseImagePlanWithRange(raw, segments, 0, 1, false);
  expect(plan.images[0].negative).toBe('');
});
