import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.3.1 新增的三项设置:画幅锁(NAI 渠道级一份、ComfyUI 每套工作流各一份)、
 * NAI「生成自然语言」、楼层图片显示大小。
 *
 * 看点:
 * 1. 老配置缺字段一律落默认,不做迁移。画幅锁默认「自动」、NAI 自然语言默认开,都等于升级前的行为;
 *    显示大小默认「中」是刻意的——升级前的「铺满楼层宽度」正是要修的问题,想要回去在下拉里选。
 * 2. 画幅锁的判据只此一处(activeOrientationLock),按当前后端取对应那份,两份互不串。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWith(stored: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: stored },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
});

describe('画幅锁 / NAI 自然语言 / 显示大小 · 读取兜底', () => {
  it('老配置缺这些字段 → 不锁方向、NAI 照写自然语言、显示大小「中」', async () => {
    const { settings } = await hydrateWith({
      nai: { model: 'nai-diffusion-4-5-full' },
      comfyui: { workflows: [{ id: 'wf_a', name: 'A', workflow: '' }], activeWorkflowId: 'wf_a' },
      ui: { theme: 'st' },
    });
    expect(settings.nai.plans[0].orientationLock).toBe('auto');
    expect(settings.nai.plans[0].naturalLanguage).toBe(true);
    expect(settings.comfyui.workflows[0].orientationLock).toBe('auto');
    expect(settings.ui.imageDisplaySize).toBe('medium');
  });

  it('合法值原样保留,各套工作流的锁各管各的', async () => {
    const { settings } = await hydrateWith({
      nai: { naturalLanguage: false, orientationLock: 'landscape' },
      comfyui: {
        workflows: [
          { id: 'wf_a', name: 'A', workflow: '', orientationLock: 'portrait' },
          { id: 'wf_b', name: 'B', workflow: '', orientationLock: 'landscape' },
          { id: 'wf_c', name: 'C', workflow: '' },
        ],
        activeWorkflowId: 'wf_a',
      },
      ui: { imageDisplaySize: 'full' },
    });
    expect(settings.nai.plans[0].naturalLanguage).toBe(false);
    expect(settings.nai.plans[0].orientationLock).toBe('landscape');
    expect(settings.comfyui.workflows.map(w => w.orientationLock)).toEqual([
      'portrait',
      'landscape',
      'auto',
    ]);
    expect(settings.ui.imageDisplaySize).toBe('full');
  });

  it('脏值 → 各自回落默认,不抛错', async () => {
    const { settings } = await hydrateWith({
      nai: { naturalLanguage: 'no', orientationLock: 'sideways' },
      comfyui: {
        workflows: [{ id: 'wf_a', name: 'A', workflow: '', orientationLock: 1 }],
        activeWorkflowId: 'wf_a',
      },
      ui: { imageDisplaySize: 'huge' },
    });
    expect(settings.nai.plans[0].naturalLanguage).toBe(true);
    expect(settings.nai.plans[0].orientationLock).toBe('auto');
    expect(settings.comfyui.workflows[0].orientationLock).toBe('auto');
    expect(settings.ui.imageDisplaySize).toBe('medium');
  });

  it('更老的单套 ComfyUI 配置折成预设时,同样不锁方向', async () => {
    const { settings } = await hydrateWith({ comfyui: { workflow: '{}', naturalLanguage: true } });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].orientationLock).toBe('auto');
  });

  it('新建的工作流预设默认不锁', async () => {
    const { newComfyWorkflow } = await import('@/state/settings');
    expect(newComfyWorkflow().orientationLock).toBe('auto');
  });
});

describe('activeOrientationLock:按当前后端取对应那份', () => {
  it('NAI 取当前方案,ComfyUI 取当前工作流;切工作流即切走锁', async () => {
    const { settings, activeOrientationLock } = await hydrateWith({
      defaultBackend: 'nai',
      nai: { orientationLock: 'portrait' },
      comfyui: {
        workflows: [
          { id: 'wf_a', name: 'A', workflow: '', orientationLock: 'landscape' },
          { id: 'wf_b', name: 'B', workflow: '' },
        ],
        activeWorkflowId: 'wf_a',
      },
    });
    expect(activeOrientationLock()).toBe('portrait');

    settings.defaultBackend = 'comfyui';
    expect(activeOrientationLock()).toBe('landscape');

    settings.comfyui.activeWorkflowId = 'wf_b';
    expect(activeOrientationLock()).toBe('auto');
  });
});

describe('imageDisplayMaxHeight', () => {
  it('小/中/大按高度封顶 400/600/800,铺满不封顶', async () => {
    const { imageDisplayMaxHeight } = await import('@/state/settings');
    expect(imageDisplayMaxHeight('small')).toBe(400);
    expect(imageDisplayMaxHeight('medium')).toBe(600);
    expect(imageDisplayMaxHeight('large')).toBe(800);
    expect(imageDisplayMaxHeight('full')).toBeNull();
  });
});
