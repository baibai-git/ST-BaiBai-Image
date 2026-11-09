import {beforeEach,describe,expect,it,vi} from 'vitest';
import {nextTick} from 'vue';
const h=vi.hoisted(()=>({context:null as Record<string,any>|null}));
vi.mock('@/st/context',()=>({getContext:()=>h.context}));
describe('DSH rule source persistence',()=>{
  beforeEach(()=>{vi.resetModules();vi.stubGlobal('toastr',{info:vi.fn(),success:vi.fn(),error:vi.fn()});vi.stubGlobal('window',{addEventListener:vi.fn(),dispatchEvent:vi.fn()});});
  it.each([undefined,7,'','按 {{skill_id}} 处理本轮。\n保留原文。'])('restores and persists Skill request text: %s',async(value)=>{
    h.context={extensionSettings:{baibai_image:{autoTag:{dshSkillRequest:value}}},saveSettingsDebounced:vi.fn()};
    const {settings,hydrateSettings,DEFAULT_DSH_SKILL_REQUEST}=await import('./settings');await hydrateSettings();
    expect(settings.autoTag.dshSkillRequest).toBe(typeof value==='string'?value:DEFAULT_DSH_SKILL_REQUEST);
    settings.autoTag.dshSkillRequest='新文案 {{skill_id}}';await nextTick();
    expect(h.context!.extensionSettings.baibai_image.autoTag.dshSkillRequest).toBe('新文案 {{skill_id}}');
    settings.autoTag.dshRuleSource='plugin';await nextTick();
    expect(settings.autoTag.dshSkillRequest).toBe('新文案 {{skill_id}}');
  });
  it.each([undefined,false,true,'true'])('persists the user-message switch with a safe default: %s',async(value)=>{
    h.context={extensionSettings:{baibai_image:{autoTag:{dshUserMessages:value}}},saveSettingsDebounced:vi.fn()};
    const {settings,hydrateSettings}=await import('./settings');await hydrateSettings();
    expect(settings.autoTag.dshUserMessages).toBe(value===true);
    settings.autoTag.dshUserMessages=value!==true;await nextTick();
    expect(h.context!.extensionSettings.baibai_image.autoTag.dshUserMessages).toBe(value!==true);
  });
  it.each([undefined,'invalid','skill'])('normalizes %s and preserves custom prompts when switching',async(source)=>{
    h.context={extensionSettings:{baibai_image:{autoTag:{dshRuleSource:source,prompts:{comfySpec:'my rules',comfyThinking:'my checks'}}}},saveSettingsDebounced:vi.fn()};
    const {settings,hydrateSettings}=await import('./settings');await hydrateSettings();
    expect(settings.autoTag.dshRuleSource).toBe(source==='skill'?'skill':'plugin');
    settings.autoTag.dshRuleSource=source==='skill'?'plugin':'skill';await nextTick();
    expect(h.context!.extensionSettings.baibai_image.autoTag.dshRuleSource).toBe(settings.autoTag.dshRuleSource);
    expect(settings.autoTag.prompts.comfySpec).toBe('my rules');expect(settings.autoTag.prompts.comfyThinking).toBe('my checks');
  });
});
