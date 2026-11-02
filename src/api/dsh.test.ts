import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, requestCompletion, type ChatMsg } from './client';
import { dshChatId, requestDshCompletion, splitDshMessages, type DshOperation } from './dsh';
import type { ApiChannel } from '@/state/settings';
import type { STContext } from '@/st/context';
import { buildMangaSpec, mangaDefaults } from '@/manga/layouts';
import { createLayoutSelection, setLayoutSelectionMessage } from '@/autoTag/layoutCooldown';

const h=vi.hoisted(()=>({context:null as STContext|null,begin:vi.fn((_record:{messages:ChatMsg[]})=>1),finish:vi.fn(),fail:vi.fn()}));
vi.mock('@/st/context',()=>({getContext:()=>h.context}));
vi.mock('@/state/history',()=>({beginLlm:h.begin,finishLlm:h.finish,failLlm:h.fail,patchLlmTokens:vi.fn(),FOLLOW_MAIN_API:'主API',safeHistory:(fn:()=>unknown)=>fn()}));

const channel:ApiChannel={id:'dsh',name:'DSH',url:'http://127.0.0.1:43121/v1',key:'test-local-key',model:'dsh-default',temperature:.6,maxTokens:8192,timeoutSec:30,stream:true,excludeParams:[],reasoningEffort:''};
const fixed:ChatMsg[]=[{role:'system',content:'prefix',purpose:'prefix'},{role:'system',content:'spec',purpose:'spec'},{role:'system',content:'contract',purpose:'contract'},{role:'system',content:'check',purpose:'check'}];
const messages:ChatMsg[]=[...fixed,{role:'system',content:'world'},{role:'user',content:'target'}];
let calls:any[];
function context(id='chat-a'):STContext {
  return {chat:[],chatMetadata:{},name1:'User',name2:'Character',getCurrentChatId:()=>id,getRequestHeaders:()=>({}),saveMetadataDebounced:vi.fn()} as unknown as STContext;
}
function payload(body:any):any {return JSON.parse(body.custom_include_body).dsh_session;}
function response(body:any,over:Record<string,unknown>={}):Response {
  return new Response(JSON.stringify({dsh_session:{session_id:payload(body).session_id ?? 'session-'+payload(body).chat_id},choices:[{message:{role:'assistant',content:'result'}}],usage:{prompt_tokens:100,completion_tokens:2,prompt_cache_hit_tokens:40},...over}),{headers:{'Content-Type':'application/json'}});
}
function server(run:(body:any)=>Response|Promise<Response>=body=>response(body)):void {
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);return run(body);}));
}
beforeEach(()=>{vi.clearAllMocks();calls=[];h.context=context();server();});

