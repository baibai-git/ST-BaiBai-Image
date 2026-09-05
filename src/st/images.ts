import { getContext } from '@/st/context';

/**
 * ST 图片存储（user/images）的上传/删除/列举封装,对应服务端 /api/images/*。
 *
 * 与 floor/upload.ts 的 /api/files/* 分工:files 是平铺目录、无子目录概念;
 * images 支持 ch_name 子目录(服务端 ensureDirectoryExistence 自动递归创建),
 * 故按「文件夹」归类的资源(画师串预览图、聊天生成图片)走这里。
 *
 * 返回的路径形如 /user/images/<文件夹>/<文件名>,可直接作 <img src>。
 */

export class ImageStoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ImageStoreError';
  }
}

/**
 * 画师串预览图的固定子目录(user/images 下)。
 * 常量名:CJK + 下划线经服务端 sanitize-filename 原样保留。
 * 动态角色目录名也由上传接口清洗，无需额外请求 sanitize-filename。
 */
export const ARTIST_PREVIEW_FOLDER = '柏宝绘_画师串';

async function postImage(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctx = getContext();
  if (!ctx) throw new ImageStoreError('SillyTavern 上下文不可用');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/**
 * 上传 base64 图片到 user/images/<folder>/,返回可访问的相对路径(/user/images/...)。
 *
 * filename 可带扩展名,服务端统一替换为 format;同名静默覆盖——
 * 调用方用稳定文件名(如画师串 id)即可让「换预览图」原地覆盖,不攒孤儿文件。
 */
export async function uploadUserImage(
  folder: string,
  filename: string,
  base64: string,
  format: string,
): Promise<string> {
  const { ok, status, text } = await postImage('/api/images/upload', {
    image: base64,
    format,
    ch_name: folder,
    filename,
  });
  if (!ok) {
    throw new ImageStoreError(
      `图片上传失败 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  let path = '';
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') path = parsed.path;
  } catch {
    /* 响应不是 JSON,落到下方统一报错 */
  }
  if (!path) throw new ImageStoreError('图片上传失败：服务端未返回路径');
  return path;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 列出 user/images 下的一级子目录名(图库按角色分组的唯一名字来源)。
 *
 * 落盘文件名里的角色名是哈希(见 floor/storage.ts imageFileName),可读名只能从目录名还原,
 * 故图库必须先取目录、再逐目录列图,不能反过来从文件名推。
 */
export async function listUserImageFolders(): Promise<string[]> {
  const { ok, status, text } = await postImage('/api/images/folders', {});
  if (!ok) {
    throw new ImageStoreError(
      `读取图片目录失败 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  return parseJsonArray(text).filter((name): name is string => typeof name === 'string');
}

/**
 * 列出某个目录下的图片文件名(仅文件名,不含路径),返回顺序即服务端排序结果。
 *
 * ⚠ 服务端对不存在的目录会 mkdir 递归创建(images.js /list),故只能拿
 * listUserImageFolders() 的结果去列——凭空猜目录名会在 user/images 下攒出空文件夹。
 */
export async function listUserImages(
  folder: string,
  options: { sortField?: 'date' | 'name'; sortOrder?: 'asc' | 'desc' } = {},
): Promise<string[]> {
  const { ok, status, text } = await postImage('/api/images/list', {
    folder,
    sortField: options.sortField ?? 'date',
    sortOrder: options.sortOrder ?? 'desc',
  });
  if (!ok) {
    throw new ImageStoreError(
      `读取图片列表失败 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  return parseJsonArray(text).filter((name): name is string => typeof name === 'string');
}

/** 删除 user/images 下的图片。返回 false 表示文件本就不存在(无需清理)。 */
export async function deleteUserImage(path: string): Promise<boolean> {
  const { ok, status, text } = await postImage('/api/images/delete', { path });
  if (ok) return true;
  if (status === 404) return false;
  throw new ImageStoreError(
    `图片删除失败 (${status})${text ? `：${text.slice(0, 300)}` : ''}`,
    status,
  );
}
