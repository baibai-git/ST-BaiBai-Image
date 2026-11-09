import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, requestCompletion, type ChatMsg } from './client';
import { dshChatId, requestDshCompletion, splitDshMessages, type DshOperation } from './dsh';
import { DEFAULT_DSH_SKILL_REQUEST, settings, type ApiChannel } from '@/state/settings';
import type { STContext } from '@/st/context';
import { buildMangaSpec, mangaDefaults } from '@/manga/layouts';
import { createLayoutSelection, setLayoutSelectionMessage } from '@/autoTag/layoutCooldown';
import { layoutAtlasMessages } from '@/manga/atlas';

const h=vi.hoisted(()=>({context:null as STContext|null,begin:vi.fn((_record:{messages:ChatMsg[]})=>1),finish:vi.fn(),fail:vi.fn()}));
vi.mock('@/st/context',()=>({getContext:()=>h.context}));
vi.mock('@/state/history',()=>({beginLlm:h.begin,finishLlm:h.finish,failLlm:h.fail,patchLlmTokens:vi.fn(),FOLLOW_MAIN_API:'主API',safeHistory:(fn:()=>unknown)=>fn()}));

const channel:ApiChannel={id:'dsh',name:'DSH',url:'http://127.0.0.1:43121/v1',key:'test-local-key',model:'dsh-default',temperature:.6,maxTokens:8192,timeoutSec:30,stream:true,excludeParams:[],reasoningEffort:''};
const fixed:ChatMsg[]=[{role:'system',content:'prefix',purpose:'prefix'},{role:'system',content:'spec',purpose:'spec'},{role:'system',content:'contract',purpose:'contract'},{role:'system',content:'check',purpose:'check'}];
const messages:ChatMsg[]=[...fixed,{role:'system',content:'world'},{role:'user',content:'target'}];
let calls:any[];
let clientEndpoints:any[];
let imageLimit:number;
function context(id='chat-a'):STContext {
  return {chat:[],chatMetadata:{},name1:'User',name2:'Character',getCurrentChatId:()=>id,getRequestHeaders:()=>({}),saveMetadataDebounced:vi.fn()} as unknown as STContext;
}
function payload(body:any):any {return JSON.parse(body.custom_include_body).dsh_session;}
function response(body:any,over:Record<string,unknown>={}):Response {
  return new Response(JSON.stringify({dsh_session:{...(payload(body).session_mode==='dedicated' ? {capabilities:['dedicated-v1']} : {}),...(payload(body).skill_id ? {skill_id:payload(body).skill_id} : {}),...(payload(body).layout_atlas ? {layout_atlas_hash:payload(body).layout_atlas.hash} : {}),session_id:payload(body).session_id ?? 'session-'+payload(body).chat_id+(payload(body).task_id==='manga-skill' ? '-skill' : '')},choices:[{message:{role:'assistant',content:'result'}}],usage:{prompt_tokens:100,completion_tokens:2,prompt_cache_hit_tokens:40},...over}),{headers:{'Content-Type':'application/json'}});
}
function server(run:(body:any)=>Response|Promise<Response>=body=>response(body)):void {
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
    if (String(_url).endsWith('/v1/bridge/capabilities')) return new Response(JSON.stringify({skill_updates:{mode:'per-request',toggle:'skill_enabled',retry:'frozen-version'},client_endpoints:clientEndpoints,layout_atlas:{supported:true,mode:'session-prefix-v1'},image_input:{supported:true,modes:['data_url'],roles:['user'],media_types:['image/png'],max_images_per_message:imageLimit,max_bytes_per_image:10485760,max_total_bytes:20971520}}));
    const body=JSON.parse(init.body);calls.push(body);return run(body);
  }));
}
beforeEach(()=>{settings.autoTag.dshDedicated=false;settings.autoTag.dshUserMessages=false;settings.autoTag.dshRuleSource='plugin';settings.autoTag.dshSkillRequest=DEFAULT_DSH_SKILL_REQUEST;delete settings.autoTag.dshDedicatedState;vi.clearAllMocks();calls=[];imageLimit=4;clientEndpoints=[{id:'baibaohui',enabled:true,skillId:'moss-layout-spec'}];h.context=context();server();});

