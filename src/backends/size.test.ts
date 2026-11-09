import { describe, expect, it } from 'vitest';

import {
  effectiveOrientation,
  alignMossCanvasDimension,
  normalizeOrientation,
  normalizeOrientationLock,
  parseSize,
  pickSize,
} from '@/backends/size';

describe('MOSS canvas editor input', () => {
  it('rounds to the nearest 16, clamps input, and leaves invalid values for validation', () => {
    for (const [input, expected] of [[1080, 1088], [1087, 1088], [1079, 1072], [15, 64], [10000, 8192]]) {
      expect(alignMossCanvasDimension(input)).toBe(expected);
    }
    expect(alignMossCanvasDimension(NaN)).toBeNaN();
    expect(alignMossCanvasDimension(Infinity)).toBe(Infinity);
  });
});

describe('normalizeOrientation', () => {
  it('认标准值与大小写/空白变体', () => {
    expect(normalizeOrientation('portrait')).toBe('portrait');
    expect(normalizeOrientation('landscape')).toBe('landscape');
    expect(normalizeOrientation('  LANDSCAPE  ')).toBe('landscape');
  });

  it('认常见同义写法与中文', () => {
    expect(normalizeOrientation('horizontal')).toBe('landscape');
    expect(normalizeOrientation('wide')).toBe('landscape');
    expect(normalizeOrientation('横屏')).toBe('landscape');
    expect(normalizeOrientation('landscape shot')).toBe('landscape');
    expect(normalizeOrientation('l')).toBe('landscape');
    expect(normalizeOrientation('vertical')).toBe('portrait');
  });

  it('认比例/尺寸写法,按宽高关系判定', () => {
    expect(normalizeOrientation('16:9')).toBe('landscape');
    expect(normalizeOrientation('9:16')).toBe('portrait');
    expect(normalizeOrientation('1216x832')).toBe('landscape');
    expect(normalizeOrientation('832×1216')).toBe('portrait');
    expect(normalizeOrientation('1:1')).toBe('portrait');
  });

  it('缺失或无法识别一律降级为竖屏(维持改动前的固定默认)', () => {
    expect(normalizeOrientation(undefined)).toBe('portrait');
    expect(normalizeOrientation(null)).toBe('portrait');
    expect(normalizeOrientation('')).toBe('portrait');
    expect(normalizeOrientation('   ')).toBe('portrait');
    expect(normalizeOrientation(42)).toBe('portrait');
    expect(normalizeOrientation({ size: 'landscape' })).toBe('portrait');
    expect(normalizeOrientation('随便写点什么')).toBe('portrait');
  });
});

describe('parseSize', () => {
  it('解析各种分隔符', () => {
    expect(parseSize('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseSize('1216x832')).toEqual({ width: 1216, height: 832 });
    expect(parseSize('1024 * 1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('解析不出或超范围返回 null,由调用方决定报错还是降级', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('竖版')).toBeNull();
    expect(parseSize('8000×8000')).toBeNull();
    expect(parseSize('32×32')).toBeNull();
  });

  it('不强制 64 的倍数(那是 NAI 专属限制,由 parseResolution 另外把关)', () => {
    expect(parseSize('830×1216')).toEqual({ width: 830, height: 1216 });
  });
});

describe('pickSize', () => {
  const pair = { portraitSize: '832×1216', landscapeSize: '1216×832' };

  it('按方向取对应那一格', () => {
    expect(pickSize(pair, 'portrait')).toBe('832×1216');
    expect(pickSize(pair, 'landscape')).toBe('1216×832');
  });

  it('未填返回空串,交由调用方回落', () => {
    expect(pickSize({ portraitSize: '  ', landscapeSize: '' }, 'portrait')).toBe('');
    expect(pickSize({ portraitSize: '', landscapeSize: '' }, 'landscape')).toBe('');
  });
});

describe('normalizeOrientationLock', () => {
  it('只认两个方向值', () => {
    expect(normalizeOrientationLock('portrait')).toBe('portrait');
    expect(normalizeOrientationLock('landscape')).toBe('landscape');
    expect(normalizeOrientationLock('auto')).toBe('auto');
  });

  it('老数据缺字段或乱值一律 auto(维持改动前由 AI 判定的行为)', () => {
    expect(normalizeOrientationLock(undefined)).toBe('auto');
    expect(normalizeOrientationLock(null)).toBe('auto');
    expect(normalizeOrientationLock('')).toBe('auto');
    // 不做 normalizeOrientation 那套宽松识别:这是用户点选的设置,不是模型的自由输出
    expect(normalizeOrientationLock('横屏')).toBe('auto');
    expect(normalizeOrientationLock('LANDSCAPE')).toBe('auto');
    expect(normalizeOrientationLock(true)).toBe('auto');
  });
});

describe('effectiveOrientation', () => {
  it('auto 时用 tag 里记的方向', () => {
    expect(effectiveOrientation('auto', 'portrait')).toBe('portrait');
    expect(effectiveOrientation('auto', 'landscape')).toBe('landscape');
  });

  it('锁定时无视 tag 里记的方向', () => {
    expect(effectiveOrientation('portrait', 'landscape')).toBe('portrait');
    expect(effectiveOrientation('landscape', 'portrait')).toBe('landscape');
    expect(effectiveOrientation('landscape', 'landscape')).toBe('landscape');
  });
});
