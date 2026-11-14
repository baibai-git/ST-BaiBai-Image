import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileStore = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/floor/upload', () => ({
  uploadBase64File: fileStore.upload,
  deleteUploadedFile: fileStore.remove,
}));

import {
  clampVibeStrength,
  deleteVibeData,
  loadVibeData,
  saveVibeFiles,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import type { NaiVibeData } from '@/state/settings';

const data: NaiVibeData = {
  image: 'aW1hZ2U=',
  thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
  encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
};

describe('vibeStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fileStore.upload.mockReset();
    fileStore.remove.mockReset();
  });

  it('设置索引不包含原图和编码正文', () => {
    const meta = vibeMetaFromData(
      'v1',
      '测试',
      '/user/files/bbi-vibe-v1.json',
      '/user/files/bbi-vibe-thumb-v1.jpg',
      data,
      0.6,
    );
    expect(meta).toMatchObject({
      id: 'v1',
      dataPath: '/user/files/bbi-vibe-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-v1.jpg',
      modelKeys: ['v4-5full'],
      hasImage: true,
    });
    expect(meta).not.toHaveProperty('image');
    expect(meta).not.toHaveProperty('encodings');
    expect(meta).not.toHaveProperty('thumbnail');
  });

  it('正文和缩略图使用稳定文件名分别上传', async () => {
    fileStore.upload
      .mockResolvedValueOnce('/user/files/bbi-vibe-v1.json')
      .mockResolvedValueOnce('/user/files/bbi-vibe-thumb-v1.jpg');

    await expect(saveVibeFiles(data, null, 'v1')).resolves.toEqual({
      dataPath: '/user/files/bbi-vibe-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-v1.jpg',
    });
    expect(fileStore.upload).toHaveBeenNthCalledWith(1, 'bbi-vibe-v1.json', expect.any(String));
    expect(fileStore.upload).toHaveBeenNthCalledWith(2, 'bbi-vibe-thumb-v1.jpg', 'dGh1bWI=');
  });

  it('按路径读取正文并删除两份文件', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 })));
    const vibe = vibeMetaFromData(
      'v1',
      '测试',
      '/user/files/bbi-vibe-v1.json',
      '/user/files/bbi-vibe-thumb-v1.jpg',
      data,
      0.6,
    );
    await expect(loadVibeData(vibe)).resolves.toEqual(data);

    fileStore.remove.mockResolvedValue(true);
    await deleteVibeData(vibe);
    expect(fileStore.remove).toHaveBeenNthCalledWith(1, vibe.dataPath);
    expect(fileStore.remove).toHaveBeenNthCalledWith(2, vibe.thumbnailPath);
  });
});

describe('clampVibeStrength', () => {
  it('自由填值不吸附步进,超界夹到 0–1', () => {
    expect(clampVibeStrength(0.375)).toBe(0.375);
    expect(clampVibeStrength('0.4321')).toBe(0.4321);
    expect(clampVibeStrength(5)).toBe(1);
    expect(clampVibeStrength(-2)).toBe(0);
    expect(clampVibeStrength(0)).toBe(0);
    expect(clampVibeStrength(1)).toBe(1);
  });

  it('认不出数就回落默认值,而非静默变成 0', () => {
    // 回归:旧实现用 Number(v),而 Number(null) / Number('') 都是 0,
    // 「字段缺失」于是被判成「强度 0」——vibe 挂上了却对画面毫无影响。
    for (const raw of [null, undefined, '', '   ', 'abc', NaN, Infinity, true, {}, []]) {
      expect(clampVibeStrength(raw)).toBe(0.6);
    }
  });

  it('可指定回落值(面板输入非法时保留原强度)', () => {
    expect(clampVibeStrength('', 0.9)).toBe(0.9);
    expect(clampVibeStrength('abc', 0.25)).toBe(0.25);
    expect(clampVibeStrength('0.5', 0.9)).toBe(0.5);
  });
});
