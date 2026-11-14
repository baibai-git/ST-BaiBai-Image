import { ref } from 'vue';

import type { NaiArtistPreset } from '@/state/settings';

/**
 * 画师串预览图的破缓存版本号,管理列表与方案里的挑选弹窗共用一份。
 *
 * 换图是同名覆盖(文件名 = 条目 id),URL 不变,浏览器缓存会继续显示旧图;
 * 上传成功后 bump 一下,<img src> 带上 query 即可。只活在本次页面会话里——
 * 刷新后浏览器会重新验证,不需要持久化。
 */
const versions = ref<ReadonlyMap<string, number>>(new Map());

export function artistPreviewSrc(preset: Pick<NaiArtistPreset, 'id' | 'previewPath'>): string {
  if (!preset.previewPath) return '';
  const v = versions.value.get(preset.id);
  return v ? `${preset.previewPath}?v=${v}` : preset.previewPath;
}

export function bumpArtistPreview(id: string): void {
  versions.value = new Map(versions.value).set(id, Date.now());
}
