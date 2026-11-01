import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ComfyUI 单套工作流 → 工作流库的存量迁移。
 *
 * 两个关键点:
 * 1. 老配置的 workflow / naturalLanguage / 横竖尺寸不搬进第一条预设的话,升级后
 *    用户配好的工作流会凭空消失(面板变空白、出图直接失败)。
 * 2. workflows 恒非空是全局不变式:面板与出图门槛都直接取 workflows[0] 兜底,
 *    库为空会一路 undefined 炸开。脏数据也必须被兜住。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithComfy(comfyui: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: comfyui === undefined ? {} : { comfyui } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('ComfyUI 工作流库迁移', () => {
  it('取图默认使用 JPG', async () => {
    const jpeg = await hydrateWithComfy({});
    expect(jpeg.comfyui.imageFormat).toBe('jpeg');
  });
  it('可显式选择原始格式', async () => {
    const original = await hydrateWithComfy({ imageFormat: 'original' });
    expect(original.comfyui.imageFormat).toBe('original');
  });
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老单套配置折成一条预设,JSON/开关/横竖尺寸原样搬入并成为当前项', async () => {
    const settings = await hydrateWithComfy({
      url: 'http://127.0.0.1:8188',
      workflow: '{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}',
      naturalLanguage: true,
      portraitSize: '1024×1536',
      landscapeSize: '1536×1024',
    });

    expect(settings.comfyui.workflows).toHaveLength(1);
    const [preset] = settings.comfyui.workflows;
    expect(preset.name).toBe('默认工作流');
    expect(preset.workflow).toBe('{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}');
    expect(preset.naturalLanguage).toBe(true);
    expect(preset.portraitSize).toBe('1024×1536');
    expect(preset.landscapeSize).toBe('1536×1024');
    // 当前项指向它,否则升级后面板显示空白
    expect(settings.comfyui.activeWorkflowId).toBe(preset.id);
    // url 仍是渠道级,不下沉进预设
    expect(settings.comfyui.url).toBe('http://127.0.0.1:8188');
  });

  it('从未配过(comfyui 键缺失)→ 也给一条空预设,不抛错', async () => {
    const settings = await hydrateWithComfy(undefined);
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].workflow).toBe('');
    expect(settings.comfyui.activeWorkflowId).toBe(settings.comfyui.workflows[0].id);
  });

  it('老配置 workflow 是空串 → 仍建这一条(那正是用户面对的空槽位,不是垃圾数据)', async () => {
    const settings = await hydrateWithComfy({ workflow: '', naturalLanguage: false });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].workflow).toBe('');
  });

  it('新格式数据原样保留,不会被再折一次(迁移幂等)', async () => {
    const settings = await hydrateWithComfy({
      workflows: [
        { id: 'wf_a', name: 'Illustrious', workflow: '{"1":{}}', naturalLanguage: false, portraitSize: '832×1216', landscapeSize: '1216×832' },
        { id: 'wf_b', name: 'Flux', workflow: '{"2":{}}', naturalLanguage: true, portraitSize: '1024×1024', landscapeSize: '1024×1024' },
      ],
      activeWorkflowId: 'wf_b',
    });

    expect(settings.comfyui.workflows.map(w => w.id)).toEqual(['wf_a', 'wf_b']);
    expect(settings.comfyui.workflows.map(w => w.name)).toEqual(['Illustrious', 'Flux']);
    expect(settings.comfyui.activeWorkflowId).toBe('wf_b');
  });

  it('当前项指向已删条目 → 回落第一条(悬空 id 会让面板空白、出图取不到工作流)', async () => {
    const settings = await hydrateWithComfy({
      workflows: [{ id: 'wf_a', name: 'A', workflow: '{"1":{}}' }],
      activeWorkflowId: 'wf_gone',
    });
    expect(settings.comfyui.activeWorkflowId).toBe('wf_a');
  });

  it('workflows 是空数组 → 补一条,保住恒非空不变式', async () => {
    const settings = await hydrateWithComfy({ workflows: [], activeWorkflowId: '' });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.activeWorkflowId).toBe(settings.comfyui.workflows[0].id);
  });

  it('条目缺字段/含脏数据 → 逐项补齐,不变式仍成立', async () => {
    const settings = await hydrateWithComfy({
      workflows: [{ name: 'no id' }, null, { id: 'wf_c', workflow: 42, portraitSize: '   ' }],
      activeWorkflowId: 'wf_c',
    });

    expect(settings.comfyui.workflows).toHaveLength(3);
    const [first, second, third] = settings.comfyui.workflows;
    // 缺 id 的补一个,缺名字的给默认名
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('默认工作流');
    // 非字符串的 workflow 归空串;空白尺寸回默认值(不能留空,否则 %width% 拿不到值)
    expect(third.workflow).toBe('');
    expect(third.portraitSize).toBe('832×1216');
    expect(settings.comfyui.activeWorkflowId).toBe('wf_c');
  });

  it('activeComfyPreset / effectiveComfyConn 取的是当前项', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          comfyui: {
            url: 'http://example:8188',
            workflows: [
              { id: 'wf_a', name: 'A', workflow: '{"1":{}}', portraitSize: '832×1216', landscapeSize: '1216×832' },
              { id: 'wf_b', name: 'B', workflow: '{"2":{}}', portraitSize: '1024×1024', landscapeSize: '1024×1024' },
            ],
            activeWorkflowId: 'wf_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeComfyPreset, effectiveComfyConn } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeComfyPreset().name).toBe('B');
    const { simpleDefaults } = await import('@/backends/comfyTemplates');
    expect(effectiveComfyConn()).toEqual({
      url: 'http://example:8188',
      imageFormat: 'jpeg',
      workflow: '{"2":{}}',
      // 存量预设没有 mode/simple 字段 → custom + 简易模式默认值
      mode: 'custom',
      simple: simpleDefaults(),
      portraitSize: '1024×1024',
      landscapeSize: '1024×1024',
    });
  });
});


it('AI负面词按工作流保存，旧数据默认关闭，显式开关跨加载保留', async () => {
  vi.resetModules();
  vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  const state = await hydrateWithComfy({ workflows: [
    { id: 'old', name: '旧工作流' }, { id: 'on', name: '开启', generateNegative: true }, { id: 'off', name: '关闭', generateNegative: false },
  ], activeWorkflowId: 'on' });
  expect(state.comfyui.workflows.map(p => p.generateNegative)).toEqual([false, true, false]);
  const { newComfyWorkflow } = await import('@/state/settings');
  expect(newComfyWorkflow().generateNegative).toBe(false);
});
