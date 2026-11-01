import { describe, expect, it } from 'vitest';

import {
  cleanHistoryText,
  cleanTargetText,
  prepareTargetText,
  stripCustomTags,
} from '@/autoTag/clean';

describe('stripCustomTags', () => {
  it('配对块整删(含内部内容)', () => {
    expect(stripCustomTags('前文\n<snow>状态栏内容</snow>\n后文', ['snow'])).toBe('前文\n\n后文');
  });

  it('落单开/闭/自闭标签:只删标签本身', () => {
    expect(stripCustomTags('<snow>内容无闭合', ['snow'])).toBe('内容无闭合');
    expect(stripCustomTags('内容</snow>', ['snow'])).toBe('内容');
    expect(stripCustomTags('内容<snow/>', ['snow'])).toBe('内容');
  });

  it('中文标签名同样生效(前瞻而非词边界)', () => {
    expect(stripCustomTags('<雪>飘雪特效</雪>正文', ['雪'])).toBe('正文');
  });

  it('边界前瞻:不误吃同名前缀标签(<snow> 不吃 <snowball>)', () => {
    expect(stripCustomTags('<snowball>保留</snowball>', ['snow'])).toBe('<snowball>保留</snowball>');
  });

  it('带属性的开标签也整块删除', () => {
    expect(stripCustomTags('前<snow class="bar">内容</snow>后', ['snow'])).toBe('前后');
  });

  it('大小写不敏感', () => {
    expect(stripCustomTags('<SNOW>内容</SNOW>', ['snow'])).toBe('');
  });

  it('空名单 / 无匹配标签:原样返回', () => {
    const s = '<think>思维链</think>正文';
    expect(stripCustomTags(s, [])).toBe(s);
    expect(stripCustomTags(s, ['snow'])).toBe(s);
  });

  it('多个标签依次整删', () => {
    expect(stripCustomTags('<a>1</a>x<b>2</b>y', ['a', 'b'])).toBe('xy');
  });
});

describe('prompt body cleaning', () => {
  it('does not offer standalone container tags as picture positions', () => {
    const text = '<now_plot>\n正文\n</now_plot>\n<summary>\n摘要\n</summary>\n<update data-type="state">\n状态\n</update>';
    expect(prepareTargetText(text, []).segments).toEqual([
      {id:'P1',sourceLine:1,text:'正文'},
      {id:'P2',sourceLine:4,text:'摘要'},
      {id:'P3',sourceLine:7,text:'状态'},
    ]);
    expect(prepareTargetText('<p>正文</p>\n<tag/><tag-two>\n比较 a < b', []).segments).toEqual([
      {id:'P1',sourceLine:0,text:'<p>正文</p>'},
      {id:'P2',sourceLine:2,text:'比较 a < b'},
    ]);
  });
  const source = `状态栏
<think>不可见思维</think>
<bbs_start>2026/8/16 10:00</bbs_start>
第一段正文
<snow>自定义状态</snow>
<bbi_image>1girl, silver hair<size>portrait</size></bbi_image>
第二段正文
<bbs_end>2026/8/16 10:05</bbs_end>
<bbs_items>
- 不应发送的物品旁注
</bbs_items>
尾部状态`;

  it('cleans historical floors without resending image prompts', () => {
    expect(cleanHistoryText(source, ['snow', 'bbi_image'])).toBe(
      `(起始时间:2026/8/16 10:00)
第一段正文

第二段正文
(结束时间:2026/8/16 10:05)`,
    );
  });

  it('removes target noise and time markers without changing retained prose', () => {
    expect(cleanTargetText(source, ['snow'])).toBe(
      `第一段正文

第二段正文`,
    );
  });

  it('builds stable position IDs mapped to original physical lines', () => {
    expect(prepareTargetText(source, ['snow'])).toEqual({
      promptText: `第一段正文 ⟦P1⟧

第二段正文 ⟦P2⟧`,
      segments: [
        { id: 'P1', sourceLine: 3, text: '第一段正文' },
        { id: 'P2', sourceLine: 6, text: '第二段正文' },
      ],
    });
  });

  it('removes multiline Layout payloads while preserving narrative lines and their original positions', () => {
    const raw = '😀前文\r\n<bbi_image><tag>{\r\n"layout":"9", "caption":"PRIVATE_LAYOUT"\r\n}</tag></bbi_image>\r\n后文';
    expect(cleanHistoryText(raw, [])).toBe('😀前文\r\n后文');
    expect(prepareTargetText(raw, [])).toEqual({
      promptText: '😀前文 ⟦P1⟧\n\n后文 ⟦P2⟧',
      segments: [
        { id: 'P1', sourceLine: 0, text: '😀前文' },
        { id: 'P2', sourceLine: 4, text: '后文' },
      ],
    });
    expect(raw).toContain('PRIVATE_LAYOUT');
  });

  it('shares orphan/nested tag handling without swallowing surrounding narrative', () => {
    const raw = '<BBI_IMAGE>\n前文<BBI_IMAGE>hidden</BBI_IMAGE>后文\n</bbi_image>\n结尾';
    expect(cleanHistoryText(raw, [])).toBe('结尾'); // nested paired block
    const orphan = '<bbi_image>\n前文<bbi_image>hidden</bbi_image>后文\n结尾</bbi_image_extra>';
    expect(cleanHistoryText(orphan, [])).toContain('前文后文');
    expect(prepareTargetText(orphan, ['bbi_image']).segments.map(s => s.text)).toEqual(['前文 后文', '结尾</bbi_image_extra>']);
    expect(cleanTargetText('前<bbi_image></bbi_image>后', [])).toBe('前 后');
  });

  it('keeps inline prose on one mapped source line after removing a block', () => {
    expect(prepareTargetText('前文<snow>隐藏</snow>后文', ['snow'])).toEqual({
      promptText: '前文 后文 ⟦P1⟧',
      segments: [{ id: 'P1', sourceLine: 0, text: '前文 后文' }],
    });
  });

  it('removes a lone closing time tag from the target', () => {
    expect(prepareTargetText('正文\n</bbs_end>', [])).toEqual({
      promptText: '正文 ⟦P1⟧',
      segments: [{ id: 'P1', sourceLine: 0, text: '正文' }],
    });
  });

  it('crops draft format examples before removing real time tags', () => {
    const text = `<draft_notes>
format example: <bbs_start>/<bbs_end>
</draft_notes>
<bbs_start>1978/9/15 10:15</bbs_start>
first useful line
second useful line
<bbs_end>1978/9/15 11:05</bbs_end>
<diary>tail content</diary>`;

    expect(prepareTargetText(text, [])).toEqual({
      promptText: `first useful line \u27e6P1\u27e7

second useful line \u27e6P2\u27e7`,
      segments: [
        { id: 'P1', sourceLine: 4, text: 'first useful line' },
        { id: 'P2', sourceLine: 5, text: 'second useful line' },
      ],
    });
  });

  it('keeps source offsets stable when emoji appear before removed blocks', () => {
    expect(
      prepareTargetText(
        '😀状态<snow><bbs_start>伪时间</bbs_start></snow>\n<bbs_start>真实时间</bbs_start>\n正文',
        ['snow'],
      ),
    ).toEqual({
      promptText: '正文 ⟦P1⟧',
      segments: [{ id: 'P1', sourceLine: 2, text: '正文' }],
    });
  });
});
