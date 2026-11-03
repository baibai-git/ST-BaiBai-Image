import { ApiError, type ChatMsg } from '@/api/client';
import type { ApiChannel } from '@/state/settings';
import { getContext } from '@/st/context';

interface ImageInput {
  supported?: boolean;
  modes?: unknown;
  media_types?: unknown;
  roles?: unknown;
  max_bytes_per_image?: unknown;
  max_images_per_message?: unknown;
  max_total_bytes?: unknown;
}

export interface DshCapabilities {
  layout_atlas?: { supported?: boolean; mode?: string };
  image_input?: ImageInput;
  client_endpoints?: { id?: unknown; enabled?: unknown; skillId?: unknown }[];
}

/** Match the paired adapter's credential only to its configured service origin. */
function authorization(channel: ApiChannel): string {
  const stored=getContext()?.extensionSettings?.st_bridge_context_v1;
  if (stored && typeof stored==='object' && !Array.isArray(stored)) {
    const adapter=stored as {enabled?:boolean;base?:unknown;deviceToken?:unknown};
    try {
      if (adapter.enabled!==false && typeof adapter.base==='string' && typeof adapter.deviceToken==='string' && adapter.deviceToken &&
          new URL(adapter.base).origin===new URL(channel.url).origin) return `Bearer ${adapter.deviceToken}`;
    } catch { /* Invalid adapter settings cannot supply credentials to another endpoint. */ }
  }
  return channel.key ? `Bearer ${channel.key}` : '';
}

/** Reuse the same authenticated, read-only capability endpoint for images and Skill binding. */
export async function readDshCapabilities(channel: ApiChannel, signal?: AbortSignal): Promise<DshCapabilities> {
  const url=new URL('/v1/bridge/capabilities',channel.url);
  const auth=authorization(channel);
  try {
    const response=await fetch(url.href,{method:'GET',headers:auth ? {Authorization:auth} : {},credentials:'omit',cache:'no-store',
      signal:AbortSignal.any([AbortSignal.timeout(8000),...(signal ? [signal] : [])])});
    if (!response.ok) throw new ApiError(`DSH 能力检查失败（HTTP ${response.status}），请检查桥接版本、地址与认证。`,response.status);
    const data:unknown=await response.json();
    if (!data || typeof data!=='object' || Array.isArray(data)) throw new ApiError('DSH 能力接口未返回有效对象。');
    return data as DshCapabilities;
  } catch(error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    throw new ApiError('无法读取 DSH 能力，请确认桥接已启动、浏览器可访问该地址且允许当前酒馆来源。');
  }
}

/** Read-only preflight, only for DSH requests that actually carry dynamic images. */
export async function assertDshImageSupport(channel: ApiChannel, messages: ChatMsg[], signal?: AbortSignal, capabilities?: DshCapabilities): Promise<void> {
  const attachments=messages.filter(message=>message.images?.length);
  if (!attachments.length) return;
  const input=(capabilities ?? await readDshCapabilities(channel,signal))?.image_input;
  const has=(value:unknown,key:string)=>Array.isArray(value) && value.includes(key);
  if (input?.supported!==true || !has(input.modes,'data_url') || !has(input.roles,'user')) {
    throw new ApiError('当前运行的 DSH 桥接未声明 data URL 图片输入支持，请部署并重启 0.14.0 或更新版本，或切回文字版式说明。');
  }
  const limit=(value:unknown):number=>typeof value==='number' && Number.isSafeInteger(value) && value>0 ? value : 0;
  const perImage=limit(input.max_bytes_per_image), perMessage=limit(input.max_images_per_message), totalLimit=limit(input.max_total_bytes);
  if (!perImage || !perMessage || !totalLimit) throw new ApiError('DSH 图片能力声明缺少有效大小或数量限制。');
  let total=0;
  for (const message of attachments) {
    if (message.role!=='user') throw new ApiError('DSH 图片只能放在 user 消息中。');
    if (message.images!.length>perMessage) throw new ApiError(`DSH 每条消息最多 ${perMessage} 张图片，当前为 ${message.images!.length} 张。`);
    for (const image of message.images!) {
      const match=/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
      if (!match || match[2].length%4!==0) throw new ApiError('DSH 图片必须是有效的 Base64 data URL。');
      if (!has(input.media_types,match[1])) throw new ApiError(`DSH 不支持图片类型 ${match[1]}。`);
      const bytes=match[2].length/4*3-(match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
      if (bytes>perImage) throw new ApiError(`单张版式图片超过 DSH 声明的 ${perImage} 字节上限。`);
      total+=bytes;
    }
  }
  if (total>totalLimit) throw new ApiError(`本轮版式图片总量超过 DSH 声明的 ${totalLimit} 字节上限，请减少候选版式。`);
}