describe('editable per-turn Skill request',()=>{
  const endpoint={...channel,url:'http://127.0.0.1:43121/clients/baibaohui/v1'};
  it.each([false,true])('sends custom text once at the end with automatic KEEP, dedicated=%s',async(dedicated)=>{
    settings.autoTag.dshDedicated=dedicated;settings.autoTag.dshRuleSource='skill';
    settings.autoTag.dshSkillRequest='读取 {{skill_id}}。\n按照 {{skill_id}} 输出 "JSON"。';
    await requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'manga'});
    const generated=calls.find(call=>payload(call).action==='generate');
    expect(generated.messages.at(-1)).toEqual({role:'user',content:'<<<STB-KEEP>>>\n读取 moss-layout-spec。\n按照 moss-layout-spec 输出 "JSON"。\n<<<STB-/KEEP>>>'});
    expect(generated.messages.filter((m:any)=>typeof m.content==='string' && m.content.includes('读取 moss-layout-spec'))).toHaveLength(1);
    expect(payload(generated).skill_id).toBe('moss-layout-spec');
    expect(calls.filter(call=>payload(call).action!=='generate').every(call=>!JSON.stringify(call.messages).includes('读取 moss-layout-spec'))).toBe(true);
  });
  it.each([undefined,'','  \n '])('uses default text when blank: %s',async(value)=>{
    settings.autoTag.dshRuleSource='skill';settings.autoTag.dshSkillRequest=value;
    await requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'manga'});
    expect(calls.at(-1).messages.at(-1).content).toBe('<<<STB-KEEP>>>\n'+DEFAULT_DSH_SKILL_REQUEST.replaceAll('{{skill_id}}','moss-layout-spec')+'\n<<<STB-/KEEP>>>');
  });
  it('does not send saved custom text when the switch is off or for a non-manga task',async()=>{
    settings.autoTag.dshSkillRequest='CUSTOM_SKILL_REQUEST';
    await requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'manga'});
    settings.autoTag.dshRuleSource='skill';
    await requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'nai'});
    expect(JSON.stringify(calls)).not.toContain('CUSTOM_SKILL_REQUEST');
    expect(calls.every(call=>payload(call).skill_enabled===false)).toBe(true);
  });
  it('keeps retry text frozen after editing and uses the edit for the next task',async()=>{
    settings.autoTag.dshRuleSource='skill';settings.autoTag.dshSkillRequest='FIRST {{skill_id}}';
    const operation:DshOperation={};let fail=true;
    server(body=>{if(fail){fail=false;throw new TypeError('network');}return response(body);});
    await expect(requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'manga',operation})).rejects.toThrow('network');
    const original=structuredClone(calls[0]);settings.autoTag.dshSkillRequest='NEXT {{skill_id}}';
    await requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'manga',operation});
    expect(calls[1]).toEqual(original);
    await requestDshCompletion(endpoint,messages,h.context!,{protocolKey:'manga'});
    expect(calls[2].messages.at(-1).content).toContain('NEXT moss-layout-spec');
  });
});

