import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMsg } from '@/api/client';
import { expandMacroMessages, expandTavernMacros } from '@/autoTag/macroExpand';

/**
 * 假的 yaml.stringify:只覆盖展开用到的两种形态。
 * - 普通模式:字符串裸写、嵌套用缩进块、数组用 `- `;
 * - QUOTE_DOUBLE 模式:字符串强制 JSON 引号。
 * 真库是 TH 挂到 globalThis 的那个,测试不引依赖。
 */
function fakeStringify(value: unknown, options?: Record<string, unknown>): string {
    const quote = (text: string) => (options?.defaultStringType === 'QUOTE_DOUBLE' ? JSON.stringify(text) : text);
    const inner_key_line = (key: string, inline: boolean, rendered: string) =>
        inline ? `${key}:\n${rendered}` : `${key}: ${rendered}`;
    const render = (input: unknown, indent: string): string => {
        if (input === null || input === undefined) return 'null';
        if (typeof input !== 'object') return quote(String(input));
        if (Array.isArray(input)) {
            return input.map((item) => `${indent}- ${render(item, `${indent}  `)}`).join('\n');
        }
        return Object.entries(input as Record<string, unknown>)
            .map(([key, item]) => {
                const inline = typeof item === 'object' && item !== null;
                // 真 yaml 在块状嵌套时冒号后不留空格,这里必须一致,否则续行缩进对不上
                return `${indent}${inner_key_line(key, inline, render(item, `${indent}  `))}`;
            })
            .join('\n');
    };
    return `${render(value, '')}\n`;
}

function installTavernHelper(
    getVariables: (option: { type: string; message_id?: number | 'latest' }) => Record<string, unknown>,
) {
    vi.stubGlobal('TavernHelper', { getVariables });
    vi.stubGlobal('YAML', { stringify: fakeStringify });
}

