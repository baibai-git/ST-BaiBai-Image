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
import { buildWorldInfoSystem, fetchWorldInfo } from './context';

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
  it('DSH 仅保护最终激活且未排除的世界书，普通 API 无控制标记', async()=>{
    mocks.settings.worldBooks={enabled:true,names:['Dedicated','Excluded']};
    mocks.settings.excludes.excludedWorldNames=['Excluded'];
    const active=await fetchWorldInfo(chat,[0],'User','Alice');
    const wrapped=buildWorldInfoSystem(active,true);
    expect(wrapped).toMatch(/^<<<STB-KEEP>>>\n【世界设定与场景描写参考/);
    expect(wrapped).toMatch(/\nOcean\n<<<STB-\/KEEP>>>$/);
    expect(wrapped).not.toContain('Filtered');
    expect(buildWorldInfoSystem(active)).not.toContain('<<<STB-');
  });
  it('已有保护符号归一化为一对外层标记，跨段正文保持完整',()=>{
    const wrapped=buildWorldInfoSystem('<<<STB-KEEP>>>\nFIRST_ENTRY\n<<<STB-/KEEP>>>\n\nLAST_ENTRY',true);
    expect(wrapped.match(/<<<STB-KEEP>>>/g)).toHaveLength(1);
    expect(wrapped.match(/<<<STB-\/KEEP>>>/g)).toHaveLength(1);
    expect(wrapped).toContain('FIRST_ENTRY');expect(wrapped).toContain('LAST_ENTRY');
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
  it('已激活的画风开关有明确标识，普通画风资料不被提升为开关', async () => {
    mocks.standard.mockResolvedValue({ allActivatedEntries: new Set([
      { world: 'Style', comment: '004 · 画风-真人（开关） 🔵', content: 'Photographic portrait.' },
      { world: 'Reference', comment: '画风-材质参考', content: 'Material reference.' },
    ]) });
    const text = await fetchWorldInfo(chat, [0], 'User', 'Alice');
    expect(text).toContain('【本轮已激活画风开关：004 · 画风-真人（开关） 🔵】\nPhotographic portrait.');
    expect(text).not.toContain('【本轮已激活画风开关：画风-材质参考');
    const message = buildWorldInfoSystem(text);
    expect(message).toContain('已激活画风开关替换默认媒介');
    expect(message).toContain('不在宿主 JSON 外追加文本');
  });
  it('多开画风明确报错，排除或空内容的条目不制造冲突', async () => {
    const entries = [
      { world: 'Photo', comment: '画风-真人（开关）', content: 'Photographic portrait.' },
      { world: 'Anime', comment: '画风-动漫（开关）', content: 'Anime illustration.' },
      { world: 'Empty', comment: '画风-3D（开关）', content: '  ' },
    ];
    mocks.standard.mockResolvedValue({ allActivatedEntries: new Set(entries) });
    await expect(fetchWorldInfo(chat, [0], 'User', 'Alice')).rejects.toThrow('多个画风开关同时激活');
    mocks.settings.excludes.excludedWorldNames = ['Anime'];
    const text = await fetchWorldInfo(chat, [0], 'User', 'Alice');
    expect(text).toContain('Photographic portrait.');
    expect(text).not.toContain('Anime illustration.');
    expect(text).not.toContain('画风-3D');
  });
});