describe('DSH user-message switch',()=>{
  const endpoint={...channel,url:'http://127.0.0.1:43121/clients/baibaohui/v1'};
  it('keeps original roles when disabled',async()=>{
    await requestDshCompletion(endpoint,messages,h.context!);
    expect(calls[0].messages.map((m:any)=>m.role)).toEqual(messages.map(m=>m.role));
  });
  it.each([[false,'plugin'],[true,'plugin'],[false,'skill'],[true,'skill']] as const)(
    'sends user roles without changing fixed grouping, dynamic content or images: dedicated=%s source=%s',async(dedicated,source)=>{
      settings.autoTag.dshDedicated=dedicated;settings.autoTag.dshRuleSource=source;settings.autoTag.dshUserMessages=true;
      const batch:ChatMsg[]=[...messages,{role:'system',content:'<<<STB-KEEP>>>\nCURRENT SLOTS\n<<<STB-/KEEP>>>'},
        {role:'assistant',content:'quoted previous context'},{role:'user',content:'atlas',images:['data:image/png;base64,AAAA']}];
      const original=JSON.stringify(batch);
      await requestDshCompletion(endpoint,batch,h.context!,{protocolKey:'manga'});
      expect(calls.every(call=>call.messages.every((m:any)=>m.role==='user'))).toBe(true);
      const types=source==='skill'?['prefix','contract']:['prefix','spec','contract','check'];
      expect(payload(calls[0]).fixed_message_types).toEqual(types);
      const generated=calls.find(call=>payload(call).action==='generate');
      const contents=generated.messages.map((m:any)=>m.content);
      expect(contents).toContain('world');expect(contents).toContain('target');
      expect(contents).toContain('quoted previous context');
      expect(contents).toContain('<<<STB-KEEP>>>\nCURRENT SLOTS\n<<<STB-/KEEP>>>');
      expect(contents.at(source==='skill'?-2:-1)).toEqual([{type:'text',text:'atlas'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA',detail:'high'}}]);
      expect(JSON.stringify(batch)).toBe(original);
      await requestDshCompletion(endpoint,batch,h.context!,{protocolKey:'manga',action:'sync_rules'});
      expect(payload(calls.at(-1)).action).toBe('sync_rules');
      expect(calls.at(-1).messages.map((m:any)=>m.role)).toEqual(types.map(()=>'user'));
      await requestDshCompletion(endpoint,[],h.context!,{protocolKey:'manga',action:'reset'});
      expect(calls.at(-1).messages).toEqual([]);
    });
  it.each([false,true])('freezes roles for a retry even if the switch changes, initially=%s',async(enabled)=>{
    settings.autoTag.dshUserMessages=enabled;const operation:DshOperation={};let count=0;
    server(body=>{if(!count++) throw new TypeError('network');return response(body);});
    await expect(requestDshCompletion(endpoint,messages,h.context!,{operation})).rejects.toThrow('network');
    const first=structuredClone(calls[0]);settings.autoTag.dshUserMessages=!enabled;
    await requestDshCompletion(endpoint,messages,h.context!,{operation});
    expect(calls[1]).toEqual(first);
  });
  it.each([false,true])('keeps atlas reuse working with user messages, dedicated=%s',async(dedicated)=>{
    settings.autoTag.dshDedicated=dedicated;settings.autoTag.dshUserMessages=true;
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait'],4,'a'.repeat(64),'FULL CATALOG')];
    await requestDshCompletion(endpoint,batch,h.context!);
    await requestDshCompletion(endpoint,batch,h.context!);
    const generations=calls.filter(call=>payload(call).action==='generate');
    expect(generations).toHaveLength(2);
    expect(generations[0].messages.some((m:any)=>Array.isArray(m.content))).toBe(true);
    expect(generations[1].messages.some((m:any)=>Array.isArray(m.content))).toBe(false);
    expect(generations[1].messages.some((m:any)=>typeof m.content==='string' && m.content.includes('FULL CATALOG'))).toBe(false);
  });
});

describe('DSH Skill rule source',()=>{
  const alias={...channel,url:'http://127.0.0.1:43121/clients/baibaohui/v1'};
  it.each([false,true])('isolates source bindings, filters only spec/check and retains all dynamic context, dedicated=%s',async(dedicated)=>{
    settings.autoTag.dshDedicated=dedicated;
    const options={protocolKey:'manga'};
    await requestDshCompletion(alias,messages,h.context!,options);
    const old=payload(calls.at(-1));
    settings.autoTag.dshRuleSource='skill';calls=[];
    const batch:ChatMsg[]=[...messages,{role:'system',content:'current character library and cooldown'},{role:'user',content:'current atlas',images:['data:image/png;base64,AAAA']}];
    const before=JSON.stringify(batch);
    await requestDshCompletion(alias,batch,h.context!,options);
    expect(payload(calls[0]).fixed_message_types).toEqual(['prefix','contract']);
    expect(calls[0].messages.slice(0,2).map((m:any)=>m.content)).toEqual(['prefix','contract']);
    const generated=calls.at(-1),current=payload(generated);
    expect(current.skill_id).toBe('moss-layout-spec'); expect(current.client_id).toBe('baibaohui');
    if (dedicated) expect(current.chat_id).not.toBe(old.chat_id);
    else { expect(current.chat_id).toBe(old.chat_id);expect(current.task_id).toBe('manga-skill'); }
    expect(generated.messages.map((m:any)=>m.content)).toContain('world');
    expect(generated.messages.map((m:any)=>m.content)).toContain('target');
    expect(generated.messages.map((m:any)=>m.content)).toContain('current character library and cooldown');
    expect(generated.messages.some((m:any)=>Array.isArray(m.content) && m.content[1]?.type==='image_url')).toBe(true);
    expect(current.skill_enabled).toBe(true);
    expect(generated.messages.at(-1)).toEqual({role:'user',content:'<<<STB-KEEP>>>\n本轮指定 Skill：moss-layout-spec。\n请使用桥接为本次请求加载的该 Skill 规范，处理上方目标正文，并遵守本轮槽位白名单与宿主输出协议。\n<<<STB-/KEEP>>>'});
    expect(calls.flatMap(c=>c.messages).map((m:any)=>m.content)).not.toContain('spec');
    expect(calls.flatMap(c=>c.messages).map((m:any)=>m.content)).not.toContain('check');
    expect(JSON.stringify(batch)).toBe(before);
    settings.autoTag.dshRuleSource='plugin';calls=[];
    await requestDshCompletion(alias,messages,h.context!,options);
    expect(payload(calls.at(-1)).session_id).toBe('session-'+old.chat_id);
    expect(payload(calls.at(-1)).skill_id).toBeUndefined();
    expect(payload(calls.at(-1)).skill_enabled).toBe(false);
    expect(calls.at(-1).messages.some((m:any)=>typeof m.content==='string' && m.content.includes('本轮指定 Skill：'))).toBe(false);
  });
  it('does not resync removed rules, and manual sync sends only the retained host groups',async()=>{
    settings.autoTag.dshRuleSource='skill'; settings.autoTag.dshDedicated=true;
    await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga'});
    await requestDshCompletion(alias,messages.map(m=>m.purpose==='spec'||m.purpose==='check'?{...m,content:m.content+' changed'}:m),h.context!,{protocolKey:'manga'});
    expect(calls.map(c=>payload(c).action)).toEqual(['sync_rules','generate','generate']);
    expect(await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga',action:'sync_rules'})).toContain('宿主协议已发送');
    expect(calls.at(-1).messages.map((m:any)=>m.content)).toEqual(['prefix','contract']);
  });
  it('refuses an unbound/disabled entry before sending control or generation requests',async()=>{
    settings.autoTag.dshRuleSource='skill';settings.autoTag.dshDedicated=true;
    for (const entry of [[],[null],[{id:'other',skillId:'moss-layout-spec'}],[{id:'baibaohui',enabled:false,skillId:'moss-layout-spec'}],[{id:'baibaohui',skillId:''}]]) {
      clientEndpoints=entry;
      await expect(requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga'})).rejects.toThrow('未绑定 Skill');
      expect(calls).toEqual([]);
    }
  });
  it('does not mark a binding initialized when the bridge omits the Skill acknowledgement',async()=>{
    settings.autoTag.dshRuleSource='skill';server(body=>response(body,{dsh_session:{session_id:'not-confirmed'}}));
    await expect(requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga'})).rejects.toThrow('未确认加载');
    expect(h.context!.chatMetadata).toEqual({});
  });
  it('adds the protected Skill instruction once at the end of every generate, never to control requests',async()=>{
    settings.autoTag.dshRuleSource='skill';
    await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga'});
    await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga'});
    for (const call of calls) {
      expect(call.messages.at(-1).content).toMatch(/^<<<STB-KEEP>>>\n本轮指定 Skill：moss-layout-spec。[\s\S]*\n<<<STB-\/KEEP>>>$/);
      expect(call.messages.filter((m:any)=>typeof m.content==='string' && m.content.includes('本轮指定 Skill：'))).toHaveLength(1);
    }
    await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga',action:'sync_rules'});
    expect(calls.at(-1).messages.some((m:any)=>m.content.includes('本轮指定 Skill：'))).toBe(false);
    await requestDshCompletion(alias,[],h.context!,{protocolKey:'manga',action:'reset'});
    expect(calls.at(-1).messages).toEqual([]);
  });
  it('retries the exact frozen Skill invocation even when the live binding changes',async()=>{
    settings.autoTag.dshRuleSource='skill';
    const operation:DshOperation={};let count=0;
    server(body=>{if(!count++) throw new TypeError('network');return response(body);});
    await expect(requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga',operation})).rejects.toThrow('network');
    const first=structuredClone(calls[0]);
    clientEndpoints=[];
    await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga',operation});
    expect(calls[1].messages).toEqual(first.messages);
    expect(payload(calls[1])).toEqual(payload(first));
  });
  it('refuses a bridge that still injects Skill after the switch is turned off',async()=>{
    server(body=>response(body,{dsh_session:{session_id:'old-bridge',skill_id:'moss-layout-spec'}}));
    await expect(requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga'})).rejects.toThrow('已关闭每轮 Skill');
    expect(payload(calls[0]).skill_enabled).toBe(false);
    expect(h.context!.chatMetadata).toEqual({});
  });
  it.each(['nai-character','moss-layout'])('keeps other protocol profiles unchanged: %s',async(protocolKey)=>{
    settings.autoTag.dshRuleSource='skill';
    await requestDshCompletion(alias,messages,h.context!,{protocolKey});
    expect(payload(calls[0]).fixed_message_types).toEqual(['prefix','spec','contract','check']);
    expect(payload(calls[0]).skill_id).toBeUndefined();
  });
  it('does not reuse an ambiguous request from the other rule source',async()=>{
    const operation:DshOperation={}; let count=0;
    server(body=>{if (!count++) throw new TypeError('network');return response(body);});
    await expect(requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga',operation})).rejects.toThrow('network');
    const request=payload(calls[0]).request_id;
    settings.autoTag.dshRuleSource='skill';
    await requestDshCompletion(alias,messages,h.context!,{protocolKey:'manga',operation});
    expect(payload(calls[1]).request_id).not.toBe(request);
    expect(payload(calls[1]).fixed_message_types).toEqual(['prefix','contract']);
  });
});

describe('DSH persistent agent routing',()=>{
  it.each(['plugin','skill'] as const)('uploads ordinary-session layout guidance only once, with %s rules',async(ruleSource)=>{
    settings.autoTag.dshRuleSource=ruleSource;imageLimit=20;
    const endpoint={...channel,url:'http://127.0.0.1:43121/clients/baibaohui/v1'};
    const batch=(hash='a'.repeat(64),ids='1、2')=>[...messages,{role:'system' as const,content:`CURRENT IDS: ${ids}`},
      ...layoutAtlasMessages(Array(6).fill('data:image/png;base64,AAAA'),Array(6).fill('portrait，layout ID 1'),4,hash,'STATIC GUIDANCE AND CATALOG')];
    const options={protocolKey:'manga'};
    await requestDshCompletion(endpoint,batch(),h.context!,options);
    expect(calls[0].messages.find((m:any)=>Array.isArray(m.content)).content).toHaveLength(7);
    expect(payload(calls[0]).layout_atlas).toBeUndefined();
    expect(payload(calls[0]).session_mode).toBeUndefined();
    h.context!.chatMetadata=JSON.parse(JSON.stringify(h.context!.chatMetadata));
    calls=[];
    await requestDshCompletion(endpoint,batch(undefined,'2'),h.context!,options);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages.every((m:any)=>typeof m.content==='string')).toBe(true);
    expect(JSON.stringify(calls[0])).not.toContain('STATIC GUIDANCE');
    expect(calls[0].messages.map((m:any)=>m.content)).toContain('CURRENT IDS: 2');
    await requestDshCompletion(endpoint,batch(),h.context!,{...options,action:'sync_rules'});
    await requestDshCompletion(endpoint,batch(),h.context!,options);
    expect(calls.at(-1).messages.every((m:any)=>typeof m.content==='string')).toBe(true);
    await requestDshCompletion(endpoint,batch('b'.repeat(64)),h.context!,options);
    expect(calls.at(-1).messages.find((m:any)=>Array.isArray(m.content)).content).toHaveLength(7);
    await requestDshCompletion(endpoint,[],h.context!,{...options,action:'reset'});
    await requestDshCompletion(endpoint,batch('b'.repeat(64)),h.context!,options);
    expect(calls.at(-1).messages.find((m:any)=>Array.isArray(m.content)).content).toHaveLength(7);
  });
  it('keeps ordinary atlas uploads isolated by chat and channel',async()=>{
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait'],4,'a'.repeat(64),'STATIC GUIDANCE')];
    const original=h.context!;
    await requestDshCompletion(channel,batch,original);
    h.context=context('chat-b');
    await requestDshCompletion(channel,batch,h.context!);
    expect(calls.at(-1).messages.at(-1).content).toHaveLength(2);
    h.context=original;
    await requestDshCompletion(channel,batch,original);
    expect(calls.at(-1).messages.every((m:any)=>typeof m.content==='string')).toBe(true);
    await requestDshCompletion({...channel,id:'another-channel'},batch,original);
    expect(calls.at(-1).messages.at(-1).content).toHaveLength(2);
  });
  it('records the actual retried ordinary atlas revision rather than the latest prepared revision',async()=>{
    const batch=(hash:string)=>[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait'],4,hash,'STATIC GUIDANCE')];
    const operation:DshOperation={};let failed=false;
    server(body=>{if(!failed){failed=true;throw new TypeError('network');}return response(body);});
    await expect(requestDshCompletion(channel,batch('a'.repeat(64)),h.context!,{operation})).rejects.toThrow('network');
    await requestDshCompletion(channel,batch('b'.repeat(64)),h.context!,{operation});
    expect(calls[1]).toEqual(calls[0]);
    await requestDshCompletion(channel,batch('b'.repeat(64)),h.context!);
    expect(calls[2].messages.at(-1).content).toHaveLength(2);
    await requestDshCompletion(channel,batch('b'.repeat(64)),h.context!);
    expect(calls[3].messages.every((m:any)=>typeof m.content==='string')).toBe(true);
  });
  it('uploads again when an ordinary response replaces the session without carrying the atlas',async()=>{
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait'],4,'a'.repeat(64))];
    await requestDshCompletion(channel,batch,h.context!);
    server(body=>response(body,{dsh_session:{session_id:'new-remote-session'}}));
    await requestDshCompletion(channel,batch,h.context!);
    expect(calls.at(-1).messages.every((m:any)=>typeof m.content==='string')).toBe(true);
    await requestDshCompletion(channel,batch,h.context!);
    expect(payload(calls.at(-1)).session_id).toBe('new-remote-session');
    expect(calls.at(-1).messages.at(-1).content).toHaveLength(2);
  });
  it('uploads the full atlas once per dedicated session and resends revisions or after reset',async()=>{
    settings.autoTag.dshDedicated=true;imageLimit=20;
    const atlas=(hash:string)=>layoutAtlasMessages(Array(6).fill('data:image/png;base64,AAAA'),Array(6).fill('portrait，layout ID 1'),4,hash,'FULL CATALOG');
    const first=[...messages.map(message=>message.content==='world' ? {...message,content:'【本轮版式选择范围】ID：1、2'} : message),...atlas('a'.repeat(64))];
    await requestDshCompletion(channel,first,h.context!);
    expect(payload(calls[0]).action).toBe('sync_rules');
    expect(payload(calls[1]).layout_atlas.message_indices).toEqual([2]);
    expect(calls[1].messages.at(-1).content).toHaveLength(7);
    expect(JSON.stringify(calls[1].messages)).toContain('FULL CATALOG');
    calls=[];
    settings.autoTag.dshDedicatedState=JSON.parse(JSON.stringify(settings.autoTag.dshDedicatedState));
    const next=first.map(message=>message.content==='【本轮版式选择范围】ID：1、2' ? {...message,content:'【本轮版式选择范围】ID：2'} : message);
    await requestDshCompletion(channel,next,h.context!);
    expect(calls).toHaveLength(1);
    expect(payload(calls[0]).layout_atlas).toEqual({hash:'a'.repeat(64),message_indices:[]});
    expect(calls[0].messages.every((message:any)=>typeof message.content==='string')).toBe(true);
    expect(JSON.stringify(calls[0].messages)).not.toContain('FULL CATALOG');
    expect(calls[0].messages.map((message:any)=>message.content)).toContain('【本轮版式选择范围】ID：2');
    calls=[];
    h.context=context('another-chat');
    await requestDshCompletion(channel,first,h.context!);
    expect(payload(calls[0]).layout_atlas.message_indices).toEqual([]);
    calls=[];
    await requestDshCompletion(channel,[...messages,...atlas('b'.repeat(64))],h.context!);
    expect(calls[0].messages.at(-1).content).toHaveLength(7);
    expect(payload(calls[0]).layout_atlas.hash).toBe('b'.repeat(64));
    await requestDshCompletion(channel,[],h.context!,{action:'reset'});
    calls=[];
    await requestDshCompletion(channel,[...messages,...atlas('b'.repeat(64))],h.context!);
    expect(payload(calls[0]).action).toBe('sync_rules');
    expect(calls[1].messages.at(-1).content).toHaveLength(7);
  });
  it('reuses the exact atlas upload after an ambiguous network failure',async()=>{
    settings.autoTag.dshDedicated=true;imageLimit=20;
    const operation:DshOperation={};let failed=false;
    server(body=>{if(payload(body).action==='generate'&&!failed){failed=true;throw new TypeError('network');}return response(body);});
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait，layout ID 1'],4,'a'.repeat(64))];
    await expect(requestDshCompletion(channel,batch,h.context!,{operation})).rejects.toThrow('network');
    await requestDshCompletion(channel,batch,h.context!,{operation});
    expect(calls[2]).toEqual(calls[1]);
    expect(payload(calls[2]).layout_atlas.hash).toBe('a'.repeat(64));
  });
  it('resynchronizes and uploads again after the retained atlas is lost',async()=>{
    settings.autoTag.dshDedicated=true;imageLimit=20;
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait，layout ID 1'],4,'a'.repeat(64))];
    await requestDshCompletion(channel,batch,h.context!);
    let missing=true;calls=[];
    server(body=>{if(payload(body).action==='generate'&&missing){missing=false;return new Response('atlas missing',{status:410});}return response(body);});
    const operation:DshOperation={};
    await expect(requestDshCompletion(channel,batch,h.context!,{operation})).rejects.toThrow();
    expect(payload(calls[0]).layout_atlas.message_indices).toEqual([]);
    await requestDshCompletion(channel,batch,h.context!,{operation});
    expect(payload(calls[1]).action).toBe('sync_rules');
    expect(payload(calls[2]).layout_atlas.message_indices).toEqual([2]);
  });
  it.each([4,20])('groups six atlas images using the live %s-image message limit',async(limit)=>{
    imageLimit=limit;
    const images=Array.from({length:6},(_,i)=>'data:image/png;base64,'+btoa(`image-${i}`));
    const atlas=layoutAtlasMessages(images,images.map((_,i)=>`portrait，layout ID ${i+1}`));
    const batch=[...messages,...atlas],before=JSON.stringify(batch);
    await requestDshCompletion(channel,batch,h.context!);
    const blocks=calls[0].messages.filter((message:any)=>Array.isArray(message.content));
    expect(blocks.map((message:any)=>message.content.length-1)).toEqual(limit===20 ? [6] : [4,2]);
    expect(blocks.flatMap((message:any)=>message.content.slice(1).map((part:any)=>part.image_url.url))).toEqual(images);
    expect(blocks.at(-1).content[0].text).toContain(limit===20 ? '本消息第 6 张（总图 6）' : '本消息第 2 张（总图 6）');
    expect(JSON.stringify(calls[0])).not.toContain('atlasLabels');
    expect(JSON.stringify(batch)).toBe(before);
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith('/v1/bridge/capabilities'))).toHaveLength(1);
  });
  it('retries an ambiguous image request verbatim when the advertised limit increases',async()=>{
    const operation:DshOperation={};
    const batch=[...messages,...layoutAtlasMessages(Array(6).fill('data:image/png;base64,AAAA'),Array(6).fill('portrait，layout ID 1'))];
    let failed=false;
    server(body=>{if(!failed){failed=true;throw new TypeError('network');}return response(body);});
    await expect(requestDshCompletion(channel,batch,h.context!,{operation})).rejects.toThrow('network');
    imageLimit=20;
    await requestDshCompletion(channel,batch,h.context!,{operation});
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1].messages.filter((message:any)=>Array.isArray(message.content)).map((message:any)=>message.content.length-1)).toEqual([4,2]);
  });
  it.each(['plugin','skill'] as const)('retries a retained dedicated atlas without losing confirmed capabilities: %s',async(source)=>{
    settings.autoTag.dshDedicated=true;settings.autoTag.dshRuleSource=source;
    const endpoint={...channel,url:'http://127.0.0.1:43121/clients/baibaohui/v1'};
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait'],4,'a'.repeat(64))];
    await requestDshCompletion(endpoint,batch,h.context!,{protocolKey:'manga'});
    calls=[];let failures=2;
    server(body=>{if(failures-->0)throw new TypeError('network');return response(body);});
    const operation:DshOperation={};
    await expect(requestDshCompletion(endpoint,batch,h.context!,{operation,protocolKey:'manga'})).rejects.toThrow('network');
    expect(operation.pending?.session.layout_atlas?.message_indices).toEqual([]);
    const original=structuredClone(calls[0]);
    const capabilityCalls=()=>vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith('/v1/bridge/capabilities')).length;
    const beforeRetry=capabilityCalls();
    await expect(requestDshCompletion(endpoint,batch,h.context!,{operation,protocolKey:'manga'})).rejects.toThrow('network');
    await expect(requestDshCompletion(endpoint,batch,h.context!,{operation,protocolKey:'manga'})).resolves.toBe('result');
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(original);expect(calls[2]).toEqual(original);
    expect(calls.every(call=>call.messages.every((message:any)=>typeof message.content==='string'))).toBe(true);
    expect(capabilityCalls()).toBe(beforeRetry);
  });
  it('rechecks retained atlas capabilities when an older pending snapshot has no handshake',async()=>{
    settings.autoTag.dshDedicated=true;
    const batch=[...messages,...layoutAtlasMessages(['data:image/png;base64,AAAA'],['portrait'],4,'a'.repeat(64))];
    await requestDshCompletion(channel,batch,h.context!);
    calls=[];let fail=true;
    server(body=>{if(fail){fail=false;throw new TypeError('network');}return response(body);});
    const operation:DshOperation={};
    await expect(requestDshCompletion(channel,batch,h.context!,{operation})).rejects.toThrow('network');
    delete operation.pending!.capabilities;
    vi.mocked(fetch).mockClear();
    await expect(requestDshCompletion(channel,batch,h.context!,{operation})).resolves.toBe('result');
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith('/v1/bridge/capabilities'))).toHaveLength(1);
    expect(calls[1]).toEqual(calls[0]);
  });
  it('rejects images on an old bridge before dedicated sync or generation',async()=>{
    settings.autoTag.dshDedicated=true;
    const fetch=vi.fn(async()=>new Response(JSON.stringify({version:'0.13.0'})));
    vi.stubGlobal('fetch',fetch);
    await expect(requestDshCompletion(channel,[...messages,{role:'user',content:'atlas',images:['data:image/png;base64,AAAA']}],h.context!)).rejects.toThrow('0.14.0');
    expect(fetch).toHaveBeenCalledTimes(1); expect(calls).toEqual([]);
  });
  it.each([false,true])('keeps image blocks dynamic in persistent mode, dedicated=%s',async(dedicated)=>{
    settings.autoTag.dshDedicated=dedicated;
    const batch:ChatMsg[]=[...messages,{role:'user',content:'atlas',images:['data:image/png;base64,AAAA']}];
    await requestDshCompletion(channel,batch,h.context!);
    if (dedicated) expect(calls[0].messages.every((m:any)=>typeof m.content==='string')).toBe(true);
    expect(calls.at(-1).messages.at(-1).content).toEqual([{type:'text',text:'atlas'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA',detail:'high'}}]);
    batch.at(-1)!.images=['data:image/png;base64,BBBB'];
    await requestDshCompletion(channel,batch,h.context!);
    expect(payload(calls.at(-1)).fixed_message_count).toBe(0);
    expect(calls.at(-1).messages.at(-1).content[1].image_url.url).toBe('data:image/png;base64,BBBB');
  });
  it.each(['/clients/baibaohui/v1','/clients/baibaohui/v1/','/clients/baibaohui/v1/chat/completions','/v1'])('dedicated identity follows the configured client endpoint %s',async(path)=>{
    settings.autoTag.dshDedicated=true;
    await requestDshCompletion({...channel,url:'http://127.0.0.1:43121'+path},messages,h.context!);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(payload(call).client_id).toBe(path.startsWith('/clients/') ? 'baibaohui' : 'baibai-image');
      expect(payload(call).skill_id).toBeUndefined();
      expect(call.custom_url).toBe('http://127.0.0.1:43121'+path.replace(/\/chat\/completions$/,'').replace(/\/$/,''));
    }
  });
  it('carries changed panel geometry, deleted slots and notes on subsequent DSH and ordinary API requests',async()=> {
    const manga={...mangaDefaults(),enabled:true,selectionNotes:'current notes',custom:[{
      id:'moving',canvas:{width:1000,height:2000},portrait:[{position:'panel-1',slots:{F:[-1000,-500,1000,0],T:[-1000,-500,-800,0]} as Record<string,number[]>}],
    }]};
    const sizes={portrait:{width:1000,height:2000},landscape:null};
    const batch:ChatMsg[]=[...fixed.map(m=>m.purpose==='spec' ? {...m,content:buildMangaSpec(manga,false)} : m),{role:'user',content:'current target'}];
    setLayoutSelectionMessage(batch,createLayoutSelection(h.context!,manga,sizes,'portrait'));
    await requestDshCompletion(channel,batch,h.context!);
    expect(calls[0].messages.find((m:any)=>m.content.includes('【本轮版式选择范围】')).content).toContain('位置[0,0,50,100]');
    expect(batch.find(m=>m.purpose==='spec')!.content).not.toContain('- moving｜');
    manga.custom[0].portrait[0].slots.F=[-1000,0,1000,500];
    delete manga.custom[0].portrait[0].slots.T;
    manga.selectionNotes='changed notes';
    setLayoutSelectionMessage(batch,createLayoutSelection(h.context!,manga,sizes,'portrait'));
    await requestDshCompletion(channel,batch,h.context!);
    const current=calls[1].messages.find((m:any)=>m.content.includes('【本轮版式选择范围】')).content;
    expect(payload(calls[1]).fixed_message_count).toBe(0);
    expect(current).toContain('位置[50,0,50,100]');
    expect(current).toContain('changed notes');
    expect(current).not.toContain('T[');
    server(()=>new Response(JSON.stringify({choices:[{message:{content:'ordinary'}}]})));
    await requestCompletion({...channel,stream:false},batch);
    expect(calls[2].messages.find((m:any)=>m.content.includes('【本轮版式选择范围】')).content).toBe(current);
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
    server(()=>new Response(JSON.stringify({choices:[{message:{content:'ordinary'}}],usage:{prompt_tokens:1,completion_tokens:1}})));
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

  it.each(['http', 'wrapped', 'legacy'] as const)('requires acknowledgement; %s 410 clears stale binding for a full retry',async(transport)=>{
    const operation:DshOperation={};
    server(body=>response(body,{dsh_session:undefined}));
    await expect(requestDshCompletion(channel,messages,h.context!,{operation})).rejects.toThrow('session_id');
    expect(h.context!.chatMetadata).toEqual({});
    server();await requestDshCompletion(channel,messages,h.context!,{operation});
    server(()=>transport==='http' ? new Response('gone',{status:410})
      : new Response(JSON.stringify({error:transport==='wrapped' ? {message:'session expired',status:410} : {message:'Gone'}}), {headers:{'content-type':'application/json'}}));
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

describe('DSH plugin-owned dedicated mode',()=>{
  beforeEach(()=>{settings.autoTag.dshDedicated=true;});
  it('handshakes without generating, then shares one binding across chats and reloads',async()=>{
    const validate=vi.fn();await requestDshCompletion(channel,messages,h.context!,{validate});
    expect(calls).toHaveLength(2);expect(payload(calls[0]).action).toBe('sync_rules');
    expect(calls[0].messages).toHaveLength(4);expect(payload(calls[1])).toMatchObject({action:'generate',session_mode:'dedicated',fixed_message_count:0,source_chat_id:dshChatId(h.context!)});
    expect(validate).toHaveBeenCalledTimes(1);
    const first=payload(calls[1]);
    settings.autoTag.dshDedicatedState=JSON.parse(JSON.stringify(settings.autoTag.dshDedicatedState));
    h.context=context('chat-b');await requestDshCompletion(channel,messages,h.context!);
    expect(calls).toHaveLength(3);expect(payload(calls[2]).chat_id).toBe(first.chat_id);expect(payload(calls[2]).session_id).toBe(first.session_id);
    expect(payload(calls[2]).source_chat_id).not.toBe(first.source_chat_id);
    expect(h.context!.chatMetadata).toEqual({});expect(JSON.stringify(settings.autoTag.dshDedicatedState)).not.toContain(channel.key);
    settings.autoTag.dshDedicated=false;await requestDshCompletion(channel,messages,h.context!);
    expect(payload(calls[3]).session_mode).toBeUndefined();expect(calls[3].messages).toHaveLength(6);
    settings.autoTag.dshDedicated=true;await requestDshCompletion(channel,messages,h.context!);
    expect(payload(calls[4]).session_id).toBe(first.session_id);
  });
  it('updates changed rules in place and isolates routes and output formats',async()=>{
    await requestDshCompletion(channel,messages,h.context!,{protocolKey:'manga'});
    const id=payload(calls[1]).session_id;
    await requestDshCompletion(channel,messages.map(m=>m.purpose==='spec'?{...m,content:'new rules'}:m),h.context!,{protocolKey:'manga'});
    expect(payload(calls[2]).action).toBe('sync_rules');expect(payload(calls[2]).session_id).toBe(id);expect(payload(calls[3]).session_id).toBe(id);
    await requestDshCompletion(channel,messages,h.context!,{protocolKey:'nai'});
    expect(payload(calls[4]).session_id).toBeUndefined();expect(payload(calls[5]).chat_id).not.toBe(payload(calls[1]).chat_id);
    await requestDshCompletion({...channel,model:'other'},messages,h.context!,{protocolKey:'manga'});
    expect(payload(calls[6]).session_id).toBeUndefined();
  });
  it('refuses old bridges before sending a generation task',async()=>{
    server(body=>response(body,{dsh_session:{session_id:'old-bridge'}}));
    await expect(requestDshCompletion(channel,messages,h.context!)).rejects.toThrow('历史隔离能力');
    expect(calls).toHaveLength(1);expect(payload(calls[0]).action).toBe('sync_rules');
    expect(settings.autoTag.dshDedicatedState?.bindings).toEqual({});
  });
  it('retries an ambiguous generation with exactly the original body',async()=>{
    const operation:DshOperation={};let failed=false;
    server(body=>{if(payload(body).action==='generate'&&!failed){failed=true;throw new TypeError('network');}return response(body);});
    await expect(requestDshCompletion(channel,messages,h.context!,{operation})).rejects.toThrow('network');
    await requestDshCompletion(channel,messages.map(m=>({...m,content:m.content+' changed'})),h.context!,{operation});
    expect(calls).toHaveLength(3);expect(calls[2]).toEqual(calls[1]);
  });
  it('can synchronize and reset without an open Tavern chat',async()=>{
    h.context=context('');
    await requestDshCompletion(channel,fixed,h.context!,{action:'sync_rules'});
    expect(payload(calls[0]).source_chat_id).toBeUndefined();
    await requestDshCompletion(channel,[],h.context!,{action:'reset'});
    expect(payload(calls[1]).action).toBe('reset');
    await expect(requestDshCompletion(channel,messages,h.context!)).rejects.toThrow('打开一个酒馆聊天');
  });
});
