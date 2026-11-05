import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDshImageSupport } from './dshImages';
import type { ApiChannel } from '@/state/settings';
import type { ChatMsg } from './client';
const h=vi.hoisted(()=>({extensions:{} as Record<string,unknown>}));
vi.mock('@/st/context',()=>({getContext:()=>({extensionSettings:h.extensions})}));
const channel:ApiChannel={id:'dsh',name:'DSH',url:'http://127.0.0.1:43121/clients/baibaohui/v1',key:'test-channel-key',model:'dsh-default',temperature:1,maxTokens:1024,timeoutSec:30,stream:false,excludeParams:[],reasoningEffort:''};
const image='data:image/png;base64,AAAA';
const messages:ChatMsg[]=[{role:'user',content:'atlas',images:[image]}];
const caps=()=>({supported:true,modes:['data_url'],roles:['user'],media_types:['image/png'],max_images_per_message:4,max_bytes_per_image:10,max_total_bytes:20});
function server(input:unknown=caps(),status=200) {
  const fetch=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({image_input:input}),{status}));
  vi.stubGlobal('fetch',fetch); return fetch;
}
beforeEach(()=>{h.extensions={};vi.unstubAllGlobals();});
describe('DSH image input capability check',()=>{
  it('skips plain text, reads the canonical endpoint and never changes messages',async()=>{
    const fetch=server(),before=JSON.stringify(messages);
    await assertDshImageSupport(channel,[{role:'user',content:'text'}]); expect(fetch).not.toHaveBeenCalled();
    await assertDshImageSupport(channel,messages);
    expect(fetch.mock.calls[0]).toMatchObject(['http://127.0.0.1:43121/v1/bridge/capabilities',{method:'GET',headers:{Authorization:'Bearer test-channel-key'},credentials:'omit'}]);
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('only supplies a paired token to its configured origin',async()=>{
    h.extensions.st_bridge_context_v1={enabled:true,base:'http://127.0.0.1:43121/v1',deviceToken:'test-paired-token'};
    const fetch=server(); await assertDshImageSupport(channel,messages);
    expect(fetch.mock.calls[0][1]).toMatchObject({headers:{Authorization:'Bearer test-paired-token'}});
    await assertDshImageSupport({...channel,url:'http://127.0.0.1:43122/v1'},messages);
    expect(fetch.mock.calls[1][1]).toMatchObject({headers:{Authorization:'Bearer test-channel-key'}});
  });
  it('rejects old or malformed capabilities instead of sending images',async()=>{
    for (const input of [null,{},{supported:false},{...caps(),modes:['remote']},{...caps(),roles:['assistant']},{...caps(),max_total_bytes:0}]) {
      server(input); await expect(assertDshImageSupport(channel,messages)).rejects.toThrow(/图片|data URL/);
    }
    server({},401); await expect(assertDshImageSupport(channel,messages)).rejects.toThrow('401');
  });
  it('enforces media, role, quantity, per-image and total decoded byte limits',async()=>{
    server(); await expect(assertDshImageSupport(channel,[{...messages[0],images:Array(5).fill(image)}])).rejects.toThrow('最多 4');
    server(); await expect(assertDshImageSupport(channel,[{...messages[0],role:'system'}])).rejects.toThrow('user');
    for (const url of ['https://example.com/a.png','data:image/png;base64,AA?A','data:image/png;base64,AAA']) {
      server(); await expect(assertDshImageSupport(channel,[{...messages[0],images:[url]}])).rejects.toThrow('data URL');
    }
    server(); await expect(assertDshImageSupport(channel,[{...messages[0],images:['data:image/svg+xml;base64,AAAA']}])).rejects.toThrow('类型');
    server({...caps(),max_bytes_per_image:2}); await expect(assertDshImageSupport(channel,messages)).rejects.toThrow('单张');
    server({...caps(),max_total_bytes:5}); await expect(assertDshImageSupport(channel,[...messages,...messages])).rejects.toThrow('总量');
    server({...caps(),max_bytes_per_image:1,max_total_bytes:1}); await expect(assertDshImageSupport(channel,[{...messages[0],images:['data:image/png;base64,AA==']}])).resolves.toBeUndefined();
  });
});