const STAT = {
    stat_data: {
        $meta: { extensible: false },
        角色: { 小雪: { 好感度: 30, 着装: '白裙' } },
    },
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('expandTavernMacros', () => {
    it('未安装 Tavern-Helper 时原样返回', () => {
        const text = '变量: {{format_message_variable::stat_data}}';
        expect(expandTavernMacros(text)).toBe(text);
    });

    it('非宏文本不做任何处理', () => {
        installTavernHelper(() => STAT);
        expect(expandTavernMacros('普通正文，没有宏')).toBe('普通正文，没有宏');
    });

    it('format_message_variable 展开为 YAML,并剔除 $ 开头的元数据键', () => {
        installTavernHelper(() => STAT);
        const out = expandTavernMacros('{{format_message_variable::stat_data}}');
        expect(out).toContain('角色:');
        expect(out).toContain('好感度: 30');
        expect(out).not.toContain('$meta');
        expect(out).not.toContain('{{');
    });

    it('字符串值原样输出；_quoted 只影响集合内部的字符串', () => {
        installTavernHelper(() => STAT);
        // TH 的实现里,顶层字符串在 _quoted 变体下同样原样返回
        expect(expandTavernMacros('{{format_message_variable::stat_data.角色.小雪.着装}}')).toBe('白裙');
        expect(expandTavernMacros('{{format_message_variable_quoted::stat_data.角色.小雪.着装}}')).toBe('白裙');
        // 集合内部才加引号:着装: "白裙"
        expect(expandTavernMacros('{{format_message_variable_quoted::stat_data.角色}}')).toContain('着装: "白裙"');
    });

    it('get_message_variable:字符串原样,对象走 JSON', () => {
        installTavernHelper(() => STAT);
        expect(expandTavernMacros('{{get_message_variable::stat_data.角色.小雪.好感度}}')).toBe('30');
        const obj = expandTavernMacros('{{get_message_variable::stat_data.角色}}');
        expect(JSON.parse(obj)).toEqual({ 小雪: { 好感度: 30, 着装: '白裙' } });
    });

    it('多行 YAML 的续行按宏所在列对齐', () => {
        installTavernHelper(() => STAT);
        const out = expandTavernMacros('变量: {{format_message_variable::stat_data}}');
        const lines = out.split('\n');
        expect(lines[0]).toBe('变量: 角色:');
        // 宏起始于第 4 列,续行整体右移 4 列(「小雪:」原本缩进 2 列 → 6 列)
        expect(lines[1]).toBe('      小雪:');
        expect(lines[2]).toBe('        好感度: 30');
    });

    it('多行多处宏都会展开(TH 原实现只展开首个命中)', () => {
        installTavernHelper(() => STAT);
        const out = expandTavernMacros(
            [
                '第一处 {{format_message_variable::stat_data.角色.小雪.好感度}}',
                '第二处 {{get_message_variable::stat_data.角色.小雪.着装}}',
            ].join('\n'),
        );
        expect(out).toBe('第一处 30\n第二处 白裙');
    });

    it('支持数组下标与带引号的键', () => {
        installTavernHelper(() => ({ stat_data: { 物品: ['钥匙', '卷轴'], 'a.b': '点键' } }));
        expect(expandTavernMacros('{{get_message_variable::stat_data.物品[1]}}')).toBe('卷轴');
        expect(expandTavernMacros('{{get_message_variable::stat_data["a.b"]}}')).toBe('点键');
        expect(expandTavernMacros('{{get_message_variable::stat_data.物品.0}}')).toBe('钥匙');
    });

    it('路径不存在时保留宏原文,便于排查', () => {
        installTavernHelper(() => STAT);
        const text = '{{format_message_variable::stat_data.不存在.字段}}';
        expect(expandTavernMacros(text)).toBe(text);
    });

    it('目标楼没有变量时回退到 TH 默认楼层(最后一个带变量的楼层)', () => {
        const calls: Array<{ type: string; message_id?: number | 'latest' }> = [];
        installTavernHelper((option) => {
            calls.push(option);
            if (option.type !== 'message') return {};
            return option.message_id === 7 ? {} : STAT;
        });
        const out = expandTavernMacros('{{get_message_variable::stat_data.角色.小雪.好感度}}', {
            messageId: 7,
        });
        expect(out).toBe('30');
        expect(calls).toEqual([
            { type: 'message', message_id: 7 },
            { type: 'message', message_id: undefined },
        ]);
    });

    it('目标楼有变量时只读该楼,不再回退', () => {
        const calls: Array<{ type: string; message_id?: number | 'latest' }> = [];
        installTavernHelper((option) => {
            calls.push(option);
            return { stat_data: { 楼层: option.message_id } };
        });
        const out = expandTavernMacros('{{get_message_variable::stat_data.楼层}}', { messageId: 7 });
        expect(out).toBe('7');
        expect(calls).toEqual([{ type: 'message', message_id: 7 }]);
    });

    it('getVariables 抛错(楼层越界等)时不展开、不抛出', () => {
        vi.stubGlobal('TavernHelper', {
            getVariables: () => {
                throw new Error('提供的消息楼层号超出了范围');
            },
        });
        vi.stubGlobal('YAML', { stringify: fakeStringify });
        const text = '{{format_message_variable::stat_data}}';
        expect(expandTavernMacros(text)).toBe(text);
    });

    it('缺少 YAML 时退化为 JSON,仍然展开', () => {
        vi.stubGlobal('TavernHelper', { getVariables: () => STAT });
        const out = expandTavernMacros('{{format_message_variable::stat_data.角色.小雪}}');
        expect(JSON.parse(out)).toEqual({ 好感度: 30, 着装: '白裙' });
    });
});

describe('expandMacroMessages', () => {
    const messages: ChatMsg[] = [
        { role: 'system', content: '设定:{{format_message_variable::stat_data.角色.小雪.着装}}' },
        { role: 'user', content: '没有宏的正文' },
    ];

    it('展开各条消息,且不改动入参', () => {
        installTavernHelper(() => STAT);
        const out = expandMacroMessages(messages);
        expect(out[0].content).toBe('设定:白裙');
        expect(out[1].content).toBe('没有宏的正文');
        expect(messages[0].content).toBe('设定:{{format_message_variable::stat_data.角色.小雪.着装}}');
        expect(out).not.toBe(messages);
    });

    it('未装 TH 时返回原数组(零开销)', () => {
        expect(expandMacroMessages(messages)).toBe(messages);
    });
});
