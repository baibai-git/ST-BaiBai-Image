import { ApiError, requestCompletion, type ChatMsg, type DshSessionRequest, type RequestOptions } from '@/api/client';
import { settings, type ApiChannel } from '@/state/settings';
import { getContext, type STContext } from '@/st/context';
import { assertDshImageSupport, readDshCapabilities } from '@/api/dshImages';
import { regroupLayoutAtlasMessages } from '@/manga/atlas';

const STORE='baibai_dsh_sessions';
interface Binding { session_id: string; initialized: boolean; rulesHash?: string; atlasHash?: string }
interface Pending { rulesHash?: string; key: string; messages: ChatMsg[]; session: DshSessionRequest; channel: ApiChannel }
/** Kept by one runner invocation: ambiguous network retries reuse the exact request. */
export interface DshOperation { pending?: Pending; acknowledged?: boolean }
interface DshOptions extends RequestOptions {
  action?: DshSessionRequest['action'];
  target?: DshSessionRequest['target'];
  operation?: DshOperation;
  /** Capture before asynchronous prompt preparation; ST's chat getter is live. */
  expectedChatId?: string;
  protocolKey?: string;
}

export function dshChatId(context: STContext): string {
  const id=context.getCurrentChatId();
  if (!id) throw new ApiError('请先打开一个酒馆聊天。');
  const owner=context.groupId ? ['group',context.groupId] : ['character',context.characters?.[Number(context.characterId)]?.avatar ?? context.name2];
  return JSON.stringify([...owner,id]);
}

function bindingKey(channel: ApiChannel): string {
  // Keep routing identities, never the channel's API key, in chat metadata.
  const url=new URL(channel.url);
  return JSON.stringify([channel.id,url.origin+url.pathname.replace(/\/+$/,''),channel.model]);
}

function bindings(context: STContext): Record<string, Binding> {
  const value=context.chatMetadata[STORE];
  if (value && typeof value==='object' && !Array.isArray(value)) return value as Record<string,Binding>;
  return {};
}

function saveBinding(context: STContext, chatId: string, key: string, value?: Binding): void {
  const values={...bindings(context)};
  if (value) values[key]=value; else delete values[key];
  context.chatMetadata[STORE]=values;
  const active=getContext();
  if (active?.getCurrentChatId() && dshChatId(active)===chatId) context.saveMetadataDebounced();
}

export function splitDshMessages(messages: ChatMsg[]): {fixed: ChatMsg[]; dynamic: ChatMsg[]} {
  return {fixed:messages.filter(message=>!!message.purpose),dynamic:messages.filter(message=>!message.purpose)};
}

function requestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join('');
}

const queues=new Map<string,Promise<void>>();
async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('请求已取消','AbortError');
  if (!signal) return previous;
  await new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new DOMException('请求已取消','AbortError'));};
    signal.addEventListener('abort',abort,{once:true});
    void previous.then(()=>{signal.removeEventListener('abort',abort);resolve();});
  });
}

