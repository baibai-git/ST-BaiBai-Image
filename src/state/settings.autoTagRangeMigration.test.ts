import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 单楼图片数量由单一 maxImages 升级为 minImages～maxImages。
 * 存量用户不能因为升级被突然强制每楼出图，因此缺少 minImages 必须迁移为 0；
 * 脏范围也要在 hydrate 时归一，避免提示词与解析器收到 min > max。
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithAutoTag(autoTag: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: autoTag === undefined ? {} : { autoTag } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings.autoTag;
}

describe('自动 tag 图片数量范围迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('旧配置只有 maxImages 时补 minImages=0,保留允许无图的行为', async () => {
    const autoTag = await hydrateWithAutoTag({ maxImages: 5 });
    expect(autoTag.minImages).toBe(0);
    expect(autoTag.maxImages).toBe(5);
  });

  it('新装默认范围为 0～2', async () => {
    const autoTag = await hydrateWithAutoTag(undefined);
    expect(autoTag.minImages).toBe(0);
    expect(autoTag.maxImages).toBe(2);
    expect(autoTag.dshSession).toBe(false);
  });

  it('DSH 只有明确启用才生效，保留已保存的开关', async () => {
    expect((await hydrateWithAutoTag({dshSession:true})).dshSession).toBe(true);
    vi.resetModules();
    expect((await hydrateWithAutoTag({dshSession:'true'})).dshSession).toBe(false);
  });

  it('专属开关默认关闭，显式启用和不含密钥的绑定可在重新载入后保留',async()=>{
    const state={instanceId:'12345678-1234-1234-1234-123456789abc',bindings:{route:{session_id:'session-dedicated',initialized:true,rulesHash:'hash'}}};
    const autoTag=await hydrateWithAutoTag({dshSession:true,dshDedicated:true,dshDedicatedState:state});
    expect(autoTag.dshDedicated).toBe(true);expect(autoTag.dshDedicatedState).toEqual(state);
    vi.resetModules();expect((await hydrateWithAutoTag(undefined)).dshDedicated).toBe(false);
    vi.resetModules();expect((await hydrateWithAutoTag({dshDedicated:'true',dshDedicatedState:{instanceId:'invalid'}})).dshDedicatedState).toBeUndefined();
  });

  it('把下限夹进 0～上限,并保证上限至少为 1', async () => {
    const tooHigh = await hydrateWithAutoTag({ minImages: 9, maxImages: 3 });
    expect(tooHigh.minImages).toBe(3);
    expect(tooHigh.maxImages).toBe(3);

    vi.resetModules();
    const negative = await hydrateWithAutoTag({ minImages: -4, maxImages: 0 });
    expect(negative.minImages).toBe(0);
    expect(negative.maxImages).toBe(1);
  });
});