describe('DSH persistent agent routing',()=>{
  it('carries changed panel geometry, deleted slots and notes on subsequent DSH and ordinary API requests',async()=> {
    const manga={...mangaDefaults(),enabled:true,selectionNotes:'current notes',custom:[{
      id:'moving',canvas:{width:1000,height:2000},portrait:[{position:'panel-1',slots:{F:[-1000,-500,1000,0],T:[-1000,-500,-800,0]} as Record<string,number[]>}],
    }]};
    const sizes={portrait:{width:1000,height:2000},landscape:null};
    const batch:ChatMsg[]=[...fixed.map(m=>m.purpose==='spec' ? {...m,content:buildMangaSpec(manga,false)} : m),{role:'user',content:'current target'}];
    setLayoutSelectionMessage(batch,createLayoutSelection(h.context!,manga,sizes,'portrait'));
    await requestDshCompletion(channel,batch,h.context!);
    expect(calls[0].messages.find((m:any)=>m.content.includes('【本轮版式冷却白名单】')).content).toContain('位置[0,0,50,100]');
    expect(batch.find(m=>m.purpose==='spec')!.content).not.toContain('- moving｜');
    manga.custom[0].portrait[0].slots.F=[-1000,0,1000,500];
    delete manga.custom[0].portrait[0].slots.T;
    manga.selectionNotes='changed notes';
    setLayoutSelectionMessage(batch,createLayoutSelection(h.context!,manga,sizes,'portrait'));
    await requestDshCompletion(channel,batch,h.context!);
    const current=calls[1].messages.find((m:any)=>m.content.includes('【本轮版式冷却白名单】')).content;
    expect(payload(calls[1]).fixed_message_count).toBe(0);
    expect(current).toContain('位置[50,0,50,100]');
    expect(current).toContain('changed notes');
    expect(current).not.toContain('T[');
    server(()=>new Response(JSON.stringify({choices:[{message:{content:'ordinary'}}]})));
    await requestCompletion({...channel,stream:false},batch);
    expect(calls[2].messages.find((m:any)=>m.content.includes('【本轮版式冷却白名单】')).content).toBe(current);
  });
  it('first full request, subsequent dynamic-only, reload persistence, ordinary API still full',async()=>{
    const ctx=h.context!;
    const original=JSON.stringify(messages);
    await requestDshCompletion(channel,messages,ctx);
    const first=payload(calls[0]);
    expect(calls[0].chat_completion_source).toBe('custom');expect(calls[0].stream).toBe(false);
    expect(first).toMatchObject({protocol_version:1,chat_id:dshChatId(ctx),action:'generate',fixed_message_count:4,fixed_message_types:['prefix','spec','contract','check']});
    expect(first.session_id).toBeUndefined();expect(calls[0].messages).toHaveLength(6);
    expect(calls[0].messages.every((m:any)=>Object.keys(m).sort().join(',')==='content,role')).toBe(true);
    const changed=messages.map(m=>({...m,content:m.content+' updated'}));
    await requestDshCompletion(channel,changed,ctx);
    expect(calls[1].messages.map((m:any)=>m.content)).toEqual(['world updated','target updated']);
    expect(payload(calls[1])).toMatchObject({fixed_message_count:0,session_id:'session-'+first.chat_id});
    expect(payload(calls[1]).request_id).not.toBe(first.request_id);
    expect(h.begin.mock.calls.at(-1)?.[0]?.messages).toHaveLength(2);
    expect(h.finish.mock.calls.at(-1)?.[1].cacheReadTokens).toBe(40);
    expect(JSON.stringify(ctx.chatMetadata)).not.toContain(channel.key);
    const reloaded=context();reloaded.chatMetadata=JSON.parse(JSON.stringify(ctx.chatMetadata));h.context=reloaded;
    await requestDshCompletion(channel,messages,reloaded);expect(calls[2].messages).toHaveLength(2);
    server(body=>new Response(JSON.stringify({choices:[{message:{content:'ordinary'}}],usage:{prompt_tokens:1,completion_tokens:1}})));
    await requestCompletion({...channel,stream:false},messages);
    expect(calls[3].chat_completion_source).toBe('openai');expect(calls[3].messages).toHaveLength(6);
    expect(calls[3].custom_include_body).toBeUndefined();expect(JSON.stringify(messages)).toBe(original);
  });

  it('manual sync sends only fixed messages; reset retains old remote history and next request reinitializes',async()=>{
    const ctx=h.context!;
    await requestDshCompletion(channel,messages,ctx);
    server(body=>response(body,{choices:[]}));
    expect(await requestDshCompletion(channel,messages,ctx,{action:'sync_rules'})).toBe('固定规范已发送');
    expect(calls[1].messages.map((m:any)=>m.content)).toEqual(['prefix','spec','contract','check']);
    expect(payload(calls[1]).action).toBe('sync_rules');
    expect(await requestDshCompletion(channel,[],ctx,{action:'reset'})).toBe('DSH 会话已重建');
    expect(calls[2].messages).toEqual([]);expect(payload(calls[2]).fixed_message_count).toBe(0);
    server();await requestDshCompletion(channel,messages,ctx);expect(calls[3].messages).toHaveLength(6);
  });

  it('chat, owner, endpoint and model identities do not reuse another binding',async()=>{
    const operation:DshOperation={};
    await requestDshCompletion(channel,messages,h.context!,{operation});
    h.context=context('chat-b');await requestDshCompletion(channel,messages,h.context!,{operation});
    expect(calls[1].messages).toHaveLength(6);expect(payload(calls[1]).chat_id).not.toBe(payload(calls[0]).chat_id);
    h.context.name2='Other';await requestDshCompletion(channel,messages,h.context!);expect(calls[2].messages).toHaveLength(6);
    await requestDshCompletion({...channel,model:'other-model'},messages,h.context!);expect(calls[3].messages).toHaveLength(6);
    await requestDshCompletion({...channel,url:'http://127.0.0.1:43122/v1'},messages,h.context!);expect(calls[4].messages).toHaveLength(6);
  });

  it('network ambiguity retries the identical request id and body; it never includes prior responses',async()=>{
    const operation:DshOperation={};let count=0;
    const editableChannel={...channel};
    server(body=>{if (!count++) throw new TypeError('network');return response(body);});
    await expect(requestDshCompletion(editableChannel,messages,h.context!,{operation})).rejects.toThrow('network');
    expect(h.context!.chatMetadata).toEqual({});
    editableChannel.temperature=.9;
    await requestDshCompletion(editableChannel,messages,h.context!,{operation});
    expect(calls[1]).toEqual(calls[0]);expect(calls[1].messages.some((m:any)=>m.role==='assistant')).toBe(false);
  });

  it('rejects a chat switch during prompt preparation and never saves an old response to the new chat',async()=>{
    let id='chat-a';const ctx=h.context!;ctx.getCurrentChatId=()=>id;
    const expectedChatId=dshChatId(ctx);id='chat-b';
    await expect(requestDshCompletion(channel,messages,ctx,{expectedChatId})).rejects.toMatchObject({name:'AbortError'});
    expect(calls).toHaveLength(0);
    id='chat-a';
    server(body=>{id='chat-b';h.context=context('chat-b');return response(body);});
    await requestDshCompletion(channel,messages,ctx);
    expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(h.context!.chatMetadata).toEqual({});
    server();await requestDshCompletion(channel,messages,h.context!);expect(calls[1].messages).toHaveLength(6);
  });

  it('received response marks fixed rules sent even if output validation fails; regenerate gets a new id',async()=>{
    const operation:DshOperation={};
    await expect(requestDshCompletion(channel,messages,h.context!,{operation,validate:()=>{throw new Error('invalid output');}})).rejects.toThrow('invalid output');
    expect(h.fail).toHaveBeenCalled();
    await requestDshCompletion(channel,messages,h.context!,{operation});
    expect(calls[1].messages).toHaveLength(2);expect(payload(calls[1]).request_id).not.toBe(payload(calls[0]).request_id);
  });

  it('serializes requests, and cancelling a queued request does not unlock another live request',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let count=0;
    server(async body=>{if (!count++) await gate;return response(body);});
    const first=requestDshCompletion(channel,messages,h.context!);
    await vi.waitFor(()=>expect(calls).toHaveLength(1));
    const controller=new AbortController();
    const second=requestDshCompletion(channel,messages,h.context!,{signal:controller.signal});
    const rejected=expect(second).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
    const third=requestDshCompletion(channel,messages,h.context!);
    await Promise.resolve();expect(calls).toHaveLength(1);
    release();await Promise.all([first,third]);expect(calls).toHaveLength(2);expect(calls[1].messages).toHaveLength(2);
  });

  it('requires session acknowledgement; HTTP410 clears stale binding for a full retry',async()=>{
    const operation:DshOperation={};
    server(body=>response(body,{dsh_session:undefined}));
    await expect(requestDshCompletion(channel,messages,h.context!,{operation})).rejects.toThrow('session_id');
    expect(h.context!.chatMetadata).toEqual({});
    server();await requestDshCompletion(channel,messages,h.context!,{operation});
    server(()=>new Response('gone',{status:410}));
    await expect(requestDshCompletion(channel,messages,h.context!,{operation})).rejects.toMatchObject({status:410});
    server();await requestDshCompletion(channel,messages,h.context!,{operation});
    expect(calls.at(-1).messages).toHaveLength(6);
  });

  it('uses purpose markers rather than positional slices and rejects incomplete first initialization',async()=>{
    const partial=[fixed[0],fixed[2],{role:'system' as const,content:'world'},messages[5]];
    expect(splitDshMessages(partial).fixed).toHaveLength(2);
    await requestDshCompletion(channel,partial,h.context!);
    expect(payload(calls[0]).fixed_message_types).toEqual(['prefix','contract']);
    h.context=context('empty');
    await expect(requestDshCompletion(channel,messages.slice(-2),h.context!)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});