/** Serialize one conversation locally; the bridge must also serialize across browser tabs. */
async function serial<T>(key: string, signal: AbortSignal | undefined, task:()=>Promise<T>): Promise<T> {
  const previous=queues.get(key) ?? Promise.resolve();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const tail=previous.then(()=>gate);
  queues.set(key,tail);
  void tail.then(()=>{if (queues.get(key)===tail) queues.delete(key);});
  try { await waitForTurn(previous,signal);return await task(); }
  finally { release(); }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function requestDshCompletion(channel: ApiChannel, messages: ChatMsg[], context: STContext, options: DshOptions = {}): Promise<string> {
  const dedicated = settings.autoTag.dshDedicated === true;
  const origin = options.expectedChatId ?? (context.getCurrentChatId() ? dshChatId(context) : undefined);
  const action = options.action ?? 'generate';
  if ((!dedicated || action==='generate') && !origin) throw new ApiError('请先打开一个酒馆聊天。');
  const profile = options.protocolKey ?? (settings.defaultBackend==='comfyui' && settings.manga.enabled ? 'manga' : settings.defaultBackend);
  const skillMode = settings.autoTag.dshRuleSource==='skill' && profile==='manga';
  const route = bindingKey(channel);
  const clientId = new URL(channel.url).pathname.match(/^\/clients\/([a-z][a-z0-9_-]{0,63})\/v1(?:\/chat\/completions)?\/*$/i)?.[1] ?? 'baibai-image';
  if (dedicated && !settings.autoTag.dshDedicatedState) {
    settings.autoTag.dshDedicatedState={instanceId:crypto.randomUUID(),bindings:{}};
  }
  const state = dedicated ? settings.autoTag.dshDedicatedState! : undefined;
  // Keep existing plugin bindings intact; the other source uses a separate remote scope.
  const key = dedicated ? JSON.stringify([profile,route,...(skillMode ? ['skill'] : [])]) : JSON.stringify([origin,route,...(skillMode ? ['skill',profile] : [])]);
  const chatId = state ? `baibai-dedicated:${state.instanceId}:${(await digest(key)).slice(0,24)}` : origin!;
  const scopeKey = JSON.stringify([chatId,route,...(!dedicated && skillMode ? [profile,'skill'] : [])]);
  const operationKey = JSON.stringify([scopeKey,origin ?? null]);
  const operation=options.operation ?? {};
  let effectiveMessages=skillMode ? messages.filter(message=>message.purpose!=='spec' && message.purpose!=='check') : messages;
  let parts=splitDshMessages(effectiveMessages);
  const rulesHash=dedicated && parts.fixed.length ? await digest(JSON.stringify(parts.fixed)) : undefined;
  const read=():Binding|undefined => dedicated ? state!.bindings[key] : bindings(context)[key];
  const save=(value?:Binding) => {
    if (state) { if (value) state.bindings[key]=value; else delete state.bindings[key]; }
    else saveBinding(context,origin!,key,value);
  };
  const checkSource=() => {
    if (action!=='generate' && dedicated) return;
    const active=getContext();
    if (!active?.getCurrentChatId() || dshChatId(active)!==origin) throw new DOMException('聊天已切换，未发送 DSH 请求','AbortError');
  };
  return serial(scopeKey,options.signal,async()=>{
    checkSource();
    let skillId: string | undefined;
    const retry=operation.pending?.key===operationKey && operation.pending.session.action==='generate' && !operation.acknowledged ? operation.pending : undefined;
    const imageMessages=retry?.messages ?? effectiveMessages;
    const capabilities=(skillMode && action!=='reset' || action==='generate' && imageMessages.some(message=>message.images?.length))
      ? await readDshCapabilities(retry?.channel ?? channel,options.signal) : undefined;
    if (skillMode && capabilities) {
      const entry=Array.isArray(capabilities.client_endpoints) ? capabilities.client_endpoints.find(entry=>entry && typeof entry==='object' && entry.id===clientId && entry.enabled!==false) : undefined;
      if (typeof entry?.skillId!=='string' || !entry.skillId.trim()) throw new ApiError('当前 DSH 接入项未绑定 Skill。请在 DSH 为柏宝绘专属入口绑定 Skill，或将规范来源切回插件。');
      skillId=entry.skillId.trim();
    }
    checkSource();
    let atlasHash: string | undefined;
    if (action==='generate') {
      const limit=capabilities?.image_input?.max_images_per_message;
      if (!retry && typeof limit==='number' && Number.isSafeInteger(limit) && limit>0) {
        effectiveMessages=regroupLayoutAtlasMessages(effectiveMessages,limit);
        parts=splitDshMessages(effectiveMessages);
      }
      if (dedicated && effectiveMessages.some(message=>message.atlasRevision)) {
        if (capabilities?.layout_atlas?.supported!==true || capabilities.layout_atlas.mode!=='session-prefix-v1') {
          throw new ApiError('当前 DSH 桥接不支持会话版式图保留，请更新 ST-bridge 至 0.15.0 或更新版本。');
        }
        atlasHash=effectiveMessages.find(message=>message.atlasRevision)!.atlasRevision;
      }
      const validationMessages=atlasHash && read()?.atlasHash===atlasHash
        ? effectiveMessages.filter(message=>message.atlasRevision!==atlasHash) : effectiveMessages;
      await assertDshImageSupport(retry?.channel ?? channel,retry?.messages ?? validationMessages,options.signal,capabilities);
      checkSource();
    }
    const send=async(currentAction:DshSessionRequest['action']):Promise<string>=>{
      const stored=read();
      const binding=stored && typeof stored.session_id==='string' && stored.session_id.trim() ? stored : undefined;
      if (!operation.pending || operation.acknowledged || operation.pending.key!==operationKey || operation.pending.session.action!==currentAction) {
        const sendFixed=currentAction==='sync_rules' || currentAction==='generate' && !binding?.initialized;
        if (sendFixed && !parts.fixed.length) throw new ApiError('DSH 未找到固定规范分组，已取消发送。');
        let outgoing=currentAction==='reset' ? [] : currentAction==='sync_rules' ? parts.fixed : sendFixed ? effectiveMessages : parts.dynamic;
        let atlas: DshSessionRequest['layout_atlas'];
        if (currentAction==='generate' && atlasHash) {
          if (binding?.atlasHash===atlasHash) outgoing=outgoing.filter(message=>message.atlasRevision!==atlasHash);
          atlas={hash:atlasHash,message_indices:outgoing.flatMap((message,index)=>message.atlasRevision===atlasHash ? [index] : [])};
        }
        if (currentAction==='generate') await assertDshImageSupport(channel,outgoing,options.signal,capabilities);
        const fixed=sendFixed ? parts.fixed : [];
        operation.pending={rulesHash,key:operationKey,channel:{...channel,excludeParams:[...(channel.excludeParams ?? [])]},messages:outgoing.map(({role,content,images})=>({role,content,...(images?.length ? {images:[...images]} : {})})),session:{
          protocol_version:1,chat_id:chatId,request_id:requestId(),action:currentAction,
          ...(dedicated ? {session_mode:'dedicated',client_id:clientId,task_id:profile,...(origin ? {source_chat_id:origin} : {})} : {}),
          ...(skillMode && !dedicated ? {client_id:clientId,task_id:`${profile}-skill`} : {}),
          ...(skillId ? {skill_id:skillId} : {}),
          ...(atlas ? {layout_atlas:atlas} : {}),
          ...(binding ? {session_id:binding.session_id} : {}),
          fixed_message_count:fixed.length,fixed_message_types:fixed.map(message=>message.purpose!),
          ...(currentAction==='generate' && options.target ? {target:options.target} : {}),
        }};
        operation.acknowledged=false;
      }
      const pending=operation.pending;
      try {
        return await requestCompletion(pending.channel,pending.messages,{
          ...options,validate:currentAction==='generate' ? options.validate : undefined,dshSession:pending.session,
          source:currentAction!==action ? skillMode ? 'DSH 宿主协议同步' : 'DSH 专属规范同步' : options.source,
          onDshResponse(data){
            const acknowledgement=(data as {dsh_session?:{session_id?:unknown;capabilities?:unknown;skill_id?:unknown;layout_atlas_hash?:unknown}} | null)?.dsh_session;
            const session=acknowledgement?.session_id;
            if (typeof session!=='string' || !session.trim()) throw new ApiError('DSH 响应缺少 dsh_session.session_id，未确认固定规范发送状态。');
            if (dedicated && (!Array.isArray(acknowledgement?.capabilities) || !acknowledgement.capabilities.includes('dedicated-v1'))) {
              throw new ApiError('当前 DSH 桥接未确认专属模式历史隔离能力，请更新 ST-bridge 或关闭专属模式。');
            }
            if (pending.session.skill_id && acknowledgement?.skill_id!==pending.session.skill_id) throw new ApiError('DSH 未确认加载所绑定的 Skill，未确认本次规则状态。请检查绑定或重建会话。');
            if (pending.session.layout_atlas && acknowledgement?.layout_atlas_hash!==pending.session.layout_atlas.hash) throw new ApiError('DSH 未确认保留完整版式图册，未确认本次请求状态。');
            const savedAtlas=currentAction==='generate' ? pending.session.layout_atlas?.hash : currentAction==='sync_rules' && session===binding?.session_id ? binding.atlasHash : undefined;
            save({session_id:session,initialized:currentAction!=='reset',...(savedAtlas ? {atlasHash:savedAtlas} : {}),...(dedicated && currentAction!=='reset' ? {rulesHash:pending.session.fixed_message_count ? pending.rulesHash : binding?.rulesHash} : {})});
            operation.acknowledged=true;
          },
        });
      } catch(error) {
        if (error instanceof ApiError && error.status===410) { save();operation.pending=undefined;operation.acknowledged=false; }
        throw error;
      }
    };
    // Capability handshake is a control request, never an extra model generation.
    // Resume an ambiguous generate verbatim even if settings changed in the meantime.
    const retryingGenerate=operation.pending?.key===operationKey && operation.pending.session.action==='generate' && !operation.acknowledged;
    if (dedicated && action==='generate' && !retryingGenerate && (!read()?.initialized || read()?.rulesHash!==rulesHash)) {
      await send('sync_rules');checkSource();
    }
    const result=await send(action);
    return skillMode && action==='sync_rules' ? '宿主协议已发送（主规范与检查由 DSH Skill 提供）' : result;
  });
}
