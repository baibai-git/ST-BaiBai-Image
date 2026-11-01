import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  standard: vi.fn(), dedicated: vi.fn(), available: true,
  settings: {
    worldBooks: { enabled: false, names: [] as string[] },
    excludes: { excludedWorldNames: [] as string[], excludedWorldInfoPatterns: [], customStripTags: [] },
  },
}));
vi.mock('@/state/settings', () => ({ settings: mocks.settings }));
vi.mock('@/st/context', () => ({
  getContext: () => ({ substituteParams: (s: string) => s }),
  getCheckWorldInfo: async () => mocks.standard,
  getCheckWorldInfoForBooks: async () => mocks.available ? mocks.dedicated : null,
  getEjsTemplate: () => null,
}));
import { fetchWorldInfo } from './context';

const chat = [{ name: 'Alice', is_user: false, is_system: false, mes: 'A lighthouse.' }];
const activated = () => ({ allActivatedEntries: new Map([
  ['dedicated.1', { world: 'Dedicated', content: 'Ocean', uid: 1 }],
  ['excluded.2', { world: 'Excluded', content: 'Filtered', uid: 2 }],
]) });

describe('专用书单请求隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.available = true;
    mocks.settings.worldBooks = { enabled: false, names: [] };
    mocks.settings.excludes.excludedWorldNames = [];
    mocks.standard.mockResolvedValue(activated());
    mocks.dedicated.mockResolvedValue(activated());
  });
  it('未启用保持原来的酒馆扫描路径', async () => {
    await fetchWorldInfo(chat, [0], 'User', 'Alice');
    expect(mocks.standard).toHaveBeenCalledOnce();
    expect(mocks.dedicated).not.toHaveBeenCalled();
  });
  it('启用后仅把独立书单交给原生扫描器，保留排除规则', async () => {
    mocks.settings.worldBooks = { enabled: true, names: ['Dedicated', 'Excluded'] };
    mocks.settings.excludes.excludedWorldNames = ['Excluded'];
    expect(await fetchWorldInfo(chat, [0], 'User', 'Alice')).toBe('Ocean');
    expect(mocks.standard).not.toHaveBeenCalled();
    expect(mocks.dedicated).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), true, ['Dedicated', 'Excluded']);
    expect(mocks.dedicated.mock.calls[0][3]).not.toBe(mocks.settings.worldBooks.names);
  });
  it('空专用书单不借用酒馆书单', async () => {
    mocks.settings.worldBooks.enabled = true;
    expect(await fetchWorldInfo(chat, [0], 'User', 'Alice')).toBe('');
    expect(mocks.standard).not.toHaveBeenCalled();
    expect(mocks.dedicated).not.toHaveBeenCalled();
  });
  it('宿主接口缺失或扫描失败时明确失败，不串用酒馆书单', async () => {
    mocks.settings.worldBooks = { enabled: true, names: ['Dedicated'] };
    mocks.available = false;
    await expect(fetchWorldInfo(chat, [0], 'User', 'Alice')).rejects.toThrow('专用世界书扫描接口不可用');
    mocks.available = true;
    mocks.dedicated.mockRejectedValueOnce(new Error('load failed'));
    await expect(fetchWorldInfo(chat, [0], 'User', 'Alice')).rejects.toThrow('load failed');
    expect(mocks.standard).not.toHaveBeenCalled();
  });
});
