import {beforeEach,describe,expect,it,vi} from 'vitest';
import {nextTick} from 'vue';
const h=vi.hoisted(()=>({context:null as Record<string,any>|null}));
vi.mock('@/st/context',()=>({getContext:()=>h.context}));
describe('DSH rule source persistence',()=>{
  beforeEach(()=>{vi.resetModules();vi.stubGlobal('toastr',{info:vi.fn(),success:vi.fn(),error:vi.fn()});vi.stubGlobal('window',{addEventListener:vi.fn(),dispatchEvent:vi.fn()});});
  it.each([undefined,'invalid','skill'])('normalizes %s and preserves custom prompts when switching',async(source)=>{
    h.context={extensionSettings:{baibai_image:{autoTag:{dshRuleSource:source,prompts:{comfySpec:'my rules',comfyThinking:'my checks'}}}},saveSettingsDebounced:vi.fn()};
    const {settings,hydrateSettings}=await import('./settings');await hydrateSettings();
    expect(settings.autoTag.dshRuleSource).toBe(source==='skill'?'skill':'plugin');
    settings.autoTag.dshRuleSource=source==='skill'?'plugin':'skill';await nextTick();
    expect(h.context!.extensionSettings.baibai_image.autoTag.dshRuleSource).toBe(settings.autoTag.dshRuleSource);
    expect(settings.autoTag.prompts.comfySpec).toBe('my rules');expect(settings.autoTag.prompts.comfyThinking).toBe('my checks');
  });
});
