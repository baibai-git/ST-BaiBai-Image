import { describe, expect, it, vi } from 'vitest';

import * as promptContext from '@/autoTag/context';

import { autoTagProfile, buildAutoTagMessages, buildAutoTagFixedMessages, expandNlSections, usesMossLayout } from '@/autoTag/prompt';
import {
  activeComfyPreset,
  settings,
  type AutoTagPrompts,
  type AutoTagSettings,
} from '@/state/settings';
import type { STContext } from '@/st/context';
import { applyMangaFrames, mangaDefaults } from '@/manga/layouts';
import { createLayoutSelection } from '@/autoTag/layoutCooldown';

/**
 * 提示词集:全部留空(= 回落内置默认),只把本用例关心的那几项覆盖掉。
 * 收在一处是因为 AutoTagPrompts 每加一个键,散落的字面量会同时 typecheck 失败。
 */
function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    ...overrides,
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标第一行\n\n目标第三行' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

describe('auto tag prompt', () => {
  it('builds only fixed rules for manual synchronization without any Tavern conversation',()=>{
    const options:AutoTagSettings={enabled:true,contextMessages:2,minImages:0,maxImages:3,retryCount:1,autoGenerate:true,prompts:prompts()};
    const fixed=buildAutoTagFixedMessages(options);
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed.every(message=>message.role==='system'&&!!message.purpose)).toBe(true);
    expect(fixed.some(message=>message.purpose==='contract')).toBe(true);
    expect(fixed.some(message=>message.content.includes('目标第一行'))).toBe(false);
  });

  it('keeps stable rules fixed and sends the current compatible layout geometry only in the dynamic catalog',async()=> {
    const oldBackend=settings.defaultBackend,oldManga=settings.manga;
    try {
      settings.defaultBackend='comfyui';
      settings.manga={...mangaDefaults(),enabled:true,spec:'MANGA_RULES',thinking:'MANGA_CHECK',selectionNotes:'LIVE_NOTES',custom:[
        {id:'geometry-current',canvas:{width:1000,height:2000},portrait:[{position:'panel-2',slots:{F:[-1000,-500,1000,0]}}]},
        {id:'wrong-size',canvas:{width:800,height:1200},portrait:[{position:'one',slots:{F:[-600,-400,600,400]}}]},
      ]};
      const ctx=context();
      const selection=createLayoutSelection(ctx,settings.manga,{portrait:{width:1000,height:2000},landscape:null},'portrait');
      const options:AutoTagSettings={enabled:true,contextMessages:2,minImages:0,maxImages:3,retryCount:1,autoGenerate:true,prompts:prompts()};
      const messages=await buildAutoTagMessages(ctx,1,options,null,undefined,undefined,undefined,{layout:true,nl:false,naiCharPrompts:false,lockedSize:'portrait'},selection);
      const fixed=messages.find(m=>m.purpose==='spec')!.content;
      const dynamic=messages.find(m=>m.content.startsWith('【本轮版式选择范围】'))!;
      expect(fixed).toContain('MANGA_RULES');
      expect(fixed).not.toContain('【本轮候选版式空间目录】');
      expect(fixed).not.toContain('LIVE_NOTES');
      expect(dynamic.purpose).toBeUndefined();
      expect(dynamic.content).toContain('- geometry-current｜1 格｜画布 1000×2000');
      expect(dynamic.content).toContain('位置[0,0,50,100]');
      expect(dynamic.content).toContain('LIVE_NOTES');
      expect(dynamic.content).not.toContain('- wrong-size｜');
      expect(messages.filter(m=>m.content.includes('【本轮候选版式空间目录】'))).toHaveLength(1);
    } finally {settings.defaultBackend=oldBackend;settings.manga=oldManga;}
  });
  it('packs a two-page manga example into one outer images array', async()=> {
    const oldBackend=settings.defaultBackend,oldManga=settings.manga;
    try {
      settings.defaultBackend='comfyui'; settings.manga={...mangaDefaults(),enabled:true};
      const options:AutoTagSettings={enabled:true,contextMessages:2,minImages:0,maxImages:3,retryCount:1,autoGenerate:true,prompts:prompts()};
      const messages=await buildAutoTagMessages(context(),1,options,null);
      const contract=messages.find(m=>m.purpose==='contract')!.content;
      const result=JSON.parse(contract.match(/格式固定为：\n([^\n]+)\n/)![1]);
      expect(result.images).toHaveLength(2); expect(result.changes).toEqual([]);
      const ids=new Set<string>();
      for(const image of result.images) {
        expect(image.images).toBeUndefined(); expect(image.changes).toBeUndefined();
        const inner=JSON.parse(image.tag); ids.add(inner.layout);
        expect(()=>applyMangaFrames(image.tag,settings.manga,{width:1088,height:1920})).not.toThrow();
      }
      expect(ids.size).toBe(2); expect(contract).toContain('changes 只在最外层汇总');
    } finally {settings.defaultBackend=oldBackend;settings.manga=oldManga;}
  });
  it('协议示例只选启用版式，不引用已删除的 balanced_1，空清单时阻止请求',async()=>{
    const oldBackend=settings.defaultBackend, oldManga=settings.manga;
    const options:AutoTagSettings={enabled:true,contextMessages:2,minImages:0,maxImages:3,retryCount:1,autoGenerate:true,prompts:prompts({jailbreak:'TEST_PREFIX'})};
    try {
      settings.defaultBackend='comfyui';
      const deleted=(await import('@/manga/layouts')).builtinIds('portrait');
      settings.manga={...mangaDefaults(),enabled:true,deleted,custom:[{id:'only_enabled',canvas:{width:1088,height:1920},portrait:[{position:'one',slots:{F:[-900,-500,900,500]}}]}]};
      const messages=await buildAutoTagMessages(context(),1,options,null);
      const contract=messages.find(m=>m.content.startsWith('你是严谨的'))!.content;
      const example=JSON.parse(contract.match(/格式固定为：\n([^\n]+)\n/)![1]);
      expect(JSON.parse(example.images[0].tag)).toMatchObject({layout:'only_enabled',items:[{panel:1,slot:'F'}]});
      expect(contract).not.toContain('balanced_1');
      settings.manga.custom=[];
      await expect(buildAutoTagMessages(context(),1,options,null)).rejects.toThrow(/没有启用的版式/);
    }finally{settings.defaultBackend=oldBackend;settings.manga=oldManga;}
  });
  it('漫画关闭时忽略漫画专用规范，开启后输出可编译的符号示例', async () => {
    const oldBackend = settings.defaultBackend;
    const oldManga = settings.manga;
    const options: AutoTagSettings = {
      enabled: true, contextMessages: 2, minImages: 0, maxImages: 3,
      retryCount: 1, autoGenerate: true,
      prompts: prompts({ jailbreak: 'TEST_PREFIX', comfySpec: '[BBI_FORMAT:MOSS_LAYOUT]\nREGULAR_RULES', comfyThinking: 'REGULAR_CHECK' }),
    };
    try {
      settings.defaultBackend = 'comfyui';
      settings.manga = { ...mangaDefaults(), spec: 'MANGA_RULES {{nl}}', thinking: 'MANGA_CHECK' };
      const off = (await buildAutoTagMessages(context(), 1, options, null)).map(m => m.content).join('\n');
      expect(off).toContain('REGULAR_RULES');
      expect(off).toContain('REGULAR_CHECK');
      expect(off).not.toContain('MANGA_RULES');
      expect(off).not.toContain('MANGA_CHECK');
      settings.manga.enabled = true;
      const on = await buildAutoTagMessages(context(), 1, options, null);
      expect(on.map(m => m.content).join('\n')).toContain('MANGA_CHECK');
      expect(on.map(m => m.content).join('\n')).not.toContain('{{nl}}');
      const contract = on.find(m => m.content.startsWith('你是严谨的'))!.content;
      const sample = JSON.parse(contract.match(/格式固定为：\n([^\n]+)\n/)![1]);
      const tag = sample.images[0].tag;
      expect(JSON.parse(tag)).toMatchObject({ layout: 'balanced_1', items: [{ panel: 1, slot: 'C' }] });
      expect(JSON.parse(applyMangaFrames(tag, settings.manga, { width: 1088, height: 1920 })).items[0].bbox).toHaveLength(4);
    } finally {
      settings.defaultBackend = oldBackend;
      settings.manga = oldManga;
    }
  });
  it('selects Layout only with the explicit marker and emits a matching nested JSON example', async () => {
    const oldBackend = settings.defaultBackend;
    const oldNl = activeComfyPreset().naturalLanguage;
    const preset = activeComfyPreset();
    try {
      settings.defaultBackend = 'comfyui';
      preset.naturalLanguage = true;
      expect(usesMossLayout('Discuss Layout and tag fields.')).toBe(false);
      const options: AutoTagSettings = {
        enabled: true, contextMessages: 2, minImages: 0, maxImages: 3,
        retryCount: 1, autoGenerate: true,
        prompts: prompts({ jailbreak: 'TEST_PREFIX',
          comfySpec: '[BBI_FORMAT:MOSS_LAYOUT]\nMOSS_RULES {{nl}}' }),
      };
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const spec = messages.find(m => m.content.includes('MOSS_RULES'))!.content;
      expect(spec).not.toContain('[BBI_FORMAT:MOSS_LAYOUT]');
      expect(spec).not.toContain('{{nl}}');
      expect(spec.trim()).toBe('MOSS_RULES');
      const contract = messages.find(m => m.content.startsWith('你是严谨的'))!.content;
      expect(contract).toContain('MOSS Layout 模式');
      expect(contract).not.toContain('tag 是 danbooru 短 tag');
      expect(contract).not.toContain('同一张图里这套外貌只写一遍');
      expect(contract).toContain('跨格重现必须分别绑定可见身份锚点');
      expect(contract).toContain('同页各格允许按原文推进动作');
      const sample = JSON.parse(contract.match(/格式固定为：\n([^\n]+)\n/)![1]);
      expect(sample.images[0].nl).toBe('');
      const inner = JSON.parse(sample.images[0].tag);
      expect(inner.bbox_format).toBe('yxyx');
      expect(inner.bbox_coord_space).toBe('abs_centralized');
      expect(inner.items[0].label).toBe('character');
      expect(messages.some(m => m.content.includes('tag 为完整 Layout JSON 字符串，nl 留空'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.naturalLanguage = oldNl;
    }
  });

  it('snapshots Layout mode and disables the ordinary nl profile without changing the preset toggle', () => {
    const oldBackend = settings.defaultBackend;
    const oldSpec = settings.autoTag.prompts.comfySpec;
    const preset = activeComfyPreset();
    const oldNl = preset.naturalLanguage;
    try {
      settings.defaultBackend = 'comfyui';
      preset.naturalLanguage = true;
      settings.autoTag.prompts.comfySpec = '[BBI_FORMAT:MOSS_LAYOUT]';
      expect(autoTagProfile()).toMatchObject({ layout: true, nl: false, naiCharPrompts: false });
      expect(preset.naturalLanguage).toBe(true);
      settings.defaultBackend = 'nai';
      expect(autoTagProfile().layout).toBeUndefined();
    } finally {
      settings.defaultBackend = oldBackend;
      settings.autoTag.prompts.comfySpec = oldSpec;
      preset.naturalLanguage = oldNl;
    }
  });

  it('keeps backend rules in a stable prefix when activated world info changes', async () => {
    const originalBackend = settings.defaultBackend;
    settings.defaultBackend = 'comfyui';
    const card = vi.spyOn(promptContext, 'fetchCharCard').mockReturnValue('CARD_MARKER');
    const persona = vi.spyOn(promptContext, 'fetchUserPersona').mockReturnValue('PERSONA_MARKER');
    const world = vi.spyOn(promptContext, 'fetchWorldInfo').mockResolvedValue('WORLD_A');
    try {
      const options: AutoTagSettings = {
        enabled: true, contextMessages: 2, minImages: 0, maxImages: 3,
        retryCount: 1, autoGenerate: true,
        prompts: prompts({
          jailbreak: 'PREFIX_MARKER', comfySpec: 'SPEC_MARKER',
          comfyThinking: 'CHECK_MARKER',
        }),
      };
      const first = await buildAutoTagMessages(context(), 1, options, null);
      world.mockResolvedValue('WORLD_B');
      const second = await buildAutoTagMessages(context(), 1, options, null);
      expect(first.slice(0, 4)).toEqual(second.slice(0, 4));
      expect(first.slice(0, 4).map(m => m.role)).toEqual(['system', 'system', 'system', 'system']);
      expect(first.slice(0, 4).map(m => m.purpose)).toEqual(['prefix', 'spec', 'contract', 'check']);
      expect(first.slice(4).every(m => m.purpose === undefined)).toBe(true);
      expect(first[0].content).toBe('PREFIX_MARKER');
      expect(first[1].content).toContain('SPEC_MARKER');
      expect(first[2].content).toContain('你是严谨的剧情画面规划与生图提示词编写员');
      expect(first[3].content).toContain('CHECK_MARKER');
      expect(first[4].content).toContain('CARD_MARKER');
      expect(first[5].content).toContain('PERSONA_MARKER');
      expect(first[6].content).toContain('WORLD_A');
      expect(second[6].content).toContain('WORLD_B');
      expect(second[6].content).not.toContain('<<<STB-KEEP>>>');
      const protectedRound = await buildAutoTagMessages(context(), 1, {...options,dshSession:true}, null);
      const protectedWorld=protectedRound.find(message=>message.content.includes('WORLD_B'))!;
      expect(protectedWorld.role).toBe('system');expect(protectedWorld.purpose).toBeUndefined();
      expect(protectedWorld.content).toMatch(/^<<<STB-KEEP>>>[\s\S]*WORLD_B\n<<<STB-\/KEEP>>>$/);
      expect(protectedRound.slice(0,4)).toEqual(second.slice(0,4));
      expect(first.at(-1)?.role).toBe('user');
      expect(first.at(-1)?.content).toContain('目标第一行');
    } finally {
      card.mockRestore(); persona.mockRestore(); world.mockRestore();
      settings.defaultBackend = originalBackend;
    }
  });

  it('marks only clean target paragraphs without pulling user messages before the earliest selected AI floor', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 3,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ jailbreak: '附加规则' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加规则');
    expect(messages.some(m => m.role === 'system' && m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))).toBe(true);
    expect(messages.some(m => m.content.includes('除一个 <thinking> 块和一个 JSON 对象外'))).toBe(true);
    expect(messages.some(m => m.content.includes('最终结果必须包含且只能包含一个可解析的 JSON 对象'))).toBe(true);
    expect(messages.some(m => m.content.includes('images 数量必须在 0～3 之间'))).toBe(true);
    expect(messages.some(m => m.content.includes('没有值得绘制的可见瞬间时可以返回空数组'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得包含质量词'))).toBe(true);
    expect(messages.some(m => m.content.includes('先完成角色建档与变化检查'))).toBe(true);
    expect(messages.some(m => m.content.includes('同一事件的相邻动作'))).toBe(true);
    expect(messages.some(m => m.content.includes('两人同框不等于必须横屏'))).toBe(true);
    expect(messages.some(m => m.content.includes('"field":"new"'))).toBe(true);
    expect(messages.some(m => m.content.includes('"hair":"long black hair","eyes":"blue eyes"'))).toBe(true);
    expect(messages.some(m => m.content.includes('首次出场就必须建档'))).toBe(true);
    expect(messages.some(m => m.content.includes('角色卡、世界书、柏宝书或持续剧情'))).toBe(true);
    expect(messages.some(m => m.content.includes('hair 与 eyes 必填'))).toBe(true);
    expect(messages.some(m => m.content.includes('"position":"P2"'))).toBe(true);
    expect(messages.some(m => m.content.includes('后续不得重新随机'))).toBe(true);
    // 建档不受入选与否影响,也不受位置门控 —— 这两条是修复的核心,措辞必须在协议里
    expect(messages.some(m => m.content.includes('不论他是否入选本次图片'))).toBe(true);
    expect(messages.some(m => m.content.includes('建档在本楼全程有效'))).toBe(true);
    // 已撤销的 characters 审计:不得回流到协议里
    expect(messages.some(m => m.content.includes('characters'))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('【角色固定外貌库】[system-maintained; currently empty]');
    expect(user.content).toContain('当前为空，没有任何角色已建档');
    expect(user.content).not.toContain('上一层');
    expect(user.content).toContain('目标第一行 ⟦P1⟧\n\n目标第三行 ⟦P2⟧');
    expect(user.content).not.toContain('[L0001]');
    expect(messages.some(message => message.content.includes('"position"'))).toBe(true);
  });

  it('turns a positive minimum into a strict image-count range', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 2,
      maxImages: 4,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('images 数量必须在 2～4 之间'))).toBe(true);
    expect(messages.some(m => m.content.includes('下限 2 是用户明确要求'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得返回少于 2 张或空数组'))).toBe(true);
  });

  it('uses the prepared target snapshot without recomputing position IDs', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      null,
      {
        promptText: '请求开始时的正文快照 ⟦P9⟧',
        segments: [{ id: 'P9', sourceLine: 7, text: '请求开始时的正文快照' }],
      },
    );
    const user = messages[messages.length - 1];

    expect(user.content).toContain('请求开始时的正文快照 ⟦P9⟧');
    expect(user.content).not.toContain('目标第一行 ⟦P1⟧');
  });

  it('counts context by AI floors and removes prior image payloads only from outgoing content', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'User', is_user: true, is_system: false, mes: '更早用户楼' },
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: `<think>隐藏思维</think>
<bbs_start>上午</bbs_start>
上一个 AI 楼
<snow>状态栏</snow>
<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>
<bbs_end>中午</bbs_end>
尾部状态`,
      },
      { name: 'User', is_user: true, is_system: false, mes: '中间用户楼' },
      { name: 'Char', is_user: false, is_system: false, mes: '当前目标楼\n<bbi_image><tag>{"layout":"4","summary":{"caption":"OLD_TARGET_LAYOUT"}}</tag></bbi_image>', extra: { bbiImage: { retained: true } } },
    ];
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };

    const originalChat = JSON.stringify(ctx.chat);
    const oldTags = [...settings.excludes.customStripTags];
    const messages = await (async () => {
      settings.excludes.customStripTags = ['snow'];
      try {
        return await buildAutoTagMessages(ctx, 3, options, null);
      } finally {
        settings.excludes.customStripTags = oldTags;
      }
    })();
    const user = messages[messages.length - 1];
    expect(user.content).not.toContain('更早用户楼');
    expect(user.content).toContain('上一个 AI 楼');
    expect(user.content).not.toContain('<bbi_image>');
    expect(user.content).not.toContain('1girl, long silver hair, red eyes');
    expect(user.content).not.toContain('OLD_TARGET_LAYOUT');
    expect(JSON.stringify(ctx.chat)).toBe(originalChat);
    expect(user.content).toContain('中间用户楼');
    expect(user.content).not.toContain('隐藏思维');
    expect(user.content).not.toContain('状态栏');
    expect(user.content).not.toContain('尾部状态');
    expect(user.content).not.toContain('上下文楼层');
    expect(user.content).toContain('当前目标楼 ⟦P1⟧');
    expect(user.content).not.toContain('上一个 AI 楼 ⟦P');
  });

  it('attaches the built-in thinking checklist by default', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    const thinkingMsg = messages.find(m => m.content.includes('输出前思考清单'));
    expect(thinkingMsg?.role).toBe('system');

    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('目标正文');
  });

  it('uses custom thinking when provided', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ comfyThinking: '自定义清单' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('自定义清单'))).toBe(true);
    expect(messages.some(m => m.content.includes('输出前思考清单'))).toBe(false);
    // 预填充功能已移除:消息里不应再出现 assistant 角色。
    expect(messages.some(m => m.role === 'assistant')).toBe(false);
  });

  // 思维链按后端各存一份。改 ComfyUI 那份不能影响 NAI——共用一份正是 V5 被要求填
  // 「景别/环境光/邻接绑定」这类它的规范从未教过的字段的根因。
  it('picks the thinking checklist per backend and never crosses them over', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({
        comfyThinking: 'COMFY-CHECKLIST',
        naiThinking: 'NAI-CHECKLIST',
        naiV5Thinking: 'NAIV5-CHECKLIST',
      }),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      const cases = [
        { backend: 'comfyui', model: oldModel, want: 'COMFY-CHECKLIST' },
        // 单串分支的代表换成原版 NAI4:4.5 起走 Character Prompts 分支(自然语言是 4.5 引入的)
        // ⚠ NAI4 已从 NAI_MODELS 撤下(设置页选不到了),但 prompt.ts 的单串分支与
        // naiSpec/naiThinking 两个键都还在,故这条继续按字符串锁住分支归属。
        { backend: 'nai', model: 'nai-diffusion-4-full', want: 'NAI-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-4-5-full', want: 'NAIV5-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-5-full', want: 'NAIV5-CHECKLIST' },
      ] as const;
      const all = ['COMFY-CHECKLIST', 'NAI-CHECKLIST', 'NAIV5-CHECKLIST'];
      for (const { backend, model, want } of cases) {
        settings.defaultBackend = backend;
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const text = messages.map(m => m.content).join('\n');
        for (const marker of all) {
          expect([backend, model, marker, text.includes(marker)]).toEqual([
            backend,
            model,
            marker,
            marker === want,
          ]);
        }
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 原版 NAI4 的 char_captions 恒为空(nai.ts),协议形态与 ComfyUI 一样是单条 tag 串,
  // 一样需要邻接绑定——但 NAI 规范里此前一条多人规则、一个示例都没有。
  // (4.5 起走 Character Prompts 分支,归属另一份规范,不适用邻接绑定。)
  it('gives NAI 4 the multi-character binding rules and a worked example', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('多人画面（两人及以上）额外规则');
      expect(text).toContain('white dress on green hair girl');
      expect(text).toContain('petite on silver hair girl');
      expect(text).toContain('black hair girl smiling, silver hair girl looking at another');
      expect(text).toContain('dark trousers on black hair boy');
      // 示例是规则的靠山:只有条文没有示例时模型照抄不到写法。
      expect(text).toContain('多人 tag 示例');
      // NAI 不吃 ComfyUI 的权重括号转义,那条不该跟着复制过来。
      expect(text).not.toContain('ComfyUI 会把未转义圆括号当作权重语法');
      // 排序统一到「构图紧跟人数」口径:与 Comfy 一致,也与多人规则原文一致;
      // 旧的「镜头构图放末尾」排序表和示例曾与此自相矛盾。
      expect(text).toContain('人数/主体 → 镜头构图 → 外貌');
      expect(text).not.toContain('场景 → 光线氛围 → 镜头构图');
      expect(text).toContain('2girls, medium shot, long hair');
      expect(text).not.toContain('park, sunset, medium shot');
      // 视线词表笔误:eyes closed 是 closed eyes 的别名,同 tag 两种词序不该并列。
      expect(text).not.toContain('eyes closed');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  it('has the library dictate copied field values instead of @ placeholders', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const library = '【角色固定外貌库(系统维护)】\n小雪: 1girl, long silver hair';
    const messages = await buildAutoTagMessages(context(), 1, options, null, undefined, library);

    // 示例改用实际外貌串;@占位符已撤回(见 charAnchors.ts 文件头)
    expect(messages.some(m => m.content.includes('"tag":"1girl, long silver hair, red eyes, white dress"'))).toBe(true);
    expect(messages.some(m => m.content.includes('@小雪'))).toBe(false);
    expect(messages.some(m => m.content.includes('系统会替换成库中最新 tag'))).toBe(false);
    // 身份字段保持原词；可见取用和默认衣着不再被整套照抄覆盖。
    expect(messages.some(m => m.content.includes('身份特征须取当前有效的库中/刚建档字段并保持原词'))).toBe(true);
    expect(messages.some(m => m.content.includes('只选本镜头可见部分'))).toBe(true);
    expect(messages.some(m => m.content.includes('只写一遍'))).toBe(true);
    expect(messages[messages.length - 1].content).toContain(library);
    expect(messages[messages.length - 1].content).not.toContain('currently empty');
  });

  it('keeps first-appearance profiling enabled when BaiBai Book memory exists', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      {
        timing: 'before_latest',
        text: '【角色参考】已有其他角色',
        roles: [],
      },
    );

    expect(messages.some(message => message.content.includes('首次出场就必须'))).toBe(true);
    expect(messages.some(message => message.content.includes('柏宝书本次未提供'))).toBe(false);
  });

  it('uses the dedicated NAI V5 Base and Character Prompt contract', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('one Base Prompt plus zero or more native Character Prompts'))).toBe(true);
      expect(messages.some(message => message.content.includes('"characters":['))).toBe(true);
      expect(messages.some(message => message.content.includes('source# / target# / mutual#'))).toBe(true);
      expect(messages.some(message => message.content.includes('Character tag uses girl/boy without a numeric count'))).toBe(true);
      expect(messages.some(message => message.content.includes('every field:"new" change must include a non-empty nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('Expression and gaze are mandatory for every character'))).toBe(true);
      // Base 的全局性对 tag 与 nl 同样成立:实跑里模型把单角色的制服/体型写进 Base nl,
      // 与角色 nl 重复——旧文本只把禁令写在 tag 层面。
      expect(messages.some(message => message.content.includes('this applies to the Base nl as much as to the Base tag'))).toBe(true);
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // 建档 nl 只写固定外貌:临时服装进了永久档案的 nl,会跟着之后每楼走。
      expect(messages.some(message => message.content.includes('temporary states never enter the profile'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  it('requests per-image negative tags only when the ComfyUI workflow uses %negative_prompt%', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    // 工作流改由「当前预设」承载(见 settings.ts 工作流库);默认值恒有一条,直接改它
    const preset = activeComfyPreset();
    const oldWorkflow = preset.workflow;
    const oldNegative = preset.generateNegative;
    try {
      settings.defaultBackend = 'comfyui';
      preset.generateNegative = true;
      preset.workflow = JSON.stringify({
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: { text: '%prompt%', negative: '%negative_prompt%' },
        },
      });
      const messages = await buildAutoTagMessages(context(), 1, options, null);

      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);
      expect(messages.some(message => message.content.includes('禁止输出通用质量、画质、审美或技术性负面词'))).toBe(true);
      expect(messages.some(message => message.content.includes('worst quality、low quality、blurry'))).toBe(true);
      expect(messages.some(message => message.content.includes('工作流里已有的通用质量负面词'))).toBe(false);
      expect(messages.some(message => message.content.includes('不得使用 @角色占位符'))).toBe(true);
      // 实跑里模型给下雨的正文配了 "negative":"rain, umbrella",反而抵消了 tag 的 wet asphalt。
      expect(messages.some(message => message.content.includes('negative 里绝不能出现正文已明确成立的事实'))).toBe(true);
      expect(messages.some(message => message.content.includes('正文写了在下雨'))).toBe(true);
      // 复发一次:nl 自己写了 drizzle,negative 仍填 rain。禁令必须覆盖「否定自己刚写的内容」。
      expect(messages.some(message => message.content.includes('也不能否定你自己刚写进本图 tag/nl 的任何东西'))).toBe(true);
      expect(messages.some(message => message.content.includes('写完 negative 逐词回看本图的 tag 与 nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('空的 negative 永远比抵消正文的 negative 安全'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.workflow = oldWorkflow;
      preset.generateNegative = oldNegative;
    }
  });

  it('简易模式的动态负面词门槛由模板决定:checkpoint/anima 请求,flux 不请求', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const preset = activeComfyPreset();
    const oldMode = preset.mode;
    const oldTemplate = preset.simple.template;
    const oldNegative = preset.generateNegative;
    try {
      settings.defaultBackend = 'comfyui';
      preset.generateNegative = true;
      preset.mode = 'simple';
      preset.simple.template = 'checkpoint';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);

      preset.simple.template = 'flux';
      const fluxMessages = await buildAutoTagMessages(context(), 1, options, null);
      expect(fluxMessages.some(message => message.content.includes('"negative":"extra people'))).toBe(false);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.mode = oldMode;
      preset.simple.template = oldTemplate;
      preset.generateNegative = oldNegative;
    }
  });
});

describe('自然语言条件段 expandNlSections', () => {
  it('{{#nl}} 段只在开启时保留,{{^nl}} 段只在关闭时保留', () => {
    const text = 'A{{#nl}}-on{{/nl}}{{^nl}}-off{{/nl}}B';
    expect(expandNlSections(text, true)).toBe('A-onB');
    expect(expandNlSections(text, false)).toBe('A-offB');
  });

  it('段内可以跨行;没有条件段的文本原样返回(整段替换的 {{nl}} 宏不归它管)', () => {
    const text = 'x{{#nl}}\n第一行\n第二行\n{{/nl}}y';
    expect(expandNlSections(text, true)).toBe('x\n第一行\n第二行\ny');
    expect(expandNlSections(text, false)).toBe('xy');
    expect(expandNlSections('plain {{nl}} text', false)).toBe('plain {{nl}} text');
  });

  it('配不上对的标记原样留着,不吞掉后文', () => {
    // 写错了在请求历史里看得见;静默吞掉的话,漏闭合会把后面整份规范一起删光
    expect(expandNlSections('a{{#nl}}b', false)).toBe('a{{#nl}}b');
    expect(expandNlSections('a{{/nl}}b', true)).toBe('a{{/nl}}b');
  });
});

// NAI 4.5 的提示词 token 上限比 V5 紧,自然语言是最占预算的部分 —— 这是开关的由来。
// 口径与 ComfyUI 那个开关相同:只管 AI 写不写,已写进正文的 nl 照常发送。
describe('NAI「生成自然语言」开关与渠道画幅锁', () => {
  function options(overrides: Partial<AutoTagPrompts> = {}): AutoTagSettings {
    return {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(overrides),
    };
  }

  /** 每条用例都会拨后端与开关:进来时快照,出去时原样放回(settings 是模块级单例)。 */
  function snapshot() {
    const preset = activeComfyPreset();
    const saved = {
      backend: settings.defaultBackend,
      model: settings.nai.model,
      naiNl: settings.nai.naturalLanguage,
      naiLock: settings.nai.orientationLock,
      presetNl: preset.naturalLanguage,
      presetLock: preset.orientationLock,
    };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        settings.nai.model = saved.model;
        settings.nai.naturalLanguage = saved.naiNl;
        settings.nai.orientationLock = saved.naiLock;
        preset.naturalLanguage = saved.presetNl;
        preset.orientationLock = saved.presetLock;
      },
    };
  }

  const CONTRACT_MARK = '你是严谨的剧情画面规划与生图提示词编写员';
  const NAI_SPEC_MARK = '[NovelAI 4.5/V5 Prompt Specification]';
  const THINKING_MARK = '输出前思考清单';

  function pick(messages: { content: string }[], mark: string): string {
    const found = messages.find(m => m.content.includes(mark));
    expect(found, mark).toBeTruthy();
    return found!.content;
  }

  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    '关掉后 %s 的协议、规范、思维链整套切成纯 tag;拨回开启即恢复',
    async model => {
      const state = snapshot();
      try {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        settings.nai.naturalLanguage = false;
        const messages = await buildAutoTagMessages(context(), 1, options(), null);
        const contract = pick(messages, CONTRACT_MARK);
        const spec = pick(messages, NAI_SPEC_MARK);
        const thinking = pick(messages, THINKING_MARK);

        // 示例 JSON 里一个 nl 键都不留:模型照抄示例的倾向比照读规则强得多
        expect(contract).not.toContain('"nl"');
        expect(contract).toContain('"characters":[{"name":"小雪"');
        expect(contract).toContain('This output is tag-only');
        expect(contract).toContain('name and tag are both required');
        // 建档也不再要 nl —— runner 验收同一口径(profile.nl),否则会为不存在的要求白耗重试
        expect(contract).not.toContain('every field:"new" change must include a non-empty nl');

        // 规范第 6 条整条换成 tag-only 版本(编号不动),示例与条目形状同步去掉 nl
        expect(spec).toContain('This output is tag-only: write no nl key anywhere');
        expect(spec).toContain('{"name":"...","tag":"..."}');
        expect(spec).not.toContain('"nl":');
        expect(spec).not.toContain('Save adjectival nuance for nl');
        expect(thinking).toContain('本次只写 tag');
        expect(thinking).not.toContain('不写完整 nl 句');
        // 多角色提示词本身不受开关影响:关的只是 nl,characters[] 照样要
        expect(thinking).toContain('characters[]');

        settings.nai.naturalLanguage = true;
        const on = (await buildAutoTagMessages(context(), 1, options(), null))
          .map(m => m.content)
          .join('\n');
        expect(on).toContain('"nl":"A girl stands in a classroom');
        expect(on).toContain('Save adjectival nuance for nl.');
        expect(on).toContain('every field:"new" change must include a non-empty nl');
        expect(on).toContain('不写完整 nl 句');
        expect(on).not.toContain('This output is tag-only');
        expect(on).not.toContain('本次只写 tag');
      } finally {
        state.restore();
      }
    },
  );

  it('自定义规范与思维链同样按开关展开条件段(两个后端各认各的开关)', async () => {
    const state = snapshot();
    const custom = options({
      naiV5Spec: 'NAI-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      naiV5Thinking: 'NAI-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      comfySpec: 'COMFY-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      comfyThinking: 'COMFY-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
    });
    const run = async () =>
      (await buildAutoTagMessages(context(), 1, custom, null)).map(m => m.content).join('\n');
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.naturalLanguage = false;
      // ComfyUI 那份开着也不该影响 NAI
      state.preset.naturalLanguage = true;
      let text = await run();
      expect(text).toContain('NAI-SPEC tag-only');
      expect(text).toContain('NAI-THINK tag-only');
      expect(text).not.toContain('with-nl');

      settings.nai.naturalLanguage = true;
      text = await run();
      expect(text).toContain('NAI-SPEC with-nl');
      expect(text).toContain('NAI-THINK with-nl');

      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = false;
      text = await run();
      expect(text).toContain('COMFY-SPEC tag-only');
      expect(text).toContain('COMFY-THINK tag-only');
      expect(text).not.toContain('with-nl');

      state.preset.naturalLanguage = true;
      text = await run();
      expect(text).toContain('COMFY-SPEC with-nl');
      expect(text).toContain('COMFY-THINK with-nl');
    } finally {
      state.restore();
    }
  });

  // 只锁出图不改协议的话,模型照样按横竖判据取景:锁竖时为群像构思宽画面,出图却是竖的
  it('NAI 锁横屏:协议改口为每张都填 landscape,示例同步,不再给选向兜底', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.orientationLock = 'landscape';
      const contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('锁定为横图，每张图都填 "landscape"');
      expect(contract).toContain('判据本次不适用');
      expect(contract).toContain('"size":"landscape"}],"changes":[]}');
      expect(contract).not.toContain('拿不准就填 "portrait"');
    } finally {
      state.restore();
    }
  });

  it('ComfyUI 锁看当前工作流那份;NAI 的锁不串过来', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      settings.nai.orientationLock = 'landscape';
      state.preset.orientationLock = 'portrait';
      let contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('锁定为竖图，每张图都填 "portrait"');
      expect(contract).toContain('"size":"portrait"}],"changes":[]}');

      state.preset.orientationLock = 'auto';
      contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('拿不准就填 "portrait"');
      expect(contract).not.toContain('已由用户在渠道设置里锁定');
    } finally {
      state.restore();
    }
  });
});


describe('ComfyUI AI负面提示词开关', () => {
  it('工作流有负面占位符但关闭时，协议不要求负面字段且明确禁止AI补写', async () => {
    const backend = settings.defaultBackend;
    const preset = activeComfyPreset();
    const saved = { mode: preset.mode, workflow: preset.workflow, generateNegative: preset.generateNegative };
    try {
      settings.defaultBackend = 'comfyui';
      preset.mode = 'custom';
      preset.workflow = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', negative: '%negative_prompt%' } } });
      preset.generateNegative = false;
      const messages = await buildAutoTagMessages(context(), 1, { enabled: true, contextMessages: 2, minImages: 0, maxImages: 2, retryCount: 0, autoGenerate: false, prompts: prompts() }, null);
      const contract = messages.find(message => message.purpose === 'contract')!.content;
      expect(contract).not.toContain('"negative":"extra people');
      expect(contract).not.toContain('negative 是本画面专用');
      expect(contract).toContain('本次不生成动态负面提示词');
    } finally { settings.defaultBackend = backend; Object.assign(preset, saved); }
  });
});
