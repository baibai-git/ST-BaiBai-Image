import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ComfyUI 拆成三个库(服务器 / 提示词 / 出图方案)后的存量迁移与引用修复。
 *
 * 关键点:
 * 1. 老的渠道级 url 必须折成第一台服务器,否则升级后出图地址凭空变成默认值;
 * 2. 设置页里改过的 ComfyUI 规范/思维链必须折成一套用户提示词并被全部方案引用——
 *    丢了就是用户精调过的提示词悄悄换回内置;
 * 3. promptSets 字段**存在但为空**是合法状态,不能当「没迁移过」再迁一次;
 * 4. 悬空/错配的引用要修,不能留一个不生效的 id(暗格)。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

/** 内置 id 字面量:模块每条用例重新导入,写在顶层拿不到它;下方用例会对照真值断言。 */
const BUILTIN_COMFY_ILLUST_ID_LITERAL = 'builtin_illust';

async function hydrate(stored: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: stored },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

describe('ComfyUI 三库迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老渠道级 url 折成第一台服务器,方案引用它', async () => {
    const { settings, activeComfyServer } = await hydrate({
      comfyui: { url: 'http://10.0.0.5:8188', workflow: '{"1":{}}' },
    });
    expect(settings.comfyui.servers).toHaveLength(1);
    expect(settings.comfyui.servers[0].url).toBe('http://10.0.0.5:8188');
    expect(settings.comfyui.workflows[0].serverId).toBe(settings.comfyui.servers[0].id);
    expect(activeComfyServer().url).toBe('http://10.0.0.5:8188');
  });

  it('从未配过 → 一台默认本机服务器', async () => {
    const { settings } = await hydrate({});
    expect(settings.comfyui.servers).toHaveLength(1);
    expect(settings.comfyui.servers[0].url).toBe('http://127.0.0.1:8188');
  });

  it('改过的规范/思维链折成一套用户提示词,全部方案引用它;没改过的那格留空回落内置', async () => {
    const { settings, activeComfyPromptSet } = await hydrate({
      comfyui: {
        workflows: [
          { id: 'wf_a', name: 'A', workflow: '' },
          { id: 'wf_b', name: 'B', workflow: '' },
        ],
        activeWorkflowId: 'wf_a',
      },
      autoTag: { prompts: { comfySpec: 'MY-SPEC', comfyThinking: '' } },
    });
    expect(settings.comfyui.promptSets).toHaveLength(1);
    const [set] = settings.comfyui.promptSets;
    expect(set).toMatchObject({ kind: 'illustration', spec: 'MY-SPEC', thinking: '' });
    expect(settings.comfyui.workflows.map(w => w.promptSetId)).toEqual([set.id, set.id]);
    expect(activeComfyPromptSet().id).toBe(set.id);
  });

  it('更老的单份 thinking 也会被折进来', async () => {
    const { settings } = await hydrate({
      autoTag: { prompts: { thinking: 'OLD-THINK' } },
    });
    expect(settings.comfyui.promptSets).toHaveLength(1);
    expect(settings.comfyui.promptSets[0].thinking).toBe('OLD-THINK');
  });

  it('两格都没改过 → 不建用户提示词,方案直接引用内置', async () => {
    const { settings, BUILTIN_COMFY_ILLUST_ID } = await hydrate({ comfyui: { workflow: '' } });
    expect(settings.comfyui.promptSets).toEqual([]);
    expect(settings.comfyui.workflows[0].promptSetId).toBe(BUILTIN_COMFY_ILLUST_ID);
  });

  it('promptSets 已存在(哪怕为空)就不再迁移,旧格子的内容不会被重复折进来', async () => {
    const { settings } = await hydrate({
      comfyui: { promptSets: [], workflows: [{ id: 'wf_a', name: 'A' }] },
      autoTag: { prompts: { comfySpec: 'STALE' } },
    });
    expect(settings.comfyui.promptSets).toEqual([]);
  });

  it('悬空服务器回落第一台;提示词悬空或类型不符回落同类型内置', async () => {
    const { settings, BUILTIN_COMFY_COMIC_ID, BUILTIN_COMFY_ILLUST_ID } = await hydrate({
      comfyui: {
        servers: [{ id: 'srv_1', name: '本机', url: 'http://127.0.0.1:8188' }],
        promptSets: [{ id: 'ps_illust', name: '我的', kind: 'illustration', spec: '', thinking: '' }],
        workflows: [
          { id: 'wf_a', name: 'A', kind: 'illustration', serverId: 'srv_gone', promptSetId: 'ps_gone' },
          // 漫画方案引用了插画提示词:错配
          { id: 'wf_b', name: 'B', kind: 'comic', serverId: 'srv_1', promptSetId: 'ps_illust' },
          { id: 'wf_c', name: 'C', kind: 'illustration', serverId: 'srv_1', promptSetId: 'ps_illust' },
        ],
      },
    });
    const [a, b, c] = settings.comfyui.workflows;
    expect(a.serverId).toBe('srv_1');
    expect(a.promptSetId).toBe(BUILTIN_COMFY_ILLUST_ID);
    expect(b.promptSetId).toBe(BUILTIN_COMFY_COMIC_ID);
    expect(c.promptSetId).toBe('ps_illust');
  });

  it('用户条目占了内置 id 会被换 id,内置那份不被顶掉', async () => {
    const { settings, BUILTIN_COMFY_ILLUST_ID } = await hydrate({
      comfyui: {
        promptSets: [{ id: BUILTIN_COMFY_ILLUST_ID_LITERAL, name: '冒名', kind: 'illustration', spec: 'X', thinking: '' }],
      },
    });
    expect(settings.comfyui.promptSets[0].id).not.toBe(BUILTIN_COMFY_ILLUST_ID);
  });

  it('服务器库被脏数据清空 → 仍补一台', async () => {
    const { settings } = await hydrate({ comfyui: { servers: [], url: 'http://x:1' } });
    expect(settings.comfyui.servers).toHaveLength(1);
    expect(settings.comfyui.servers[0].url).toBe('http://x:1');
  });
});
